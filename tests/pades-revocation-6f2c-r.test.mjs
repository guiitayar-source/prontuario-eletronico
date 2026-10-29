// Lote 6F.2C-R: regressões independentes dos defeitos da auditoria (docs/auditorias/6f2c/).
// Cada caso reproduz um contraexemplo que passava antes da correção.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OID_KP_TIME_STAMPING } from '../lib/signature/rfc3161-timestamp.ts';
import { assessSignature } from '../lib/signature/verification-policy.ts';
import { assertSigningCertificate } from '../lib/signature/signing-identity.ts';
import {
  padesService,
  getStandardPkiAndTsaFixture,
  createSampleUnsignedPdf,
  createSyntheticCertificate,
  generateRsaKeyPair,
  buildBasicConstraintsExtension,
  buildKeyUsageExtension,
  buildExtendedKeyUsageExtension,
  signPdfWithOptionalTimestamp,
  createRfc3161TimestampToken,
  createSyntheticCrl,
  createSyntheticOcspResponse,
} from './helpers/pades-revocation-fixtures.mjs';

const T = (s) => new Date(s);
const POE = T('2026-02-10T14:00:00Z');
const VERIFY_AT = T('2026-04-01T12:00:00Z');
const SIGNER_SERIAL = 300;

let ctxPromise = null;
async function ctx() {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      const fx = await getStandardPkiAndTsaFixture();
      const tsToken =
        (genTime, tsa = fx) =>
        async (sig) =>
          createRfc3161TimestampToken({
            stampedContentBytes: sig,
            genTime,
            tsaCert: tsa.tsaSigner.cert,
            tsaPrivateKey: tsa.tsaSigner.keyPair.privateKey,
            tsaCertificates: tsa.tsaCertificates ?? [
              tsa.tsaSigner.cert,
              tsa.tsaInter.cert,
            ],
          });
      const sign = async (opts = {}) =>
        (
          await signPdfWithOptionalTimestamp({
            unsignedPdfBuffer: await createSampleUnsignedPdf(),
            signerCert: fx.docSigner.cert,
            signerPrivateKey: fx.docSigner.keyPair.privateKey,
            cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
            claimedSigningTime: T('2026-02-10T13:59:50Z'),
            ...opts,
          })
        ).signedPdf;
      const crl = (issuer, thisUpdate, nextUpdate, revokedList = []) =>
        createSyntheticCrl({
          issuerCert: issuer.cert,
          issuerPrivateKey: issuer.keyPair.privateKey,
          thisUpdate: T(thisUpdate),
          nextUpdate: T(nextUpdate),
          revokedList,
        });
      // Evidência das ACs e da TSA emitida DEPOIS da POE (válida para a validação histórica).
      const chainAfterPoe = [
        await crl(fx.docRoot, '2026-02-11T00:00:00Z', '2026-12-01T00:00:00Z'),
        await crl(fx.tsaInter, '2026-02-11T00:00:00Z', '2026-12-01T00:00:00Z'),
        await crl(fx.tsaRoot, '2026-02-11T00:00:00Z', '2026-12-01T00:00:00Z'),
      ];
      return {
        fx,
        crl,
        sign,
        chainAfterPoe,
        pdfTs: await sign({ buildTimestampToken: tsToken(POE) }),
        pdfNoTs: await sign({ claimedSigningTime: T('2026-03-15T14:29:50Z') }),
        tsToken,
      };
    })();
  }
  return ctxPromise;
}

const verify = async (pdf, extra = {}) => {
  const { fx } = await ctx();
  return padesService.verifyPadesSignature(pdf, {
    trustedRootPems: [fx.docRoot.pem],
    trustedTsaRootPems: [fx.tsaRoot.pem],
    verificationTime: VERIFY_AT,
    ...extra,
  });
};
const signerSummary = (r) =>
  r.revocation.certificateResults?.find((c) => c.role === 'SIGNER');
const outcome = (r) =>
  JSON.stringify({
    status: r.status,
    sub: r.subIndication,
    rev: r.revocation.status,
    revSub: r.revocation.subIndication,
    revokedAt: r.revocation.revokedAt,
    error: r.revocation.error,
    certs: r.revocation.certificateResults,
  });

describe('6F.2C-R A2 — isValid, avaliação e estado persistido', () => {
  it('revogação conhecida sem POE: INDETERMINATE, mas isValid=false e emissão bloqueada', async () => {
    const { fx, crl, pdfNoTs } = await ctx();
    const r = await verify(pdfNoTs, {
      crls: [
        await crl(fx.docInter, '2026-03-02T00:00:00Z', '2026-05-01T00:00:00Z', [
          {
            serialNumber: SIGNER_SERIAL,
            revocationDate: T('2026-03-01T00:00:00Z'),
            reasonCode: 1,
          },
        ]),
        await crl(fx.docRoot, '2026-02-01T00:00:00Z', '2026-12-01T00:00:00Z'),
      ],
    });
    assert.equal(r.status, 'INDETERMINATE');
    assert.equal(r.revocation.status, 'REVOKED_NO_POE');
    assert.equal(r.isValid, false);
    assert.equal(r.assessment.knownRevocation, true);
    assert.equal(r.assessment.rejected, true);
    assert.equal(r.assessment.issuanceAllowed, false);
    assert.equal(r.assessment.fullTrust, false);
    assert.equal(r.persistenceStatus, 'UNVERIFIED');
    assert.throws(
      () =>
        assertSigningCertificate(
          {
            clinicId: 'c',
            userId: 'u',
            documentId: 'd',
            documentVersion: 1,
            sessionId: 's',
            cpf: '34929144892',
            certificateFingerprint: r.certificateFingerprint,
          },
          r,
        ),
      /reconciliação/,
    );
  });

  it('revogação indisponível (sem CRL/OCSP): não bloqueia a emissão, mas nunca é confiança plena', async () => {
    const { pdfNoTs } = await ctx();
    const r = await verify(pdfNoTs);
    assert.equal(r.status, 'INDETERMINATE');
    assert.equal(r.subIndication, 'REVOCATION_UNAVAILABLE');
    assert.equal(r.isValid, true);
    assert.equal(r.assessment.issuanceAllowed, true);
    assert.equal(r.assessment.chainTrusted, true);
    assert.equal(r.assessment.fullTrust, false);
    assert.equal(r.isTrusted, false);
    assert.equal(r.persistenceStatus, 'UNVERIFIED');
    assertSigningCertificate(
      {
        clinicId: 'c',
        userId: 'u',
        documentId: 'd',
        documentVersion: 1,
        sessionId: 's',
        cpf: '34929144892',
        certificateFingerprint: r.certificateFingerprint,
      },
      r,
    );
  });

  it('emissão ao vivo com certificado já revogado: INVALID e persistido INVALID', async () => {
    const { fx, crl, pdfNoTs } = await ctx();
    const r = await verify(pdfNoTs, {
      validationContext: 'LIVE_ISSUANCE',
      crls: [
        await crl(fx.docInter, '2026-03-02T00:00:00Z', '2026-05-01T00:00:00Z', [
          {
            serialNumber: SIGNER_SERIAL,
            revocationDate: T('2026-03-01T00:00:00Z'),
            reasonCode: 4,
          },
        ]),
        await crl(fx.docRoot, '2026-02-01T00:00:00Z', '2026-12-01T00:00:00Z'),
      ],
    });
    assert.equal(r.status, 'INVALID');
    assert.equal(r.isValid, false);
    assert.equal(r.assessment.issuanceAllowed, false);
    assert.equal(r.persistenceStatus, 'INVALID');
  });

  it('certificado sintético fora de raiz confiável: emissão simulada permitida, sem confiança plena', async () => {
    const { pdfNoTs } = await ctx();
    // Sem trustedRootPems de teste: a cadeia sintética não fecha nas raízes ICP-Brasil fixadas.
    const r = await padesService.verifyPadesSignature(pdfNoTs, {
      verificationTime: VERIFY_AT,
    });
    assert.equal(r.status, 'INDETERMINATE');
    assert.equal(r.assessment.chainTrusted, false);
    assert.equal(r.assessment.fullTrust, false);
    assert.equal(r.assessment.issuanceAllowed, true);
    assert.equal(r.persistenceStatus, 'UNVERIFIED');
  });

  it('VALID é o único caminho para persistir VALID', async () => {
    const { fx, crl, pdfNoTs } = await ctx();
    const r = await verify(pdfNoTs, {
      crls: [
        await crl(fx.docInter, '2026-03-20T00:00:00Z', '2026-05-01T00:00:00Z'),
        await crl(fx.docRoot, '2026-02-01T00:00:00Z', '2026-12-01T00:00:00Z'),
      ],
    });
    assert.equal(r.status, 'VALID');
    assert.equal(r.assessment.fullTrust, true);
    assert.equal(r.persistenceStatus, 'VALID');
    // A regra é única: o mesmo resultado reavaliado não muda.
    assert.deepEqual(assessSignature(r), r.assessment);
  });
});

describe('6F.2C-R A3 — evidência posterior à POE na validação histórica', () => {
  it('CRL emitida depois da POE e já vencida no instante da verificação comprova GOOD na POE', async () => {
    const { fx, crl, pdfTs, chainAfterPoe } = await ctx();
    const r = await verify(pdfTs, {
      crls: [
        await crl(fx.docInter, '2026-02-10T15:00:00Z', '2026-02-17T15:00:00Z'),
        ...chainAfterPoe,
      ],
    });
    assert.equal(r.temporalValidity.tsaTrustComplete, true);
    assert.equal(r.revocation.status, 'GOOD_AT_POE');
    assert.equal(r.status, 'VALID');
  });

  it('OCSP produzido depois da POE e já vencido comprova GOOD na POE', async () => {
    const { fx, pdfTs, chainAfterPoe } = await ctx();
    const ocsp = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      producedAt: T('2026-02-10T15:00:00Z'),
      thisUpdate: T('2026-02-10T15:00:00Z'),
      nextUpdate: T('2026-02-11T15:00:00Z'),
      certStatus: 'good',
    });
    const r = await verify(pdfTs, {
      crls: chainAfterPoe,
      ocspResponses: [ocsp],
    });
    assert.equal(signerSummary(r).source, 'OCSP');
    assert.equal(r.revocation.status, 'GOOD_AT_POE');
    assert.equal(r.status, 'VALID');
  });

  it('evidência emitida depois do vencimento do certificado não comprova GOOD', async () => {
    const { fx, crl, pdfTs, chainAfterPoe } = await ctx();
    const r = await verify(pdfTs, {
      verificationTime: T('2026-08-01T00:00:00Z'),
      crls: [
        // docSigner vence em 2026-06-30: a AC pode ter retirado o certificado da lista.
        await crl(fx.docInter, '2026-07-05T00:00:00Z', '2026-07-12T00:00:00Z'),
        ...chainAfterPoe,
      ],
    });
    assert.notEqual(r.status, 'VALID');
    assert.equal(signerSummary(r).subIndication, 'TRY_LATER');
  });
});

describe('6F.2C-R A4 — frescor, ordem e subconjunto de evidências', () => {
  it('CRL anterior à POE, ainda vigente agora, não comprova GOOD na POE', async () => {
    const { fx, crl, pdfTs, chainAfterPoe } = await ctx();
    const r = await verify(pdfTs, {
      crls: [
        await crl(fx.docInter, '2026-02-01T00:00:00Z', '2026-05-01T00:00:00Z'),
        ...chainAfterPoe,
      ],
    });
    assert.equal(r.temporalValidity.tsaTrustComplete, true);
    assert.notEqual(r.status, 'VALID');
    assert.equal(r.revocation.status, 'INDETERMINATE');
    assert.equal(signerSummary(r).subIndication, 'TRY_LATER');
  });

  it('nenhum subconjunto e nenhuma ordem de evidências produz VALID para certificado revogado antes da POE', async () => {
    const { fx, crl, pdfTs, chainAfterPoe } = await ctx();
    const oldCrl = await crl(
      fx.docInter,
      '2026-02-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
    );
    const newCrl = await crl(
      fx.docInter,
      '2026-02-11T00:00:00Z',
      '2026-05-01T00:00:00Z',
      [
        {
          serialNumber: SIGNER_SERIAL,
          revocationDate: T('2026-02-05T00:00:00Z'),
          reasonCode: 4,
        },
      ],
    );
    for (const subset of [[oldCrl], [newCrl], [oldCrl, newCrl]]) {
      const r = await verify(pdfTs, { crls: [...subset, ...chainAfterPoe] });
      assert.notEqual(r.status, 'VALID');
      assert.notEqual(r.revocation.status, 'GOOD_AT_POE');
    }
    const orders = [
      [oldCrl, newCrl, ...chainAfterPoe],
      [newCrl, oldCrl, ...chainAfterPoe],
      [...chainAfterPoe].reverse().concat([newCrl, oldCrl]),
      [chainAfterPoe[1], oldCrl, chainAfterPoe[0], newCrl, chainAfterPoe[2]],
    ];
    const results = [];
    for (const crls of orders)
      results.push(outcome(await verify(pdfTs, { crls })));
    assert.equal(new Set(results).size, 1);
    assert.equal(JSON.parse(results[0]).rev, 'REVOKED_NO_POE');
  });

  it('a ordem de CRL e OCSP para o mesmo certificado não altera o resultado', async () => {
    const { fx, crl, pdfTs, chainAfterPoe } = await ctx();
    const good = await crl(
      fx.docInter,
      '2026-02-12T00:00:00Z',
      '2026-05-01T00:00:00Z',
    );
    const revokedOcsp = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      producedAt: T('2026-03-02T00:00:00Z'),
      thisUpdate: T('2026-03-02T00:00:00Z'),
      nextUpdate: T('2026-03-09T00:00:00Z'),
      certStatus: 'revoked',
      revocationDate: T('2026-03-01T00:00:00Z'),
      reasonCode: 4,
    });
    const a = await verify(pdfTs, {
      crls: [good, ...chainAfterPoe],
      ocspResponses: [revokedOcsp],
    });
    const b = await verify(pdfTs, {
      crls: [...chainAfterPoe, good],
      ocspResponses: [revokedOcsp],
    });
    assert.equal(outcome(a), outcome(b));
    assert.equal(a.revocation.status, 'GOOD_AT_POE'); // revogado depois da POE
  });
});

describe('6F.2C-R A5 — invalidityDate para qualquer motivo', () => {
  const revokedWith = async (reasonCode, invalidityDate) => {
    const { fx, crl } = await ctx();
    return crl(fx.docInter, '2026-03-05T00:00:00Z', '2026-05-01T00:00:00Z', [
      {
        serialNumber: SIGNER_SERIAL,
        revocationDate: T('2026-03-01T00:00:00Z'),
        reasonCode,
        invalidityDate: invalidityDate ? T(invalidityDate) : undefined,
      },
    ]);
  };

  for (const reasonCode of [undefined, 0, 3, 4, 5]) {
    it(`motivo ${reasonCode ?? 'ausente'} com invalidityDate anterior à POE não é VALID`, async () => {
      const { pdfTs, chainAfterPoe } = await ctx();
      const r = await verify(pdfTs, {
        crls: [
          await revokedWith(reasonCode, '2026-01-15T00:00:00Z'),
          ...chainAfterPoe,
        ],
      });
      assert.notEqual(r.status, 'VALID');
      assert.equal(r.revocation.status, 'REVOKED_NO_POE');
      assert.equal(r.assessment.issuanceAllowed, false);
    });
  }

  it('invalidityDate posterior à POE preserva GOOD_AT_POE (motivo administrativo e keyCompromise)', async () => {
    const { pdfTs, chainAfterPoe } = await ctx();
    for (const reasonCode of [4, 1]) {
      const r = await verify(pdfTs, {
        crls: [
          await revokedWith(reasonCode, '2026-02-20T00:00:00Z'),
          ...chainAfterPoe,
        ],
      });
      assert.equal(r.revocation.status, 'GOOD_AT_POE');
      assert.equal(r.status, 'VALID');
    }
  });

  it('motivo não reconhecido (7) sem invalidityDate é tratado como comprometimento', async () => {
    const { pdfTs, chainAfterPoe } = await ctx();
    const r = await verify(pdfTs, {
      crls: [await revokedWith(7), ...chainAfterPoe],
    });
    assert.equal(r.subIndication, 'REVOKED_KEY_COMPROMISE');
  });

  it('OCSP revoked com invalidityDate anterior à POE também não é VALID', async () => {
    const { fx, pdfTs, chainAfterPoe } = await ctx();
    const ocsp = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      producedAt: T('2026-03-02T00:00:00Z'),
      thisUpdate: T('2026-03-02T00:00:00Z'),
      nextUpdate: T('2026-03-09T00:00:00Z'),
      certStatus: 'revoked',
      revocationDate: T('2026-03-01T00:00:00Z'),
      reasonCode: 0,
      invalidityDate: T('2026-01-15T00:00:00Z'),
    });
    const r = await verify(pdfTs, {
      crls: chainAfterPoe,
      ocspResponses: [ocsp],
    });
    assert.equal(r.revocation.status, 'REVOKED_NO_POE');
    assert.notEqual(r.status, 'VALID');
  });
});

describe('6F.2C-R — OCSP sem nextUpdate, tryLater e seleção de carimbo', () => {
  const ocspNoNext = async (at) => {
    const { fx } = await ctx();
    return createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      producedAt: T(at),
      thisUpdate: T(at),
      nextUpdate: null,
      certStatus: 'good',
    });
  };

  it('OCSP good sem nextUpdate: aceito dentro da idade máxima, recusado fora dela', async () => {
    const { fx, crl, pdfNoTs } = await ctx();
    const inter = await crl(
      fx.docRoot,
      '2026-02-01T00:00:00Z',
      '2026-12-01T00:00:00Z',
    );
    const fresh = await verify(pdfNoTs, {
      crls: [inter],
      ocspResponses: [await ocspNoNext('2026-04-01T11:00:00Z')],
    });
    assert.equal(fresh.status, 'VALID');
    const stale = await verify(pdfNoTs, {
      crls: [inter],
      ocspResponses: [await ocspNoNext('2026-03-30T11:00:00Z')],
    });
    assert.notEqual(stale.status, 'VALID');
    assert.equal(signerSummary(stale).subIndication, 'TRY_LATER');
    const configured = await verify(pdfNoTs, {
      crls: [inter],
      ocspResponses: [await ocspNoNext('2026-03-30T11:00:00Z')],
      revocationFreshness: { maxAgeWithoutNextUpdateSeconds: 3 * 24 * 3600 },
    });
    assert.equal(configured.status, 'VALID');
  });

  it('tryLater não assinado não conta como evidência de nenhum certificado', async () => {
    const { fx, crl, pdfNoTs } = await ctx();
    const tryLater = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      responseStatus: 3,
    });
    const only = await verify(pdfNoTs, { ocspResponses: [tryLater] });
    assert.equal(signerSummary(only).source, 'NONE');
    assert.equal(signerSummary(only).subIndication, 'TRY_LATER');
    assert.notEqual(only.status, 'VALID');
    const withCrl = await verify(pdfNoTs, {
      ocspResponses: [tryLater],
      crls: [
        await crl(fx.docInter, '2026-03-20T00:00:00Z', '2026-05-01T00:00:00Z'),
        await crl(fx.docRoot, '2026-02-01T00:00:00Z', '2026-12-01T00:00:00Z'),
      ],
    });
    assert.ok(
      withCrl.revocation.certificateResults.every((c) => c.source === 'CRL'),
    );
    assert.equal(withCrl.status, 'VALID');
  });

  it('um carimbo mais antigo de TSA sem revogação comprovada não esconde um carimbo completo posterior', async () => {
    const { fx, sign, tsToken, chainAfterPoe } = await ctx();
    const otherRootKeys = await generateRsaKeyPair();
    const otherSignerKeys = await generateRsaKeyPair();
    const otherRoot = await createSyntheticCertificate({
      serialNumber: 700,
      subjectCn: 'AC Raiz Tempo Alternativa Sintetica',
      subjectKeyPair: otherRootKeys,
      notBefore: T('2020-01-01T00:00:00Z'),
      notAfter: T('2035-01-01T00:00:00Z'),
      extensions: [
        buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 1 }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });
    const otherSigner = await createSyntheticCertificate({
      serialNumber: 701,
      subjectCn: 'SERVIDOR ACT ALTERNATIVO',
      issuerCert: otherRoot.cert,
      subjectKeyPair: otherSignerKeys,
      signingPrivateKey: otherRootKeys.privateKey,
      notBefore: T('2024-01-01T00:00:00Z'),
      notAfter: T('2030-01-01T00:00:00Z'),
      extensions: [
        buildBasicConstraintsExtension({ cA: false, critical: false }),
        buildKeyUsageExtension({
          digitalSignature: true,
          nonRepudiation: true,
        }),
        buildExtendedKeyUsageExtension([OID_KP_TIME_STAMPING], true),
      ],
    });
    const otherTsa = {
      tsaSigner: otherSigner,
      tsaCertificates: [otherSigner.cert],
    };
    const pdf = await sign({
      buildTimestampToken: async (sig) => [
        await tsToken(T('2026-02-05T00:00:00Z'), otherTsa)(sig),
        await tsToken(POE)(sig),
      ],
    });
    const { crl } = await ctx();
    const r = await verify(pdf, {
      trustedTsaRootPems: [fx.tsaRoot.pem, otherRoot.pem],
      crls: [
        await crl(fx.docInter, '2026-02-11T00:00:00Z', '2026-05-01T00:00:00Z'),
        ...chainAfterPoe,
      ],
    });
    assert.equal(r.temporalValidity.poeTime?.toISOString(), POE.toISOString());
    assert.equal(r.temporalValidity.tsaTrustComplete, true);
    assert.equal(r.status, 'VALID');
  });
});
