import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { fhir } from '../lib/supabase/fhir.ts';
import { capture } from '../lib/supabase/capture.ts';
const raw = execFileSync(
    'node_modules/.bin/supabase',
    ['status', '-o', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ),
  s = JSON.parse(raw.slice(raw.indexOf('{')));
assert.ok(s.API_URL.startsWith('http://127.0.0.1:'));
process.env.NEXT_PUBLIC_SUPABASE_URL = s.API_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = s.PUBLISHABLE_KEY;
process.env.SUPABASE_SECRET_KEY = s.SECRET_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } },
  admin = createClient(s.API_URL, s.SECRET_KEY, options),
  users = [],
  clinics = [],
  paths = [];
const good = (r) => {
  assert.ifError(r.error);
  return r.data;
};
async function user() {
  const email = `readiness-${randomUUID()}@example.invalid`,
    password = 'Synthetic_password_123!';
  const u = good(
    await admin.auth.admin.createUser({ email, password, email_confirm: true }),
  ).user;
  users.push(u.id);
  const db = createClient(s.API_URL, s.PUBLISHABLE_KEY, options);
  const session = good(
    await db.auth.signInWithPassword({ email, password }),
  ).session;
  return { id: u.id, db, token: session.access_token };
}
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(),
    offset = h[19] & 15;
  return ((h.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, '0');
}
async function call(handler, u, c, data, query = '') {
  return handler(
    new Request('http://test.local/api/test' + query, {
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'X-Clinic-Id': c,
        'X-FHIR-Action': '1',
        'X-Capture-Action': '1',
        Origin: 'http://test.local',
      },
      body: data ? JSON.stringify(data) : undefined,
    }),
  );
}
let folder;
try {
  const owner = await user(),
    secretary = await user(),
    doctor = await user(),
    outsider = await user();
  const c = good(
    await owner.db.rpc('create_clinic', {
      clinic_name: 'Teste fictício de segurança',
    }),
  );
  clinics.push(c);
  const c2 = good(
    await outsider.db.rpc('create_clinic', {
      clinic_name: 'Outra clínica fictícia',
    }),
  );
  clinics.push(c2);
  good(
    await admin.from('clinic_members').insert([
      { clinic_id: c, user_id: secretary.id, role: 'secretary' },
      { clinic_id: c, user_id: doctor.id, role: 'doctor' },
    ]),
  );
  const pid = randomUUID(),
    visit = randomUUID();
  good(
    await owner.db
      .from('patients')
      .insert({
        clinic_id: c,
        id: pid,
        name: 'Paciente Fictício & Teste',
        dob: '1990-01-02',
        gender: 'texto livre',
      }),
  );
  good(
    await admin
      .from('consultations')
      .insert({
        id: visit,
        clinic_id: c,
        patient_id: pid,
        author_id: owner.id,
        text: 'Texto livre <script>alert(1)</script>',
        finalized_at: new Date().toISOString(),
        finalized_by: owner.id,
      }),
  );
  good(
    await admin
      .from('consultation_addenda')
      .insert({
        id: randomUUID(),
        consultation_id: visit,
        clinic_id: c,
        author_id: owner.id,
        text: 'Adendo sintético',
      }),
  );
  good(
    await admin
      .from('patient_conditions')
      .insert({
        id: randomUUID(),
        clinic_id: c,
        patient_id: pid,
        author_id: owner.id,
        description: 'Condição sintética',
        status: 'hypothesis',
        cid_code: 'Z00.0',
      }),
  );
  good(
    await admin
      .from('patient_medications')
      .insert({
        id: randomUUID(),
        clinic_id: c,
        patient_id: pid,
        author_id: owner.id,
        name: 'Medicamento fictício',
        dose: '10 mg',
        instructions: 'Somente teste',
        status: 'active',
      }),
  );
  good(
    await admin
      .from('clinical_documents')
      .insert({
        id: randomUUID(),
        clinic_id: c,
        patient_id: pid,
        consultation_id: visit,
        author_id: owner.id,
        kind: 'Receita',
        patient_name: 'Paciente Fictício',
        physician_name: 'Médico Fictício',
        physician_registration: 'CRM fictício',
        document_date: '2026-09-13',
        text: 'Documento de teste',
      }),
  );
  const pair = good(
    await owner.db.rpc('capture_command', {
      c,
      action: 'connect',
      d: { patientId: pid, category: 'exam' },
    }),
  );
  const content = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082',
    'hex',
  );
  const details = {
    requestId: pair.request.id,
    uploadId: randomUUID(),
    name: 'ficticio.png',
    mime: 'image/png',
    size: content.length,
  };
  const lease = good(
    await owner.db.rpc('capture_command', {
      c,
      action: 'prepare',
      d: details,
      device_token: pair.token,
    }),
  );
  paths.push(lease.path);
  good(
    await owner.db.storage
      .from('clinical-files')
      .upload(lease.path, content, { contentType: 'image/png' }),
  );
  good(
    await admin.rpc('commit_verified_upload', {
      c,
      d: { ...details, path: lease.path },
      actor: owner.id,
      device_token: pair.token,
    }),
  );
  const attachment = good(
    await owner.db.from('attachments').select('id').eq('clinic_id', c).single(),
  );
  assert.equal(
    (await call(fhir, secretary, c, { patientId: pid })).status,
    403,
  );
  assert.equal((await call(fhir, outsider, c, { patientId: pid })).status, 403);
  assert.equal(
    good(await secretary.db.from('consultations').select('id')).length,
    0,
  );
  assert.equal(
    good(await secretary.db.from('patients').select('id').eq('clinic_id', c))
      .length,
    1,
  );
  assert.ok((await secretary.db.rpc('fhir_snapshot', { c, p: pid })).error);
  const response = await call(fhir, doctor, c, {
    patientId: pid,
    includeFiles: true,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const bundle = await response.json(),
    resources = bundle.entry.map((e) => e.resource);
  for (const type of [
    'Patient',
    'Encounter',
    'Condition',
    'MedicationRequest',
    'DocumentReference',
  ])
    assert.ok(resources.some((r) => r.resourceType === type));
  assert.equal(
    resources.find((r) => r.resourceType === 'MedicationRequest').intent,
    'plan',
  );
  assert.equal(
    resources.find((r) => r.resourceType === 'Condition').verificationStatus
      .coding[0].code,
    'provisional',
  );
  assert.ok(!JSON.stringify(bundle).includes('<script>'));
  assert.match(JSON.stringify(bundle), /Adendo sintético/);
  const doc = resources.find(
    (r) => r.resourceType === 'DocumentReference' && r.type.text === 'Receita',
  );
  assert.equal(doc.docStatus, 'preliminary');
  assert.ok(
    resources.some(
      (r) => r.content?.[0].attachment.data === content.toString('base64'),
    ),
  );
  const references = new Set(bundle.entry.map((e) => e.fullUrl));
  function refs(v) {
    if (v && typeof v === 'object') {
      if (v.reference)
        assert.ok(references.has(v.reference), 'dangling reference');
      for (const child of Object.values(v)) refs(child);
    }
  }
  refs(bundle);
  const plain = await (await call(fhir, owner, c, { patientId: pid })).json();
  assert.ok(JSON.stringify(plain).includes('/api/fhir?'));
  assert.ok(!JSON.stringify(plain).includes('token='));
  assert.equal(
    (
      await call(
        capture,
        secretary,
        c,
        { id: attachment.id, patientId: pid },
        '?action=delete',
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        capture,
        owner,
        c,
        { id: attachment.id, patientId: pid },
        '?action=delete',
      )
    ).status,
    200,
  );
  assert.ok(
    good(
      await admin
        .from('attachments')
        .select('archived_at')
        .eq('id', attachment.id)
        .single(),
    ).archived_at,
  );
  assert.equal(
    (
      await call(
        capture,
        owner,
        c,
        null,
        `?action=file&id=${attachment.id}&patientId=${pid}`,
      )
    ).status,
    409,
  );
  await owner.db.storage.from('clinical-files').remove([lease.path]);
  assert.ok(
    (await admin.storage.from('clinical-files').download(lease.path)).data,
    'accepted file retained',
  );
  assert.equal(
    (
      await call(
        capture,
        owner,
        c,
        { id: attachment.id, patientId: pid },
        '?action=restore',
      )
    ).status,
    200,
  );
  const enrollment = good(
    await owner.db.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Synthetic only',
    }),
  );
  good(
    await owner.db.auth.mfa.challengeAndVerify({
      factorId: enrollment.id,
      code: totp(enrollment.totp.secret),
    }),
  );
  const aal1 = createClient(s.API_URL, s.PUBLISHABLE_KEY, {
    ...options,
    global: { headers: { Authorization: `Bearer ${owner.token}` } },
  });
  assert.equal(
    good(await aal1.from('patients').select('id')).length,
    0,
    'old password-only token denied',
  );
  assert.equal(
    (await call(fhir, owner, c, { patientId: pid })).status,
    403,
    'API enforces MFA',
  );
  assert.ok(
    (await aal1.rpc('fhir_snapshot', { c, p: pid })).error,
    'RPC enforces MFA',
  );
  assert.equal(
    good(
      await aal1
        .from('clinic_members')
        .select('clinic_id')
        .eq('user_id', owner.id),
    ).length,
    1,
    'MFA bootstrap membership available',
  );
  owner.token = (await owner.db.auth.getSession()).data.session.access_token;
  good(await owner.db.rpc('enable_clinic_mfa', { c }));
  assert.equal(
    good(await doctor.db.from('patients').select('id').eq('clinic_id', c))
      .length,
    0,
    'mandatory MFA denies unenrolled doctor',
  );
  assert.equal(
    good(await secretary.db.from('patients').select('id').eq('clinic_id', c))
      .length,
    0,
    'mandatory MFA denies unenrolled secretary',
  );
  assert.ok(
    (await owner.db.from('clinics').update({ require_mfa: false }).eq('id', c))
      .error,
    'direct policy downgrade denied',
  );
  assert.equal(
    (await call(fhir, owner, c, { patientId: pid })).status,
    200,
    'aal2 allowed',
  );
  assert.ok(
    good(
      await owner.db.from('audit_events').select('action').eq('clinic_id', c),
    ).some((e) => e.action === 'export_snapshot'),
  );
  console.log(
    'PASS FHIR/resources/references, protected attachments, archive/restore, doctor/secretary/cross-clinic, MFA on API/RLS/RPC and audit.',
  );
  folder = await mkdtemp(join(tmpdir(), 'psy-backup-test-'));
  await writeFile(join(folder, 'fhir.json'), JSON.stringify(bundle));
  if (process.env.FHIR_SCHEMA_PATH) {
    const { default: Ajv } = await import('ajv');
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const schema = JSON.parse(
      await readFile(process.env.FHIR_SCHEMA_PATH, 'utf8'),
    );
    delete schema.$schema;
    delete schema.id;
    const validate = ajv.compile(schema);
    assert.ok(validate(bundle), JSON.stringify(validate.errors));
    console.log('PASS official FHIR R4 JSON schema (structural validation).');
  }
  const env = {
    ...process.env,
    PSYWRITE_BACKUP_PASSPHRASE: randomUUID() + randomUUID(),
  };
  for (const command of ['create', 'verify']) {
    const output = execFileSync(
      'node',
      [
        'scripts/backup.mjs',
        command,
        '--local',
        '--file',
        join(folder, 'synthetic.psybackup'),
      ],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log(output.trim());
  }
  const bytes = await readFile(join(folder, 'synthetic.psybackup'));
  assert.ok(!bytes.includes(Buffer.from('Paciente Fictício')));
  bytes[100] ^= 1;
  await writeFile(join(folder, 'corrupt.psybackup'), bytes);
  assert.throws(() =>
    execFileSync(
      'node',
      [
        'scripts/backup.mjs',
        'verify',
        '--file',
        join(folder, 'corrupt.psybackup'),
      ],
      { env, stdio: 'pipe' },
    ),
  );
  assert.throws(() =>
    execFileSync(
      'node',
      [
        'scripts/backup.mjs',
        'verify',
        '--file',
        join(folder, 'synthetic.psybackup'),
      ],
      {
        env: {
          ...env,
          PSYWRITE_BACKUP_PASSPHRASE: 'wrong password for testing',
        },
        stdio: 'pipe',
      },
    ),
  );
  console.log(
    'PASS encrypted backup, isolated DB restore, attachment bytes, corruption and wrong password rejection.',
  );
} finally {
  for (const path of paths)
    await admin.storage.from('clinical-files').remove([path]);
  for (const c of clinics)
    for (const t of [
      'consultation_addenda',
      'clinical_documents',
      'consultations',
      'patient_conditions',
      'patient_medications',
      'patient_allergies',
      'patient_allergy_states',
      'attachments',
      'pending_uploads',
      'capture_requests',
      'device_sessions',
      'audit_events',
      'patients',
      'clinic_members',
      'clinics',
    ])
      good(
        await admin
          .from(t)
          .delete()
          .eq(t === 'clinics' ? 'id' : 'clinic_id', c),
      );
  for (const id of users) good(await admin.auth.admin.deleteUser(id));
  if (folder) await rm(folder, { recursive: true, force: true });
}
