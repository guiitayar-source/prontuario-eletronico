// Fluxos reais da aplicação + PostgreSQL/PostgREST reais. PSC, GoTrue e bytes de
// Storage são exclusivamente locais/sintéticos. Nenhuma chamada externa permitida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { register } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { createSignatureTrustDb } from './helpers/signature-trust-db.mjs';
import { startSignatureTrustRest } from './helpers/signature-trust-rest.mjs';
import { syntheticRceText } from './helpers/rce-fixture.mjs';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { decryptToken } from '../lib/signature/crypto-utils.ts';

const root = new URL('../', import.meta.url).href;
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,next){if(s.startsWith('@/'))return next(new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?'':'.ts'),${JSON.stringify(root)}).href,c);return next(s,c);}`,
    ),
  import.meta.url,
);
const { DocumentSigningService } =
  await import('../lib/signature/document-signing-service.ts');
const { setCustomSignatureProvider } =
  await import('../lib/signature/provider-factory.ts');
const { documents } = await import('../lib/supabase/documents.ts');
const { reserveDocument, getNumberingContext, localSimulationEnabled } =
  await import('../lib/sncr/numbering.ts');

const h = createSignatureTrustDb();
const clinic = randomUUID(),
  doctor = randomUUID(),
  colleague = randomUUID(),
  otherClinic = randomUUID(),
  outsider = randomUUID();
const actor = { clinicId: clinic, userId: doctor };
const url = 'http://127.0.0.1:54321';
const envKeys = [
  'NODE_ENV',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SIGNATURE_ENCRYPTION_KEY',
  'PSYWRITE_SNCR_MODE',
  'ANVISA_SNCR_ENV',
  'VERCEL',
  'VERCEL_ENV',
];
const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const files = new Map();
let rest,
  session,
  simple,
  simpleResult,
  controlled,
  controlledResult,
  signCalls = 0;
try {
  rest = await startSignatureTrustRest(h);
  const tokens = {
    doctor: rest.jwt('authenticated', doctor),
    colleague: rest.jwt('authenticated', colleague),
    outsider: rest.jwt('authenticated', outsider),
    server: rest.jwt('service_role'),
    anon: rest.jwt('anon'),
  };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: tokens.anon,
    SUPABASE_SECRET_KEY: tokens.server,
    SIGNATURE_ENCRYPTION_KEY: 'synthetic-6c-only',
    PSYWRITE_SNCR_MODE: 'local-simulation',
    ANVISA_SNCR_ENV: 'hmg',
  });
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    assert.equal(
      target.origin,
      url,
      'Nenhuma rede externa ou outro Supabase é admitido.',
    );
    if (target.pathname.startsWith('/rest/v1/'))
      return rest.fetch(
        new Request(
          `http://signature.synthetic${target.pathname}${target.search}`,
          request,
        ),
      );
    const bearer = request.headers
      .get('authorization')
      ?.replace(/^Bearer /, '');
    if (target.pathname === '/auth/v1/user') {
      const user =
        bearer === tokens.doctor
          ? doctor
          : bearer === tokens.colleague
            ? colleague
            : bearer === tokens.outsider
              ? outsider
              : null;
      return Response.json(
        user
          ? { id: user, aud: 'authenticated' }
          : { message: 'Sessão sintética inválida' },
        { status: user ? 200 : 401 },
      );
    }
    if (target.pathname.startsWith('/storage/v1/object/')) {
      const path = decodeURIComponent(
        target.pathname.replace(
          /^\/storage\/v1\/object\/(?:authenticated\/)?clinical-files\//,
          '',
        ),
      );
      if (request.method === 'POST') {
        assert.equal(
          bearer,
          tokens.server,
          'Somente servidor envia o original neste ensaio.',
        );
        assert.ok(!files.has(path), 'Original não pode ser sobrescrito.');
        files.set(path, new Uint8Array(await request.arrayBuffer()));
        return Response.json({ Key: `clinical-files/${path}` });
      }
      if (request.method === 'GET' && files.has(path))
        return new Response(files.get(path), {
          headers: { 'content-type': 'application/pdf' },
        });
      return Response.json({ message: 'Original ausente' }, { status: 404 });
    }
    throw Error(`Transporte não previsto: ${target.pathname}`);
  };
  const client = (token) =>
    createClient(url, token, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  const backend = client(tokens.server),
    userDb = client(tokens.doctor);
  const service = new DocumentSigningService(() => backend);
  const provider = new MockBirdIdProvider({
    mockCpf: '52998224725',
    doctorName: 'TITULAR SINTETICO 6C',
  });
  const signHash = provider.signHash.bind(provider);
  provider.signHash = async (args) => {
    signCalls++;
    return signHash(args);
  };
  setCustomSignatureProvider(provider);
  h.sql(`insert into auth.users values ('${doctor}'),('${colleague}'),('${outsider}');
    insert into clinics(id,name) values ('${clinic}','Clínica sintética'),('${otherClinic}','Outra clínica sintética');
    insert into clinic_members(clinic_id,user_id,role) values ('${clinic}','${doctor}','doctor'),('${clinic}','${colleague}','doctor'),('${otherClinic}','${outsider}','doctor');
    insert into patients(clinic_id,id,name,cpf,street,address_number,city,state) values ('${clinic}','synthetic','Paciente sintético','52998224725','Rua Sintética','100','Cidade de Teste','SP');
    insert into document_profiles(clinic_id,user_id,physician_name,physician_registration,cpf,letterhead_address,letterhead_phone)
      values ('${clinic}','${doctor}','Titular sintético','CRM 12345 SP','52998224725','Rua Sintética, 200 - Cidade de Teste - SP','(11) 0000-0000');`);
  async function oauth() {
    const start = await service.initiateOAuthSession({
      db: userDb,
      ...actor,
      redirectUri: 'https://synthetic.invalid/callback',
      provider: 'birdid',
    });
    return service.handleOAuthCallback({
      db: userDb,
      ...actor,
      code: 'synthetic-code-only',
      state: start.state,
    });
  }
  async function createDocument(text, kind = 'Receita') {
    const result = await userDb.rpc('document_write', {
      c: clinic,
      d: {
        id: randomUUID(),
        patient_id: 'synthetic',
        kind,
        text,
        physician_name: 'Titular sintético',
        physician_registration: 'CRM 12345 SP',
        document_date: '2026-10-29',
        version: 0,
      },
    });
    assert.equal(result.error, null);
    return result.data;
  }
  async function retrieve(doc, token = tokens.doctor) {
    return documents(
      new Request(
        `http://psywrite.synthetic/api/documents?action=pdf&patientId=synthetic&id=${doc.id}`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    );
  }
  await test('13 backend cria estado OAuth e sessão cifrada pelo PostgREST', async () => {
    session = await oauth();
    assert.equal(session.userId, doctor);
    assert.equal(h.sql('select count(*) from signature_oauth_states;'), '0');
    const cipher = h.sql(
      `select access_token_encrypted from signature_sessions where id='${session.id}';`,
    );
    assert.notEqual(cipher, decryptToken(cipher));
    const active = await service.getActiveSession(userDb, clinic, doctor);
    assert.equal(active.id, session.id);
    assert.equal(active.access_token_encrypted, undefined);
    assert.equal(active.certificate_raw, undefined);
  });
  await test('14 backend revoga sessão e cria substituta sem reativar a antiga', async () => {
    const previous = session.id;
    await service.revokeSession(userDb, clinic, doctor);
    assert.equal(await service.getActiveSession(userDb, clinic, doctor), null);
    session = await oauth();
    assert.notEqual(session.id, previous);
    assert.equal(
      h.sql(`select revoked from signature_sessions where id='${previous}';`),
      't',
    );
  });
  await test('15 assinatura PAdES simulada grava autoria, versão, hashes e UNVERIFIED corretos', async () => {
    simple = await createDocument(
      `Modalidade: Receita simples\n${syntheticRceText}`,
    );
    simpleResult = await service.signClinicalDocument({
      db: userDb,
      ...actor,
      documentId: simple.id,
    });
    const signature = simpleResult.signature;
    assert.equal(signature.signer_user_id, doctor);
    assert.equal(signature.signer_doctor_id, doctor);
    assert.equal(signature.document_version, simple.version);
    assert.equal(signature.verification_status, 'UNVERIFIED');
    assert.equal(
      signature.signed_pdf_hash,
      createHash('sha256')
        .update(files.get(simpleResult.signedPdfPath))
        .digest('hex'),
    );
    assert.equal(
      h.sql(`select status from clinical_documents where id='${simple.id}';`),
      'SIGNED',
    );
    assert.equal(signCalls, 1);
  });
  await test('16 médico recupera original autorizado com os mesmos bytes', async () => {
    const response = await retrieve(simple);
    assert.equal(response.status, 200);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      files.get(simpleResult.signedPdfPath),
    );
    assert.equal(signCalls, 1);
  });
  await test('17 acesso clínico legítimo é preservado e outra clínica não recupera o documento', async () => {
    assert.equal((await retrieve(simple, tokens.colleague)).status, 200);
    assert.equal((await retrieve(simple, tokens.outsider)).status, 404);
    const doc = await userDb
      .from('clinical_documents')
      .select('id,status')
      .eq('id', simple.id)
      .single();
    assert.equal(doc.error, null);
    assert.equal(doc.data.status, 'SIGNED');
  });
  await test('18 documento comum e receita simples usam os privilégios legítimos do servidor', async () => {
    assert.equal(simpleResult.success, true);
    assert.equal(
      h.sql(
        `select count(*) from sncr_reservations where document_id='${simple.id}';`,
      ),
      '0',
    );
    const doc = await createDocument(
      'Documento inteiramente sintético sem validade clínica.',
      'Atestado',
    );
    assert.equal(
      (
        await service.signClinicalDocument({
          db: userDb,
          ...actor,
          documentId: doc.id,
        })
      ).success,
      true,
    );
    assert.equal(signCalls, 2);
  });
  await test('19 receita controlada preserva reserva, número, titular e histórico SNCR', async () => {
    controlled = await createDocument(
      `Modalidade: Controle especial\n${syntheticRceText}`,
    );
    const request = randomUUID();
    h.sql(`insert into sncr_local_sandboxes values ('${clinic}','synthetic-local-only');
      insert into sncr_requests(id,clinic_id,prescriber_id,environment,modality,request_key,origin,state) values ('${request}','${clinic}','${doctor}','hmg','controle_especial',gen_random_uuid(),'synthetic','completed');
      insert into sncr_batches(request_id,clinic_id,prescriber_id,environment,modality,council,council_number,council_uf,registration_snapshot,number_prefix,suffix_width,first_suffix,last_suffix,next_suffix,origin,verification_state)
        values ('${request}','${clinic}','${doctor}','hmg','controle_especial','CRM','12345','SP','CRM 12345 SP','SIMULADO.6C.',7,1,2,1,'synthetic','verified');`);
    const reserved = await reserveDocument(backend, actor, controlled.id);
    controlledResult = await service.signClinicalDocument({
      db: userDb,
      ...actor,
      documentId: controlled.id,
    });
    const context = await getNumberingContext(backend, actor, controlled.id);
    assert.equal(context.reservation.id, reserved.reservation.id);
    assert.equal(context.reservation.number, reserved.reservation.number);
    assert.equal(context.reservation.prescriber_id, doctor);
    assert.equal(context.reservation.state, 'signed');
    assert.equal(context.document.status, 'SIGNED');
    assert.equal(
      h.sql(
        `select next_suffix-first_suffix from sncr_batches where request_id='${request}';`,
      ),
      '1',
    );
    assert.equal(
      h.sql(
        `select count(*)>0 from sncr_operation_history where reservation_id='${reserved.reservation.id}';`,
      ),
      't',
    );
  });
  await test('20 recuperação controlada conserva original; adulteração ou ausência bloqueiam sem regenerar', async () => {
    const response = await retrieve(controlled);
    assert.equal(response.status, 200);
    const original = files.get(controlledResult.signedPdfPath);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), original);
    const before = files.size;
    files.set(controlledResult.signedPdfPath, new Uint8Array([1, 2, 3]));
    assert.equal((await retrieve(controlled)).status, 503);
    files.delete(controlledResult.signedPdfPath);
    assert.equal((await retrieve(controlled)).status, 503);
    assert.equal(files.size, before - 1);
    files.set(controlledResult.signedPdfPath, original);
  });
  await test('PostgREST recusa INSERT VALID, troca de sessão/estado e leitura de ciphertext', async () => {
    const doctorDb = client(tokens.doctor),
      colleagueDb = client(tokens.colleague),
      outsideDb = client(tokens.outsider);
    for (const result of [
      await doctorDb
        .from('digital_signatures')
        .insert({ document_id: simple.id, verification_status: 'VALID' }),
      await doctorDb
        .from('signature_sessions')
        .update({
          cpf: '11144477735',
          access_token_encrypted: 'forjado',
          revoked: false,
        })
        .eq('id', session.id),
      await doctorDb
        .from('signature_oauth_states')
        .insert({ clinic_id: clinic, user_id: doctor, state_hash: 'forjado' }),
      await doctorDb
        .from('signature_sessions')
        .select('access_token_encrypted'),
      await doctorDb.from('signature_oauth_states').select('*'),
      await doctorDb.rpc('sncr_finish_signing', {
        p_clinic: clinic,
        p_prescriber: doctor,
        p_document: controlled.id,
        p_attempt: randomUUID(),
      }),
    ])
      assert.equal(result.error?.code, '42501');
    assert.deepEqual(
      (await colleagueDb.from('signature_sessions').select('id')).data,
      [],
    );
    assert.deepEqual(
      (await outsideDb.from('digital_signatures').select('id')).data,
      [],
    );
  });
  await test('modo produção conserva bloqueio de números sintéticos e emissão oficial', async () => {
    process.env.NODE_ENV = 'production';
    assert.equal(localSimulationEnabled(), false);
    await assert.rejects(
      () =>
        service.signClinicalDocument({
          db: userDb,
          ...actor,
          documentId: controlled.id,
        }),
      (error) => error.status === 503,
    );
    process.env.NODE_ENV = 'test';
  });
} finally {
  globalThis.fetch = originalFetch;
  setCustomSignatureProvider(null);
  for (const key of envKeys)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  try {
    rest?.cleanup();
  } finally {
    h.cleanup();
  }
}
