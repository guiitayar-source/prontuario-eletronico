// Lote 6F.2D: evidência de revogação guardada no banco. PostgreSQL e PostgREST reais e
// descartáveis (sem rede, sem .env); LCRs sintéticas assinadas de verdade.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { readFileSync } from 'node:fs';
import {
  createSignatureTrustDb,
  evidenceMigration,
} from './helpers/signature-trust-db.mjs';
import { startSignatureTrustRest } from './helpers/signature-trust-rest.mjs';
import {
  padesService,
  getStandardPkiAndTsaFixture,
  createSampleUnsignedPdf,
  signPdfWithOptionalTimestamp,
  createSyntheticCrl,
} from './helpers/pades-revocation-fixtures.mjs';
import { parseX509Node } from '../lib/signature/icp-chain.ts';
import {
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
   values ${attemptRow(attemptA, 'EXTERNAL_STARTED')},${attemptRow(attemptA2, 'COMPLETED')},${attemptRow(attemptAcquired, 'ACQUIRED')};`,
  { role: 'supabase_admin' },
);

const fx = await getStandardPkiAndTsaFixture();
const crl = (issuer) =>
  createSyntheticCrl({
    issuerCert: issuer.cert,
    issuerPrivateKey: issuer.keyPair.privateKey,
    thisUpdate: T('2026-03-30T00:00:00Z'),
    nextUpdate: T('2026-04-07T00:00:00Z'),
  });
const interCrl = await crl(fx.docInter);
const rootCrl = await crl(fx.docRoot);
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
const collected = [
  {
    chain: 'SIGNER',
    evidence: [
      {
        kind: 'CRL',
        der: interCrl,
        url: 'http://lcr.ac.sintetica.test/inter.crl',
        certificate: parseX509Node(fx.docSigner.der),
        chainPosition: 0,
      },
      {
        kind: 'CRL',
        der: rootCrl,
        url: 'http://lcr.ac.sintetica.test/raiz.crl',
        certificate: parseX509Node(fx.docInter.der),
        chainPosition: 1,
      },
    ],
  },
];
const atEmission = await verifyWith({ crls: [interCrl, rootCrl] });
const records = revocationEvidenceRecords(collected, atEmission);
const count = (table, where = 'true') =>
  Number(h.sql(`select count(*) from ${table} where ${where};`));

test('migração bloqueada no original; só a cópia descartável a aplica', () => {
  const source = readFileSync(
    new URL(`../supabase/migrations/${evidenceMigration}`, import.meta.url),
    'utf8',
  );
  assert.throws(
    () => h.sql(source),
    (e) =>
      /P0001.*Migração de evidências de revogação/s.test(
        String(e.stderr || e.message),
      ),
  );
  assert.equal(
    h.sql("select to_regclass('public.revocation_evidence') is not null;"),
    't',
  );
});

test('registros: papel, serial, impressão digital e resultado da verificação', () => {
  assert.equal(atEmission.revocation.status, 'GOOD');
  assert.equal(records.length, 2);
  const signer = records.find((r) => r.certificate_role === 'SIGNER');
  assert.equal(signer.result, 'GOOD');
  assert.equal(signer.kind, 'CRL');
  assert.equal(
    signer.sha256,
    createHash('sha256').update(interCrl).digest('hex'),
  );
  assert.equal(signer.this_update, '2026-03-30T00:00:00.000Z');
  assert.equal(
    records.find((r) => r.certificate_role === 'SIGNER_CA').result,
    'GOOD',
  );
});

test('gravação pelo backend e deduplicação pelo SHA-256', async () => {
  const target = { clinicId: clinicA, userId: doctorA, attemptId: attemptA };
  assert.equal(
    await saveAttemptRevocationEvidence(server, target, records),
    'saved',
  );
  assert.equal(
    await saveAttemptRevocationEvidence(server, target, records),
    'saved',
  );
  assert.equal(count('revocation_evidence'), 2);
  assert.equal(count('signing_revocation_evidence'), 2);
  // Outra tentativa reaproveita os mesmos bytes: só o vínculo é novo.
  assert.equal(
    await saveAttemptRevocationEvidence(
      server,
      { ...target, attemptId: attemptA2 },
      records,
    ),
    'saved',
  );
  assert.equal(count('revocation_evidence'), 2);
  assert.equal(count('signing_revocation_evidence'), 4);
  assert.equal(
    h.sql(
      `select der=decode(${h.lit(interCrl.toString('base64'))},'base64') from revocation_evidence where sha256='${records[0].sha256}';`,
    ),
    't',
  );
});

test('a função recusa SHA divergente, secretária, outra clínica e tentativa sem artefato', async () => {
  const call = (overrides = {}, items = records) =>
    server.rpc('signing_revocation_evidence_write', {
      p_clinic: clinicA,
      p_user: doctorA,
      p_attempt: attemptA,
      p_items: items,
      ...overrides,
    });
  let r = await call({}, [{ ...records[0], sha256: '0'.repeat(64) }]);
  assert.equal(r.error?.code, '22023');
  r = await call({ p_user: secretaryA });
  assert.equal(r.error?.code, '42501');
  r = await call({ p_clinic: clinicB, p_user: doctorB });
  assert.equal(r.error?.code, '42501');
  r = await call({ p_attempt: attemptAcquired });
  assert.equal(r.error?.code, '23514');
  r = await call({}, []);
  assert.equal(r.error?.code, '22023');
  assert.equal(count('signing_revocation_evidence'), 4);
});

test('usuário autenticado não grava: nem pela função nem direto na tabela', async () => {
  const doctor = as(doctorA);
  const r = await doctor.rpc('signing_revocation_evidence_write', {
    p_clinic: clinicA,
    p_user: doctorA,
    p_attempt: attemptA,
    p_items: records,
  });
  assert.ok(r.error);
  const ins = await doctor
    .from('revocation_evidence')
    .insert({
      sha256: 'a'.repeat(64),
      kind: 'CRL',
      der: '\\x00',
      source_url: 'http://x.test/a.crl',
    });
  assert.ok(ins.error);
  const del = await doctor
    .from('signing_revocation_evidence')
    .delete()
    .eq('clinic_id', clinicA);
  assert.ok(del.error || (Array.isArray(del.data) && del.data.length === 0));
  assert.equal(count('signing_revocation_evidence'), 4);
});

test('RLS: médico da clínica lê; secretária, outra clínica e anônimo não', async () => {
  const read = async (db) => {
    const links = await db.from('signing_revocation_evidence').select('id');
    const evidence = await db.from('revocation_evidence').select('sha256');
    return [links.data?.length ?? 0, evidence.data?.length ?? 0];
  };
  assert.deepEqual(await read(as(doctorA)), [4, 2]);
  assert.deepEqual(await read(as(secretaryA)), [0, 0]);
  assert.deepEqual(await read(as(doctorB)), [0, 0]);
  assert.deepEqual(await read(client(rest.jwt('anon'))), [0, 0]);
});

test('reverificação a partir da evidência guardada, sem rede', async () => {
  const stored = await loadAttemptRevocationEvidence(server, {
    clinicId: clinicA,
    attemptId: attemptA,
  });
  assert.equal(stored.crls.length, 2);
  assert.equal(stored.ocspResponses.length, 0);
  assert.ok(stored.crls.some((c) => c.equals(interCrl)));
  const r = await verifyWith(stored);
  assert.equal(r.revocation.status, 'GOOD');
  assert.equal(
    r.revocation.certificateResults.find((c) => c.role === 'SIGNER').source,
    'CRL',
  );
  // Sem a evidência, a mesma verificação fica sem revogação comprovada.
  assert.equal(
    (await verifyWith({})).revocation.subIndication,
    'REVOCATION_UNAVAILABLE',
  );
  // Tentativa de outra clínica: nada.
  const other = await loadAttemptRevocationEvidence(server, {
    clinicId: clinicB,
    attemptId: attemptA,
  });
  assert.equal(other.crls.length + other.ocspResponses.length, 0);
});

test('bytes adulterados no banco são descartados na leitura', async () => {
  h.sql(
    `alter table revocation_evidence disable row level security;
     update revocation_evidence set der=der||'\\x00'::bytea where sha256='${records[1].sha256}';`,
    { role: 'supabase_admin' },
  );
  const stored = await loadAttemptRevocationEvidence(server, {
    clinicId: clinicA,
    attemptId: attemptA,
  });
  assert.equal(stored.crls.length, 1);
  assert.ok(stored.crls[0].equals(interCrl));
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
      await saveAttemptRevocationEvidence(missing, target, records),
      'unavailable',
    );
    assert.equal(
      await saveAttemptRevocationEvidence(throwing, target, records),
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
