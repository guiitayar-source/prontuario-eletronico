// Lote 6F.2D (A1): busca de LCR/OCSP na rede. Sem rede real: servidor HTTP local em 127.0.0.1
// e resolvedor de DNS injetado. LCR/OCSP sintéticos assinados de verdade (fixtures 6F.2C).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

import {
  ICP_BRASIL_ROOTS,
  ICP_BRASIL_INTERMEDIATES,
} from '../lib/signature/icp-brasil-certs.ts';
import {
  RevocationEvidenceCache,
  checkRevocationUrl,
  createNodeRevocationTransport,
  createOnlineRevocationProvider,
  defaultRevocationFetchPolicy,
  isPublicAddress,
  revocationUrlsForCertificate,
} from '../lib/signature/revocation-fetch.ts';
import { OID_KP_TIME_STAMPING } from '../lib/signature/rfc3161-timestamp.ts';
import {
  padesService,
  createSampleUnsignedPdf,
  createSyntheticCertificate,
  generateRsaKeyPair,
  buildBasicConstraintsExtension,
  buildKeyUsageExtension,
  buildExtendedKeyUsageExtension,
  buildIcpBrasilSanExtension,
  signPdfWithOptionalTimestamp,
  createRfc3161TimestampToken,
  createSyntheticCrl,
  createSyntheticOcspResponse,
} from './helpers/pades-revocation-fixtures.mjs';

const T = (s) => new Date(s);
const VERIFY_AT = T('2026-06-01T12:00:00Z');
const POE = T('2026-05-20T10:00:00Z');
const policy = defaultRevocationFetchPolicy({});

// ---------------------------------------------------------------------------------------------
// Servidor HTTP local: rotas por "host + caminho"; conta as requisições recebidas.

const routes = new Map();
const hits = [];
let server;
let port;

const route = (host, path, handler) => routes.set(`${host}${path}`, handler);
const body = (contentType, buf) => (req, res) => {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
  });
  res.end(buf);
};
const hitsFor = (host) => hits.filter((h) => h.startsWith(host));

before(async () => {
  server = http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    const key = `${host}${req.url}`;
    hits.push(key);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      const handler = routes.get(key);
      if (!handler) {
        res.writeHead(404);
        res.end();
        return;
      }
      handler(req, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => {
  server.closeAllConnections?.();
  server.close();
});

// Resolvedor de teste: *.ac.test e *.fora.test vão para o servidor local.
const localResolver = async () => [{ address: '127.0.0.1', family: 4 }];
const testPolicy = () => ({
  allowedHostSuffixes: ['ac.test'],
  allowedPorts: [port],
  requestTimeoutMs: 1500,
  collectTimeoutMs: 4000,
});
const localTransport = () =>
  createNodeRevocationTransport({
    resolve: localResolver,
    isAddressAllowed: () => true, // só o servidor de teste; o bloqueio real é testado à parte
  });
const testProvider = (extra = {}) =>
  createOnlineRevocationProvider({
    transport: localTransport(),
    policy: testPolicy(),
    allowNonIcpBrasilAnchor: true,
    cache: new RevocationEvidenceCache(),
    ...extra,
  });

// ---------------------------------------------------------------------------------------------
// PKI sintética com CDP/AIA apontando para o servidor local.

const cdp = (url) =>
  new pkijs.Extension({
    extnID: '2.5.29.31',
    critical: false,
    extnValue: new pkijs.CRLDistributionPoints({
      distributionPoints: [
        new pkijs.DistributionPoint({
          distributionPoint: [new pkijs.GeneralName({ type: 6, value: url })],
        }),
      ],
    })
      .toSchema()
      .toBER(false),
  });
const aiaOcsp = (url) =>
  new pkijs.Extension({
    extnID: '1.3.6.1.5.5.7.1.1',
    critical: false,
    extnValue: new pkijs.InfoAccess({
      accessDescriptions: [
        new pkijs.AccessDescription({
          accessMethod: '1.3.6.1.5.5.7.48.1',
          accessLocation: new pkijs.GeneralName({ type: 6, value: url }),
        }),
      ],
    })
      .toSchema()
      .toBER(false),
  });

let pkiPromise;
function pki() {
  pkiPromise ??= (async () => {
    const u = (host, path) => `http://${host}:${port}${path}`;
    const [rootK, interK, signerK, ocspSignerK, tsaRootK, tsaInterK, tsaK] =
      await Promise.all(Array.from({ length: 7 }, generateRsaKeyPair));
    const ca = (cn, serial, issuer, keys, signKey, extensions = []) =>
      createSyntheticCertificate({
        serialNumber: serial,
        subjectCn: cn,
        issuerCert: issuer?.cert ?? null,
        subjectKeyPair: keys,
        signingPrivateKey: signKey ?? null,
        notBefore: T('2020-01-01T00:00:00Z'),
        notAfter: T('2035-01-01T00:00:00Z'),
        extensions: [
          buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 1 }),
          buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
          ...extensions,
        ],
      });
    const root = await ca('AC Raiz Sintetica 6F2D', 1, null, rootK);
    const inter = await ca(
      'AC Intermediaria 6F2D',
      2,
      root,
      interK,
      rootK.privateKey,
      [cdp(u('lcr.ac.test', '/raiz.crl'))],
    );
    const signer = await createSyntheticCertificate({
      serialNumber: 3,
      subjectCn: 'MEDICO SINTETICO:11144477735',
      issuerCert: inter.cert,
      subjectKeyPair: signerK,
      signingPrivateKey: interK.privateKey,
      notBefore: T('2025-01-01T00:00:00Z'),
      notAfter: T('2028-01-01T00:00:00Z'),
      extensions: [
        buildBasicConstraintsExtension({ cA: false, critical: false }),
        buildKeyUsageExtension({
          digitalSignature: true,
          nonRepudiation: true,
        }),
        buildIcpBrasilSanExtension('11144477735'),
        cdp(u('lcr.ac.test', '/inter.crl')),
        aiaOcsp(u('ocsp.ac.test', '/')),
      ],
    });
    // Certificado só para assinar respostas forjadas (mesmo nome da AC, outra chave).
    const forger = await ca(
      'AC Intermediaria 6F2D',
      2,
      root,
      ocspSignerK,
      rootK.privateKey,
    );
    forger.keyPair = ocspSignerK;

    const tsaRoot = await ca('AC Raiz Tempo 6F2D', 10, null, tsaRootK);
    const tsaInter = await ca(
      'AC Tempo 6F2D',
      11,
      tsaRoot,
      tsaInterK,
      tsaRootK.privateKey,
      [cdp(u('lcr.ac.test', '/tsaraiz.crl'))],
    );
    const tsa = await createSyntheticCertificate({
      serialNumber: 12,
      subjectCn: 'ACT SINTETICA 6F2D',
      issuerCert: tsaInter.cert,
      subjectKeyPair: tsaK,
      signingPrivateKey: tsaInterK.privateKey,
      notBefore: T('2024-01-01T00:00:00Z'),
      notAfter: T('2030-01-01T00:00:00Z'),
      extensions: [
        buildBasicConstraintsExtension({ cA: false, critical: false }),
        buildKeyUsageExtension({
          digitalSignature: true,
          nonRepudiation: true,
        }),
        buildExtendedKeyUsageExtension([OID_KP_TIME_STAMPING], true),
        cdp(u('lcr.ac.test', '/tsainter.crl')),
      ],
    });

    const sign = (opts = {}) =>
      signPdfWithOptionalTimestamp({
        unsignedPdfBuffer: opts.pdf,
        signerCert: signer.cert,
        signerPrivateKey: signerK.privateKey,
        cmsCertificates: [signer.cert, inter.cert],
        claimedSigningTime: T('2026-05-20T09:59:50Z'),
        ...opts,
      }).then((r) => r.signedPdf);
    const unsigned = await createSampleUnsignedPdf('Documento sintetico 6F.2D');
    const pdf = await sign({ pdf: unsigned });
    const pdfTs = await sign({
      pdf: unsigned,
      buildTimestampToken: (sig) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sig,
          genTime: POE,
          tsaCert: tsa.cert,
          tsaPrivateKey: tsaK.privateKey,
          tsaCertificates: [tsa.cert, tsaInter.cert],
        }),
    });
    return { root, inter, signer, forger, tsaRoot, tsaInter, tsa, pdf, pdfTs };
  })();
  return pkiPromise;
}

const crlOf = (
  issuer,
  revokedList = [],
  thisUpdate = '2026-05-31T00:00:00Z',
  nextUpdate = '2026-06-07T00:00:00Z',
) =>
  createSyntheticCrl({
    issuerCert: issuer.cert,
    issuerPrivateKey: issuer.keyPair.privateKey,
    thisUpdate: T(thisUpdate),
    nextUpdate: T(nextUpdate),
    revokedList,
  });

async function serveGoodChain({ withOcsp = false } = {}) {
  const p = await pki();
  routes.clear();
  route(
    'lcr.ac.test',
    '/inter.crl',
    body('application/pkix-crl', await crlOf(p.inter)),
  );
  route(
    'lcr.ac.test',
    '/raiz.crl',
    body('application/pkix-crl', await crlOf(p.root)),
  );
  if (withOcsp)
    route(
      'ocsp.ac.test',
      '/',
      body(
        'application/ocsp-response',
        await createSyntheticOcspResponse({
          targetCert: p.signer.cert,
          issuerCert: p.inter.cert,
          responderCert: p.inter.cert,
          responderPrivateKey: p.inter.keyPair.privateKey,
          producedAt: T('2026-06-01T11:00:00Z'),
          thisUpdate: T('2026-06-01T11:00:00Z'),
          nextUpdate: T('2026-06-02T11:00:00Z'),
        }),
      ),
    );
  return p;
}

const verify = async (pdf, provider, extra = {}) => {
  const p = await pki();
  return padesService.verifyPadesSignature(pdf, {
    trustedRootPems: [p.root.pem],
    trustedTsaRootPems: [p.tsaRoot.pem],
    verificationTime: VERIFY_AT,
    revocationEvidenceProvider: provider,
    ...extra,
  });
};
const signerResult = (r) =>
  r.revocation.certificateResults?.find((c) => c.role === 'SIGNER');

// ---------------------------------------------------------------------------------------------

describe('6F.2D — política de URL', () => {
  const ok = (u) => checkRevocationUrl(u, policy).ok;
  it('aceita qualquer host público de CDP/AIA (inclusive fora da antiga lista de 16 domínios)', () => {
    assert.ok(ok('http://acraiz.icpbrasil.gov.br/LCRacraizv10.crl'));
    assert.ok(ok('https://ccd.acsoluti.com.br/lcr/ac-soluti-v5.crl'));
    assert.ok(ok('http://repositorio.serpro.gov.br:80/lcr/acserprov5.crl'));
    assert.ok(ok('http://ICP-BRASIL.CERTISIGN.COM.BR./x.crl'));
    assert.ok(ok('http://lcr.uma-ac-nova.com.br/ac-final.crl'));
    assert.ok(ok('http://ocsp.example.org/'));
  });
  it('recusa esquema, credenciais, porta, IP literal e nome interno', () => {
    for (const u of [
      'ftp://acraiz.icpbrasil.gov.br/x.crl',
      'file:///etc/passwd',
      'ldap://acraiz.icpbrasil.gov.br/cn=x',
      'http://user:pass@acraiz.icpbrasil.gov.br/x.crl',
      'http://acraiz.icpbrasil.gov.br:8080/x.crl',
      'https://acraiz.icpbrasil.gov.br:22/x.crl',
      'http://127.0.0.1/x.crl',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x.crl',
      'http://[fd00:ec2::254]/x.crl',
      'http://2130706433/x.crl', // 127.0.0.1 em decimal
      'http://0x7f000001/x.crl',
      'http://localhost/x.crl',
      'http://lcr.localhost/x.crl',
      'http://metadata.google.internal/x.crl',
      'http://servidor.local/x.crl',
      'http://intranet/x.crl',
      'não é url',
    ])
      assert.equal(ok(u), false, u);
  });
  it('PSYWRITE_REVOCATION_BLOCKED_HOSTS bloqueia o domínio e seus subdomínios', () => {
    const p = defaultRevocationFetchPolicy({
      PSYWRITE_REVOCATION_BLOCKED_HOSTS: 'ac-suspeita.com.br, outra.example',
    });
    assert.equal(
      checkRevocationUrl('http://ac-suspeita.com.br/a.crl', p).ok,
      false,
    );
    assert.equal(
      checkRevocationUrl('http://lcr.ac-suspeita.com.br/a.crl', p).ok,
      false,
    );
    assert.ok(checkRevocationUrl('http://nao-ac-suspeita.com.br/a.crl', p).ok);
    assert.ok(checkRevocationUrl('http://acraiz.icpbrasil.gov.br/a.crl', p).ok);
  });
  it('os CDP/AIA dos certificados ICP-Brasil oficiais do pacote passam pela política', () => {
    const ders = [
      ...ICP_BRASIL_ROOTS.map((r) => r.der),
      ...ICP_BRASIL_INTERMEDIATES,
    ];
    let count = 0;
    for (const b64 of ders) {
      const cert = new pkijs.Certificate({
        schema: asn1js.fromBER(Buffer.from(b64, 'base64')).result,
      });
      const urls = revocationUrlsForCertificate(cert);
      for (const u of [...urls.crl, ...urls.ocsp]) {
        count += 1;
        assert.ok(checkRevocationUrl(u, policy).ok, `recusado: ${u}`);
      }
    }
    assert.ok(count > 10);
  });
});

describe('6F.2D — endereços bloqueados', () => {
  it('recusa privados, loopback, link-local, CGNAT, metadados e IPv4 mapeado', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.0.10',
      '169.254.169.254',
      '100.100.100.200',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00:ec2::254',
      'fc00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      'lixo',
    ])
      assert.equal(isPublicAddress(a), false, a);
  });
  it('aceita endereços públicos', () => {
    for (const a of [
      '8.8.8.8',
      '200.152.32.1',
      '2001:4860:4860::8888',
      '::ffff:8.8.8.8',
    ])
      assert.equal(isPublicAddress(a), true, a);
  });
});

describe('6F.2D — transporte HTTP (servidor local)', () => {
  const req = (path, extra = {}) => ({
    url: new URL(`http://lcr.ac.test:${port}${path}`),
    method: 'GET',
    accept: '*/*',
    maxBytes: 1024,
    timeoutMs: 1000,
    ...extra,
  });

  it('DNS resolvendo para IP privado: recusa sem conectar', async () => {
    routes.clear();
    route(
      'lcr.ac.test',
      '/a.crl',
      body('application/pkix-crl', Buffer.from('x')),
    );
    hits.length = 0;
    const transport = createNodeRevocationTransport({ resolve: localResolver });
    await assert.rejects(transport(req('/a.crl')), /endereço não permitido/);
    assert.equal(hits.length, 0);
  });
  it('DNS com um endereço público e um privado: recusa (anti-rebinding)', async () => {
    hits.length = 0;
    const transport = createNodeRevocationTransport({
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    await assert.rejects(transport(req('/a.crl')), /endereço não permitido/);
    assert.equal(hits.length, 0);
  });
  it('resposta grande demais (Content-Length e corpo sem tamanho)', async () => {
    routes.clear();
    route(
      'lcr.ac.test',
      '/grande',
      body('application/pkix-crl', Buffer.alloc(4096)),
    );
    route('lcr.ac.test', '/chunked', (q, res) => {
      res.writeHead(200);
      for (let i = 0; i < 8; i += 1) res.write(Buffer.alloc(512));
      res.end();
    });
    const transport = localTransport();
    await assert.rejects(transport(req('/grande')), /grande demais/);
    await assert.rejects(transport(req('/chunked')), /grande demais/);
  });
  it('tempo esgotado', async () => {
    routes.clear();
    route('lcr.ac.test', '/lento', () => {}); // nunca responde
    const started = Date.now();
    await assert.rejects(
      localTransport()(req('/lento', { timeoutMs: 200 })),
      /tempo esgotado/,
    );
    assert.ok(Date.now() - started < 1500);
  });
});

describe('6F.2D — coleta ponta a ponta na verificação PAdES', () => {
  it('LCR da cadeia buscada na rede: GOOD e emissão liberada', async () => {
    const p = await serveGoodChain();
    hits.length = 0;
    const attempts = [];
    const r = await verify(p.pdf, testProvider(), {
      validationContext: 'LIVE_ISSUANCE',
      onRevocationFetch: (a) => attempts.push(...a),
    });
    assert.equal(r.revocation.status, 'GOOD', JSON.stringify(r.revocation));
    assert.equal(signerResult(r).source, 'CRL');
    assert.equal(r.status, 'VALID');
    assert.equal(r.assessment.issuanceAllowed, true);
    assert.deepEqual(
      hitsFor('lcr.ac.test').toSorted((a, b) => a.localeCompare(b)),
      ['lcr.ac.test/inter.crl', 'lcr.ac.test/raiz.crl'],
    );
    assert.equal(attempts.filter((a) => a.outcome === 'FETCHED').length, 2);
  });

  it('sem provedor o comportamento é o de antes (REVOCATION_UNAVAILABLE)', async () => {
    const p = await serveGoodChain();
    hits.length = 0;
    const r = await verify(p.pdf, undefined, {
      validationContext: 'LIVE_ISSUANCE',
    });
    assert.equal(r.revocation.subIndication, 'REVOCATION_UNAVAILABLE');
    assert.equal(hits.length, 0);
  });

  it('OCSP do AIA tem preferência; a LCR do signatário não é baixada', async () => {
    const p = await serveGoodChain({ withOcsp: true });
    hits.length = 0;
    let ocspBody;
    const handler = routes.get('ocsp.ac.test/');
    route('ocsp.ac.test', '/', (q, res) => {
      ocspBody = q.rawBody;
      assert.equal(q.method, 'POST');
      assert.equal(q.headers['content-type'], 'application/ocsp-request');
      handler(q, res);
    });
    const r = await verify(p.pdf, testProvider(), {
      validationContext: 'LIVE_ISSUANCE',
    });
    assert.equal(signerResult(r).source, 'OCSP', JSON.stringify(r.revocation));
    assert.equal(signerResult(r).status, 'GOOD');
    assert.ok(!hits.includes('lcr.ac.test/inter.crl'));
    const parsed = new pkijs.OCSPRequest({
      schema: asn1js.fromBER(new Uint8Array(ocspBody).buffer).result,
    });
    assert.equal(
      parsed.tbsRequest.requestList[0].reqCert.serialNumber.valueBlock.valueDec,
      3,
    );
  });

  it('revogação comprovada pela LCR baixada bloqueia a emissão', async () => {
    const p = await serveGoodChain();
    route(
      'lcr.ac.test',
      '/inter.crl',
      body(
        'application/pkix-crl',
        await crlOf(p.inter, [
          {
            serialNumber: 3,
            revocationDate: T('2026-05-25T00:00:00Z'),
            reasonCode: 1,
          },
        ]),
      ),
    );
    const r = await verify(p.pdf, testProvider(), {
      validationContext: 'LIVE_ISSUANCE',
    });
    assert.equal(r.assessment.issuanceAllowed, false);
    assert.equal(r.isValid, false);
  });

  it('LCR forjada (outra chave) não vira GOOD nem INVALID; emissão segue', async () => {
    const p = await serveGoodChain();
    route(
      'lcr.ac.test',
      '/inter.crl',
      body(
        'application/pkix-crl',
        await crlOf(p.forger, [
          {
            serialNumber: 3,
            revocationDate: T('2026-05-25T00:00:00Z'),
            reasonCode: 1,
          },
        ]),
      ),
    );
    const r = await verify(p.pdf, testProvider(), {
      validationContext: 'LIVE_ISSUANCE',
    });
    assert.notEqual(r.revocation.status, 'GOOD');
    assert.notEqual(r.status, 'VALID');
    assert.notEqual(r.status, 'INVALID');
    assert.equal(r.assessment.issuanceAllowed, true);
  });

  it('OCSP com assinatura corrompida: recusado, sem GOOD; a LCR não supre o signatário', async () => {
    const p = await serveGoodChain();
    route(
      'ocsp.ac.test',
      '/',
      body(
        'application/ocsp-response',
        await createSyntheticOcspResponse({
          targetCert: p.signer.cert,
          issuerCert: p.inter.cert,
          responderCert: p.inter.cert,
          responderPrivateKey: p.inter.keyPair.privateKey,
          producedAt: T('2026-06-01T11:00:00Z'),
          thisUpdate: T('2026-06-01T11:00:00Z'),
          nextUpdate: T('2026-06-02T11:00:00Z'),
          corruptSignature: true,
        }),
      ),
    );
    const r = await verify(p.pdf, testProvider(), {
      validationContext: 'LIVE_ISSUANCE',
    });
    // O coletor só lê o envelope; quem recusa a assinatura é o revocation-validator.
    assert.notEqual(
      signerResult(r)?.status,
      'GOOD',
      JSON.stringify(r.revocation),
    );
    assert.notEqual(r.status, 'VALID');
    assert.equal(r.assessment.issuanceAllowed, true);
  });

  it('resposta que não é LCR (HTML, 500, 404) e rede caída: INDETERMINATE, emissão segue', async () => {
    const p = await pki();
    routes.clear();
    route(
      'lcr.ac.test',
      '/inter.crl',
      body('text/html', Buffer.from('<html>manutenção</html>')),
    );
    route('lcr.ac.test', '/raiz.crl', (q, res) => {
      res.writeHead(500);
      res.end();
    });
    const attempts = [];
    let r = await verify(p.pdf, testProvider(), {
      validationContext: 'LIVE_ISSUANCE',
      onRevocationFetch: (a) => attempts.push(...a),
    });
    assert.equal(r.revocation.status, 'INDETERMINATE');
    assert.equal(r.assessment.issuanceAllowed, true);
    assert.ok(attempts.some((a) => a.reason === 'LCR ilegível'));
    assert.ok(attempts.some((a) => a.reason === 'HTTP 500'));

    const down = createOnlineRevocationProvider({
      transport: async () => {
        throw new Error('ECONNREFUSED');
      },
      policy: testPolicy(),
      allowNonIcpBrasilAnchor: true,
    });
    r = await verify(p.pdf, down, { validationContext: 'LIVE_ISSUANCE' });
    assert.equal(r.revocation.subIndication, 'REVOCATION_UNAVAILABLE');
    assert.equal(r.assessment.issuanceAllowed, true);

    const throwing = {
      collect: async () => {
        throw new Error('bug');
      },
    };
    r = await verify(p.pdf, throwing, { validationContext: 'LIVE_ISSUANCE' });
    assert.equal(r.assessment.issuanceAllowed, true);
  });

  it('redirecionamento: segue dentro da lista, recusa fora dela e acima do limite', async () => {
    const p = await serveGoodChain();
    const good = routes.get('lcr.ac.test/inter.crl');
    const redirect = (to) => (q, res) => {
      res.writeHead(302, { Location: to });
      res.end();
    };
    route('lcr.ac.test', '/inter.crl', redirect('/novo/inter.crl'));
    route('lcr.ac.test', '/novo/inter.crl', good);
    hits.length = 0;
    const first = [];
    let r = await verify(p.pdf, testProvider(), {
      onRevocationFetch: (a) => first.push(...a),
    });
    assert.equal(
      signerResult(r)?.status,
      'GOOD',
      JSON.stringify({ first, rev: r.revocation, hits }),
    );

    route(
      'lcr.ac.test',
      '/inter.crl',
      redirect(`http://lcr.fora.test:${port}/inter.crl`),
    );
    route('lcr.fora.test', '/inter.crl', good);
    route(
      'lcr.ac.test',
      '/raiz.crl',
      redirect(`http://lcr.ac.test:${port}/r1`),
    );
    route('lcr.ac.test', '/r1', redirect(`http://lcr.ac.test:${port}/r2`));
    route('lcr.ac.test', '/r2', redirect(`http://lcr.ac.test:${port}/r3`));
    hits.length = 0;
    const attempts = [];
    r = await verify(p.pdf, testProvider(), {
      onRevocationFetch: (a) => attempts.push(...a),
    });
    assert.equal(hitsFor('lcr.fora.test').length, 0);
    assert.equal(r.revocation.status, 'INDETERMINATE');
    assert.ok(attempts.some((a) => /host fora da lista/.test(a.reason)));
    assert.ok(attempts.some((a) => /redirecionamentos demais/.test(a.reason)));
    assert.ok(!hits.includes('lcr.ac.test/r3'));
  });

  it('redirecionamento para IP interno (literal ou via DNS): recusado', async () => {
    const p = await serveGoodChain();
    const redirect = (to) => (q, res) => {
      res.writeHead(302, { Location: to });
      res.end();
    };
    route(
      'lcr.ac.test',
      '/inter.crl',
      redirect(`http://interno.ac.test:${port}/inter.crl`),
    );
    route(
      'lcr.ac.test',
      '/raiz.crl',
      redirect(`http://127.0.0.1:${port}/raiz.crl`),
    );
    const provider = createOnlineRevocationProvider({
      transport: createNodeRevocationTransport({
        resolve: async (host) => [
          {
            address: host === 'interno.ac.test' ? '10.0.0.5' : '127.0.0.1',
            family: 4,
          },
        ],
        // Só o servidor de teste é "público" aqui; 10.0.0.5 cai na regra real.
        isAddressAllowed: (a) => a === '127.0.0.1' || isPublicAddress(a),
      }),
      policy: testPolicy(),
      allowNonIcpBrasilAnchor: true,
    });
    hits.length = 0;
    const attempts = [];
    const r = await verify(p.pdf, provider, {
      onRevocationFetch: (a) => attempts.push(...a),
    });
    assert.ok(
      attempts.some((a) =>
        /endereço não permitido \(10\.0\.0\.5\)/.test(a.reason),
      ),
      JSON.stringify(attempts),
    );
    assert.ok(attempts.some((a) => /IP literal/.test(a.reason)));
    assert.equal(hitsFor('interno.ac.test').length, 0);
    assert.equal(r.revocation.status, 'INDETERMINATE');
  });

  it('URL vinda do PDF: cadeia não confiável nunca aciona a busca', async () => {
    const p = await serveGoodChain();
    let called = 0;
    const spy = {
      collect: async (...args) => {
        called += 1;
        return testProvider().collect(...args);
      },
    };
    hits.length = 0;
    // O PDF traz signatário e AC com CDP/AIA, mas a raiz confiável informada é outra.
    const r = await padesService.verifyPadesSignature(p.pdf, {
      trustedRootPems: [p.tsaRoot.pem],
      verificationTime: VERIFY_AT,
      revocationEvidenceProvider: spy,
    });
    assert.equal(called, 0);
    assert.equal(hits.length, 0);
    assert.equal(r.revocation.checked, false);
  });

  it('host do CDP fora da lista: nenhuma requisição', async () => {
    const p = await serveGoodChain();
    hits.length = 0;
    const provider = createOnlineRevocationProvider({
      transport: localTransport(),
      policy: { ...testPolicy(), allowedHostSuffixes: ['outra.test'] },
      allowNonIcpBrasilAnchor: true,
    });
    const r = await verify(p.pdf, provider);
    assert.equal(hits.length, 0);
    assert.equal(r.revocation.status, 'INDETERMINATE');
  });

  it('cadeia que não termina em raiz ICP-Brasil oficial: coleta recusada', async () => {
    const p = await serveGoodChain();
    hits.length = 0;
    const provider = createOnlineRevocationProvider({
      transport: localTransport(),
      policy: testPolicy(),
    });
    const attempts = [];
    await verify(p.pdf, provider, {
      onRevocationFetch: (a) => attempts.push(...a),
    });
    assert.equal(hits.length, 0);
    assert.equal(attempts[0].outcome, 'SKIPPED');
  });

  it('cache em memória até nextUpdate', async () => {
    const p = await serveGoodChain();
    const cache = new RevocationEvidenceCache();
    const provider = testProvider({ cache });
    hits.length = 0;
    await verify(p.pdf, provider);
    await verify(p.pdf, provider);
    assert.equal(hitsFor('lcr.ac.test/inter.crl').length, 1);
    assert.equal(cache.size, 2);
    // Depois do nextUpdate (07/06) a LCR é buscada de novo.
    await verify(p.pdf, provider, {
      verificationTime: T('2026-06-08T00:00:00Z'),
    });
    assert.equal(hitsFor('lcr.ac.test/inter.crl').length, 2);
  });

  it('cadeia da TSA também é coberta (LCR emitida depois do carimbo)', async () => {
    const p = await serveGoodChain();
    route(
      'lcr.ac.test',
      '/tsainter.crl',
      body('application/pkix-crl', await crlOf(p.tsaInter)),
    );
    route(
      'lcr.ac.test',
      '/tsaraiz.crl',
      body('application/pkix-crl', await crlOf(p.tsaRoot)),
    );
    hits.length = 0;
    const r = await verify(p.pdfTs, testProvider());
    assert.ok(hits.includes('lcr.ac.test/tsainter.crl'));
    assert.ok(hits.includes('lcr.ac.test/tsaraiz.crl'));
    assert.equal(
      r.temporalValidity.tsaRevocationChecked,
      true,
      JSON.stringify(r.temporalValidity),
    );
    assert.equal(r.temporalValidity.tsaTrustComplete, true);
    assert.equal(
      r.revocation.status,
      'GOOD_AT_POE',
      JSON.stringify(r.revocation),
    );
  });
});
