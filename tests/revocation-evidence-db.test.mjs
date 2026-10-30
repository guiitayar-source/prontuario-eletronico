// Lote 6F.2D: evidência de revogação guardada no banco. PostgreSQL e PostgREST reais e
// descartáveis (sem rede, sem .env); LCRs sintéticas assinadas de verdade.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import {
  createSignatureTrustDb,
} from './helpers/signature-trust-db.mjs';
import { startSignatureTrustRest } from './helpers/signature-trust-rest.mjs';
import {
  padesService,
  getStandardPkiAndTsaFixture,
  createSampleUnsignedPdf,
  signPdfWithOptionalTimestamp,
  createSyntheticCrl,
  createSyntheticOcspResponse,
} from './helpers/pades-revocation-fixtures.mjs';
import { parseX509Node } from '../lib/signature/icp-chain.ts';
import {
  keepsBytes,
  loadAttemptRevocationEvidence,
  revocationEvidenceRecords,
  saveAttemptRevocationEvidence,
} from '../lib/signature/revocation-evidence-store.ts';

const T = (s) => new Date(s);
const VERIFY_AT = T('2026-04-01T12:00:00Z');
const clinicA = randomUUID(),
  clinicB = randomUUID(),
  doctorA = randomUUID(),
  secretaryA = randomUUID(),
  doctorB = randomUUID(),
  attemptA = randomUUID(),
  attemptA2 = randomUUID(),
  attemptOcsp = randomUUID(),
  attemptAcquired = randomUUID();

const h = createSignatureTrustDb({ attempts: true, revocationEvidence: true });
const rest = await startSignatureTrustRest(h).catch((error) => {
  h.cleanup();
  throw error;
});
after(() => {
  try {
    rest.cleanup();
  } finally {
    h.cleanup();
  }
});
const client = (token) =>
  createClient('http://signature.synthetic', token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: rest.fetch },
  });
const server = client(rest.jwt('service_role'));
const as = (user) => client(rest.jwt('authenticated', user));

// Cadastro mínimo. As tentativas entram sem os gatilhos/FKs do fluxo (session_replication_role):
// este teste cobre só a gravação e a leitura da evidência.
h.sql(`insert into auth.users values ('${doctorA}'),('${secretaryA}'),('${doctorB}');
  insert into clinics(id,name) values ('${clinicA}','Clínica A sintética'),('${clinicB}','Clínica B sintética');
  insert into clinic_members(clinic_id,user_id,role) values
   ('${clinicA}','${doctorA}','doctor'),('${clinicA}','${secretaryA}','secretary'),('${clinicB}','${doctorB}','doctor');`);
const attemptRow = (id, state) =>
  `('${id}','${clinicA}','${randomUUID()}',1,'${doctorA}','chave-${id.slice(0, 8)}','${randomUUID()}','birdid','52998224725','${'AA:'.repeat(31)}AA','-----BEGIN CERTIFICATE-----x','{}','${state}','${randomUUID()}',now(),'path/${id}')`;
h.sql(
  `set session_replication_role=replica;
  insert into document_signing_attempts(id,clinic_id,document_id,document_version,user_id,idempotency_key,session_id,provider,signer_cpf,certificate_fingerprint,certificate_raw,document_snapshot,state,owner_token,lease_until,storage_path)
   values ${attemptRow(attemptA, 'EXTERNAL_STARTED')},${attemptRow(attemptA2, 'COMPLETED')},${attemptRow(attemptOcsp, 'COMPLETED')},${attemptRow(attemptAcquired, 'ACQUIRED')};`,
  { role: 'supabase_admin' },
);

const fx = await getStandardPkiAndTsaFixture();
const crl = (issuer, revokedList = []) =>
  createSyntheticCrl({
    issuerCert: issuer.cert,
    issuerPrivateKey: issuer.keyPair.privateKey,
    thisUpdate: T('2026-03-30T00:00:00Z'),
    nextUpdate: T('2026-04-07T00:00:00Z'),
    revokedList,
  });
const interCrl = await crl(fx.docInter);
const rootCrl = await crl(fx.docRoot);
// LCR que prova revogação do signatário (serial 300): motivo de bloqueio.
const revokedInterCrl = await crl(fx.docInter, [
  {
    serialNumber: 300,
    revocationDate: T('2026-03-20T00:00:00Z'),
    reasonCode: 1,
  },
]);
const ocsp = await createSyntheticOcspResponse({
  targetCert: fx.docSigner.cert,
  issuerCert: fx.docInter.cert,
  responderCert: fx.docInter.cert,
  responderPrivateKey: fx.docInter.keyPair.privateKey,
  producedAt: T('2026-04-01T11:00:00Z'),
  thisUpdate: T('2026-04-01T11:00:00Z'),
  nextUpdate: T('2026-04-02T11:00:00Z'),
});
const pdf = (
  await signPdfWithOptionalTimestamp({
    unsignedPdfBuffer: await createSampleUnsignedPdf(
      'Evidência guardada 6F.2D',
    ),
    signerCert: fx.docSigner.cert,
    signerPrivateKey: fx.docSigner.keyPair.privateKey,
    cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
  })
).signedPdf;
const verifyWith = (extra) =>
  padesService.verifyPadesSignature(pdf, {
    trustedRootPems: [fx.docRoot.pem],
    verificationTime: VERIFY_AT,
    ...extra,
  });

// Como na emissão: evidência coletada por cadeia + resultado da verificação.
const signerNode = parseX509Node(fx.docSigner.der);
const interNode = parseX509Node(fx.docInter.der);
const emission = async (signerEvidence) => {
  const collected = [
    {
      chain: 'SIGNER',
      evidence: [
        {
          ...signerEvidence,
          url: 'http://lcr.ac.sintetica.test/inter',
          certificate: signerNode,
          chainPosition: 0,
        },
        {
          kind: 'CRL',
          der: rootCrl,
          url: 'http://lcr.ac.sintetica.test/raiz.crl',
          certificate: interNode,
          chainPosition: 1,
        },
      ],
    },
  ];
  const verification = await verifyWith({
    validationContext: 'LIVE_ISSUANCE',
    crls: [
      rootCrl,
      ...(signerEvidence.kind === 'CRL' ? [signerEvidence.der] : []),
    ],
    ocspResponses: signerEvidence.kind === 'OCSP' ? [signerEvidence.der] : [],
  });
  return {
    verification,
    records: revocationEvidenceRecords(collected, verification),
  };
};
const good = await emission({ kind: 'CRL', der: interCrl });
const blocked = await emission({ kind: 'CRL', der: revokedInterCrl });
const viaOcsp = await emission({ kind: 'OCSP', der: ocsp });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const role = (records, r) => records.find((x) => x.certificate_role === r);
const count = (table, where = 'true') =>
  Number(h.sql(`select count(*) from ${table} where ${where};`));
const save = (attemptId, records) =>
  saveAttemptRevocationEvidence(
    server,
    { clinicId: clinicA, userId: doctorA, attemptId },
    records,
  );
const load = (attemptId, clinicId = clinicA) =>
  loadAttemptRevocationEvidence(server, { clinicId, attemptId });

test('migração de evidências aplicada na cópia descartável', () => {
  assert.equal(
    h.sql("select to_regclass('public.revocation_evidence') is not null;"),
    't',
  );
});

test('registros: LCR GOOD só metadados; bloqueio e OCSP levam os bytes', () => {
  assert.equal(good.verification.revocation.status, 'GOOD');
  const g = role(good.records, 'SIGNER');
  assert.equal(g.result, 'GOOD');
  assert.equal(g.der, undefined);
  assert.equal(g.byte_length, interCrl.length);
  assert.equal(g.sha256, sha(interCrl));
  assert.equal(g.this_update, '2026-03-30T00:00:00.000Z');
  assert.equal(role(good.records, 'SIGNER_CA').der, undefined);

  assert.equal(blocked.verification.assessment.issuanceAllowed, false);
  const b = role(blocked.records, 'SIGNER');
  assert.match(b.result, /^REVOKED_/);
  assert.equal(b.der, revokedInterCrl.toString('base64'));
  assert.equal(role(blocked.records, 'SIGNER_CA').der, undefined);

  const o = role(viaOcsp.records, 'SIGNER');
  assert.equal(o.kind, 'OCSP');
  assert.equal(o.result, 'GOOD');
  assert.equal(o.der, ocsp.toString('base64'));

  assert.equal(keepsBytes('CRL', 'GOOD'), false);
  assert.equal(keepsBytes('CRL', 'CERTIFICATE_HOLD'), true);
  assert.equal(keepsBytes('OCSP', 'GOOD'), true);
});

test('gravação: metadados ou bytes conforme o caso, com deduplicação pelo SHA-256', async () => {
  assert.equal(await save(attemptA, good.records), 'saved');
  assert.equal(await save(attemptA, good.records), 'saved');
  assert.equal(count('revocation_evidence'), 2);
  assert.equal(count('signing_revocation_evidence'), 2);
  assert.equal(count('revocation_evidence', 'der is null'), 2);
  assert.equal(
    h.sql(
      `select byte_length||':'||to_char(this_update at time zone 'UTC','YYYY-MM-DD') from revocation_evidence where sha256='${sha(interCrl)}';`,
    ),
    `${interCrl.length}:2026-03-30`,
  );
  // Outra tentativa com a mesma LCR: só o vínculo é novo.
  assert.equal(await save(attemptA2, good.records), 'saved');
  assert.equal(count('revocation_evidence'), 2);
  assert.equal(count('signing_revocation_evidence'), 4);
  // Bloqueio: a LCR que prova a revogação entra com os bytes; a da raiz já existe.
  assert.equal(await save(attemptA2, blocked.records), 'saved');
  assert.equal(count('revocation_evidence'), 3);
  assert.equal(count('signing_revocation_evidence'), 5);
  assert.equal(
    h.sql(
      `select der=decode(${h.lit(revokedInterCrl.toString('base64'))},'base64') from revocation_evidence where sha256='${sha(revokedInterCrl)}';`,
    ),
    't',
  );
  // OCSP: sempre com os bytes.
  assert.equal(await save(attemptOcsp, viaOcsp.records), 'saved');
  assert.equal(count('revocation_evidence'), 4);
  assert.equal(count('signing_revocation_evidence'), 7);
  assert.equal(count('revocation_evidence', 'der is not null'), 2);
});

test('a função recusa SHA divergente, sem bytes onde são exigidos, secretária, outra clínica e tentativa sem artefato', async () => {
  const call = (overrides = {}, items = good.records) =>
    server.rpc('signing_revocation_evidence_write', {
      p_clinic: clinicA,
      p_user: doctorA,
      p_attempt: attemptA,
      p_items: items,
      ...overrides,
    });
  const g = role(good.records, 'SIGNER');
  let r = await call({}, [
    { ...g, der: interCrl.toString('base64'), sha256: '0'.repeat(64) },
  ]);
  assert.equal(r.error?.code, '22023');
  r = await call({}, [
    { ...g, der: interCrl.toString('base64'), byte_length: 1 },
  ]);
  assert.equal(r.error?.code, '22023');
  // Prova de bloqueio sem bytes e OCSP sem bytes não são aceitos.
  r = await call({}, [{ ...g, result: 'REVOKED_NO_POE' }]);
  assert.equal(r.error?.code, '22023');
  const { der: _ocspDer, ...ocspWithoutBytes } = role(
    viaOcsp.records,
    'SIGNER',
  );
  r = await call({}, [ocspWithoutBytes]);
  assert.equal(r.error?.code, '22023');
  r = await call({ p_user: secretaryA });
  assert.equal(r.error?.code, '42501');
  r = await call({ p_clinic: clinicB, p_user: doctorB });
  assert.equal(r.error?.code, '42501');
  r = await call({ p_attempt: attemptAcquired });
  assert.equal(r.error?.code, '23514');
  r = await call({}, []);
  assert.equal(r.error?.code, '22023');
  assert.equal(count('signing_revocation_evidence'), 7);
  assert.equal(count('revocation_evidence'), 4);
});

test('usuário autenticado não grava: nem pela função nem direto na tabela', async () => {
  const doctor = as(doctorA);
  const r = await doctor.rpc('signing_revocation_evidence_write', {
    p_clinic: clinicA,
    p_user: doctorA,
    p_attempt: attemptA,
    p_items: good.records,
  });
  assert.ok(r.error);
  const ins = await doctor.from('revocation_evidence').insert({
    sha256: 'a'.repeat(64),
    kind: 'CRL',
    byte_length: 1,
    source_url: 'http://x.test/a.crl',
  });
  assert.ok(ins.error);
  const del = await doctor
    .from('signing_revocation_evidence')
    .delete()
    .eq('clinic_id', clinicA);
  assert.ok(del.error || (Array.isArray(del.data) && del.data.length === 0));
  assert.equal(count('signing_revocation_evidence'), 7);
});

test('RLS: médico da clínica lê; secretária, outra clínica e anônimo não', async () => {
  const read = async (db) => {
    const links = await db.from('signing_revocation_evidence').select('id');
    const evidence = await db.from('revocation_evidence').select('sha256');
    return [links.data?.length ?? 0, evidence.data?.length ?? 0];
  };
  assert.deepEqual(await read(as(doctorA)), [7, 4]);
  assert.deepEqual(await read(as(secretaryA)), [0, 0]);
  assert.deepEqual(await read(as(doctorB)), [0, 0]);
  assert.deepEqual(await read(client(rest.jwt('anon'))), [0, 0]);
});

test('reverificação sem rede: sem bytes fica INDETERMINATE; bloqueio e OCSP são reapresentados', async () => {
  // LCR GOOD guardada só como metadados: nada a reapresentar, sem erro.
  const onlyMetadata = await load(attemptA);
  assert.deepEqual(onlyMetadata, { crls: [], ocspResponses: [] });
  let r = await verifyWith(onlyMetadata);
  assert.equal(r.revocation.status, 'INDETERMINATE');
  assert.equal(r.revocation.subIndication, 'REVOCATION_UNAVAILABLE');
  assert.equal(r.assessment.cryptographicIntegrity, true);

  // Bloqueio: a LCR guardada continua provando a revogação.
  const proof = await load(attemptA2);
  assert.equal(proof.crls.length, 1);
  assert.ok(proof.crls[0].equals(revokedInterCrl));
  r = await verifyWith({ ...proof, validationContext: 'LIVE_ISSUANCE' });
  assert.equal(r.assessment.issuanceAllowed, false);

  // OCSP guardado: GOOD de novo, sem rede.
  const viaStoredOcsp = await load(attemptOcsp);
  assert.equal(viaStoredOcsp.ocspResponses.length, 1);
  r = await verifyWith(viaStoredOcsp);
  assert.equal(
    r.revocation.certificateResults.find((c) => c.role === 'SIGNER').source,
    'OCSP',
  );
  assert.equal(
    r.revocation.certificateResults.find((c) => c.role === 'SIGNER').status,
    'GOOD',
  );

  // Tentativa lida com outra clínica: nada.
  const other = await load(attemptA2, clinicB);
  assert.equal(other.crls.length + other.ocspResponses.length, 0);
});

test('bytes adulterados no banco são descartados na leitura', async () => {
  h.sql(
    `alter table revocation_evidence disable row level security;
     alter table revocation_evidence drop constraint if exists revocation_evidence_check;
     update revocation_evidence set der=der||'\\x00'::bytea where sha256='${sha(ocsp)}';`,
    { role: 'supabase_admin' },
  );
  assert.deepEqual(await load(attemptOcsp), { crls: [], ocspResponses: [] });
});

test('LCR guardada só como metadados recebe os bytes se depois virar prova de bloqueio', async () => {
  const g = role(good.records, 'SIGNER');
  const r = await server.rpc('signing_revocation_evidence_write', {
    p_clinic: clinicA,
    p_user: doctorA,
    p_attempt: attemptA,
    p_items: [
      { ...g, result: 'CERTIFICATE_HOLD', der: interCrl.toString('base64') },
    ],
  });
  assert.equal(r.error, null);
  assert.equal(
    h.sql(
      `select der is not null from revocation_evidence where sha256='${sha(interCrl)}';`,
    ),
    't',
  );
  assert.equal(count('revocation_evidence'), 4);
});

test('sem a migração (ou com erro), gravar e ler degradam sem lançar', async () => {
  const missing = {
    rpc: async () => ({
      data: null,
      error: { code: 'PGRST202', message: 'função ausente' },
    }),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => ({
            data: null,
            error: { code: '42P01', message: 'tabela ausente' },
          }),
        }),
      }),
    }),
  };
  const throwing = {
    rpc: () => {
      throw new Error('rede');
    },
    from: () => {
      throw new Error('rede');
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const target = { clinicId: clinicA, userId: doctorA, attemptId: attemptA };
    assert.equal(
      await saveAttemptRevocationEvidence(missing, target, good.records),
      'unavailable',
    );
    assert.equal(
      await saveAttemptRevocationEvidence(throwing, target, good.records),
      'unavailable',
    );
    assert.equal(
      await saveAttemptRevocationEvidence(throwing, target, []),
      'empty',
    );
    for (const db of [missing, throwing])
      assert.deepEqual(await loadAttemptRevocationEvidence(db, target), {
        crls: [],
        ocspResponses: [],
      });
  } finally {
    console.warn = warn;
  }
});
