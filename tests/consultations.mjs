import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { consultations } from '../lib/supabase/consultations.ts';
const raw = execFileSync(
  'node_modules/.bin/supabase',
  ['status', '-o', 'json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
);
const s = JSON.parse(raw.slice(raw.indexOf('{')));
assert.match(s.API_URL, /^http:\/\/127\.0\.0\.1:/);
process.env.NEXT_PUBLIC_SUPABASE_URL = s.API_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = s.PUBLISHABLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(s.API_URL, s.SECRET_KEY, options),
  users = [];
let clinic;
async function user() {
  const email = `clinical-${crypto.randomUUID()}@example.invalid`,
    password = 'LocalTest_123456789';
  const r = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(r.error);
  users.push(r.data.user.id);
  const db = createClient(s.API_URL, s.PUBLISHABLE_KEY, options);
  const login = await db.auth.signInWithPassword({ email, password });
  assert.ifError(login.error);
  return { db, id: r.data.user.id, token: login.data.session.access_token };
}
async function call(u, action, d) {
  const r = await consultations(
    new Request(
      'http://test.local/api/consultations?' +
        (action ? 'action=' + action : 'patientId=test-clinical'),
      {
        method: action ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${u.token}`,
          'X-Clinic-Id': clinic,
          'X-Consultation-Action': '1',
          Origin: 'http://test.local',
        },
        body: action ? JSON.stringify(d) : undefined,
      },
    ),
  );
  return { status: r.status, ...(await r.json()) };
}
try {
  const owner = await user(),
    secretary = await user(),
    outsider = await user();
  const c = await owner.db.rpc('create_clinic', {
    clinic_name: 'Teste de consultas',
  });
  assert.ifError(c.error);
  clinic = c.data;
  assert.ifError(
    (
      await admin
        .from('clinic_members')
        .insert({ clinic_id: clinic, user_id: secretary.id, role: 'secretary' })
    ).error,
  );
  assert.ifError(
    (
      await admin
        .from('patients')
        .insert({
          clinic_id: clinic,
          id: 'test-clinical',
          name: 'Paciente sintético',
        })
    ).error,
  );
  const appointment = crypto.randomUUID();
  assert.ifError(
    (
      await admin
        .from('appointments')
        .insert({
          clinic_id: clinic,
          id: appointment,
          patient_id: 'test-clinical',
          starts_at: new Date().toISOString(),
          ends_at: new Date(Date.now() + 3600000).toISOString(),
          modality: 'presencial',
        })
    ).error,
  );
  const id = crypto.randomUUID();
  let r = await call(owner, 'create', {
    id,
    patient_id: 'test-clinical',
    appointment_id: appointment,
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.consultation.author_id, owner.id);
  assert.equal(
    (
      await call(owner, 'create', {
        id,
        patient_id: 'test-clinical',
        appointment_id: appointment,
      })
    ).consultation.id,
    id,
  );
  assert.equal((await call(secretary)).status, 403);
  assert.equal((await call(outsider)).status, 403);
  assert.equal(
    (await secretary.db.from('consultations').select('*')).data.length,
    0,
  );
  assert.ok(
    (
      await secretary.db.rpc('consultation_write', {
        c: clinic,
        action: 'save',
        d: { id, version: 1, text: 'proibido' },
      })
    ).error,
  );
  assert.ok(
    (
      await owner.db
        .from('consultations')
        .update({ text: 'bypass' })
        .eq('id', id)
    ).error,
  );
  const competing = await Promise.all([
    call(owner, 'save', { id, version: 1, text: 'Primeira versão' }),
    call(owner, 'save', { id, version: 1, text: 'Segunda versão' }),
  ]);
  assert.deepEqual(competing.map((x) => x.status).sort(), [200, 409]);
  r = await call(owner);
  assert.equal(r.consultations[0].version, 2);
  r = await call(owner, 'finalize', {
    id,
    version: 2,
    text: 'Evolução final.',
  });
  assert.equal(r.status, 200);
  assert.ok(r.consultation.finalized_at);
  assert.equal(r.consultation.finalized_by, owner.id);
  assert.equal(
    (await call(owner, 'save', { id, version: 3, text: 'alteração indevida' }))
      .status,
    409,
  );
  assert.equal(
    (
      await admin
        .from('appointments')
        .select('status')
        .eq('id', appointment)
        .single()
    ).data.status,
    'completed',
  );
  const addendum_id = crypto.randomUUID();
  assert.equal(
    (
      await call(owner, 'addendum', {
        id,
        addendum_id,
        text: 'Informação complementar.',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(owner, 'addendum', {
        id,
        addendum_id,
        text: 'Informação complementar.',
      })
    ).status,
    200,
  );
  assert.ok(
    (await owner.db.from('consultation_addenda').delete().eq('id', addendum_id))
      .error,
  );
  r = await call(owner);
  assert.equal(r.consultations[0].text, 'Evolução final.');
  assert.equal(r.consultations[0].consultation_addenda.length, 1);
  assert.ok(
    (
      await admin
        .from('audit_events')
        .select('id')
        .eq('clinic_id', clinic)
        .eq('entity_type', 'consultations')
    ).data.length >= 3,
  );
  console.log(
    'PASS: vínculo à agenda, retentativa, isolamento, secretária, escrita direta bloqueada, concorrência, finalização imutável, adendo único e auditoria.',
  );
} finally {
  if (clinic)
    for (const table of [
      'consultation_addenda',
      'consultations',
      'audit_events',
      'appointments',
      'patients',
      'clinic_members',
      'clinics',
    ]) {
      const r = await admin
        .from(table)
        .delete()
        .eq(table === 'clinics' ? 'id' : 'clinic_id', clinic);
      assert.ifError(r.error);
    }
  for (const id of users)
    assert.ifError((await admin.auth.admin.deleteUser(id)).error);
}
