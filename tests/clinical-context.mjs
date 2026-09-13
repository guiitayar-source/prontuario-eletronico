import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { clinicalContext } from '../lib/supabase/clinical-context.ts';
const raw = execFileSync(
  'node_modules/.bin/supabase',
  ['status', '-o', 'json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
);
const s = JSON.parse(raw.slice(raw.indexOf('{')));
assert.match(s.API_URL, /^http:\/\/127\.0\.0\.1:/);
process.env.NEXT_PUBLIC_SUPABASE_URL = s.API_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = s.PUBLISHABLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } },
  admin = createClient(s.API_URL, s.SECRET_KEY, options),
  users = [],
  clinics = [];
async function user() {
  const email = `context-${crypto.randomUUID()}@example.invalid`,
    password = 'Local_Test_123456789';
  const r = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(r.error);
  users.push(r.data.user.id);
  const db = createClient(s.API_URL, s.PUBLISHABLE_KEY, options),
    login = await db.auth.signInWithPassword({ email, password });
  assert.ifError(login.error);
  return { id: r.data.user.id, db, token: login.data.session.access_token };
}
async function call(u, c, d, patient = 'context-patient') {
  const r = await clinicalContext(
    new Request(`http://test.local/api/clinical-context?patientId=${patient}`, {
      method: d ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'X-Clinic-Id': c,
        'X-Clinical-Context-Action': '1',
        Origin: 'http://test.local',
      },
      body: d ? JSON.stringify(d) : undefined,
    }),
  );
  return { status: r.status, data: await r.json() };
}
try {
  const owner = await user(),
    secretary = await user(),
    other = await user();
  for (const u of [owner, other]) {
    const r = await u.db.rpc('create_clinic', {
      clinic_name: 'Contexto sintético',
    });
    assert.ifError(r.error);
    clinics.push(r.data);
    assert.ifError(
      (
        await admin.from('patients').insert({
          clinic_id: r.data,
          id: 'context-patient',
          name: 'Paciente sintético',
        })
      ).error,
    );
  }
  const c = clinics[0],
    c2 = clinics[1];
  assert.ifError(
    (
      await admin
        .from('clinic_members')
        .insert({ clinic_id: c, user_id: secretary.id, role: 'secretary' })
    ).error,
  );
  let r = await call(owner, c);
  assert.equal(r.status, 200);
  assert.equal(r.data.allergyState.state, 'unknown');
  assert.equal((await call(secretary, c)).status, 403);
  const med = {
    entity: 'medication',
    id: crypto.randomUUID(),
    patient_id: 'context-patient',
    name: 'Medicamento fictício',
    dose: '10 mg',
    instructions: '1 vez ao dia',
    status: 'active',
    version: 0,
  };
  r = await call(owner, c, med);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const savedMed = r.data.record;
  const concurrent = await Promise.all([
    call(owner, c, { ...med, version: savedMed.version, dose: '20 mg' }),
    call(owner, c, { ...med, version: savedMed.version, dose: '30 mg' }),
  ]);
  assert.deepEqual(
    concurrent.map((x) => x.status).sort((a, b) => a - b),
    [200, 409],
  );
  assert.ok(
    (
      await owner.db.from('patient_medications').insert({
        clinic_id: c,
        id: crypto.randomUUID(),
        patient_id: 'context-patient',
        author_id: owner.id,
        name: 'bypass',
        status: 'active',
      })
    ).error,
  );
  assert.equal(
    (await call(other, c2, { ...med, version: 1, dose: 'Ataque' })).status,
    403,
  );
  const condition = {
    entity: 'condition',
    id: crypto.randomUUID(),
    patient_id: 'context-patient',
    description: 'Hipótese fictícia',
    cid_code: 'f31.8',
    status: 'hypothesis',
    notes: 'Avaliar longitudinalmente',
    version: 0,
  };
  assert.equal((await call(owner, c, condition)).status, 200);
  const allergy = {
    entity: 'allergy',
    id: crypto.randomUUID(),
    patient_id: 'context-patient',
    substance: 'Substância fictícia',
    reaction: 'Reação fictícia',
    status: 'active',
    version: 0,
  };
  assert.equal((await call(owner, c, allergy)).status, 200);
  assert.equal(
    (
      await call(owner, c, {
        entity: 'allergy_state',
        patient_id: 'context-patient',
        state: 'known',
        version: 0,
      })
    ).status,
    200,
  );
  r = await call(owner, c);
  assert.equal(r.data.conditions[0].cid_code, 'F31.8');
  assert.equal(r.data.medications.length, 1);
  assert.equal(r.data.allergies.length, 1);
  assert.equal(r.data.allergyState.state, 'known');
  assert.equal(
    (
      await call(owner, c, {
        entity: 'allergy_state',
        patient_id: 'context-patient',
        state: 'none',
        version: r.data.allergyState.version,
      })
    ).status,
    200,
  );
  r = await call(owner, c);
  assert.equal(r.data.allergies[0].status, 'inactive');
  const audit = await admin
    .from('audit_events')
    .select('entity_type')
    .eq('clinic_id', c)
    .in('entity_type', [
      'patient_conditions',
      'patient_medications',
      'patient_allergies',
      'patient_allergy_states',
    ]);
  assert.ifError(audit.error);
  assert.ok(audit.data.length >= 6);
  console.log(
    'PASS: acesso médico, bloqueio administrativo/direto, CID, medicamentos, alergias, negação, concorrência, isolamento e auditoria.',
  );
} finally {
  for (const c of clinics)
    for (const t of [
      'audit_events',
      'patient_allergy_states',
      'patient_allergies',
      'patient_medications',
      'patient_conditions',
      'patients',
      'clinic_members',
      'clinics',
    ])
      assert.ifError(
        (
          await admin
            .from(t)
            .delete()
            .eq(t === 'clinics' ? 'id' : 'clinic_id', c)
        ).error,
      );
  for (const id of users)
    assert.ifError((await admin.auth.admin.deleteUser(id)).error);
}
