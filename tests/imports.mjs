import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { normalizeImport } from '../lib/imports/normalize.ts';
import { imports } from '../lib/supabase/imports.ts';
const lgpd = JSON.parse(
  readFileSync('public/examples/import-lgpd.json', 'utf8'),
);
const fhir = JSON.parse(
  readFileSync('public/examples/import-fhir-r4.json', 'utf8'),
);
const normalized = normalizeImport(lgpd);
assert.equal(normalized.records.length, 3);
assert.equal(normalized.records[0].occurred_at, '2026-08-01T10:00:00-03:00');
assert.equal(
  normalized.records[0].source_created_at,
  '2026-08-02T09:00:00-03:00',
);
assert.match(normalized.records[0].text, /Plano fictício/);
assert.match(normalized.records[0].text, /Z00.0/);
assert.equal(normalizeImport(fhir).records.length, 3);
const secret = structuredClone(lgpd);
secret.patient.portal_dob_hash = 'NEVER_COPY_SECRET';
secret.appointments = [
  {
    id: 'a',
    patient_id: secret.patient.id,
    whatsapp_confirmation_token: 'NEVER_COPY_SECRET',
  },
];
assert.ok(
  !JSON.stringify(normalizeImport(secret)).includes('NEVER_COPY_SECRET'),
);
const bad = structuredClone(lgpd);
bad.consultations[0].patient_id = 'other';
assert.throws(() => normalizeImport(bad), /outro paciente/);
const brokenRef = structuredClone(fhir);
brokenRef.entry[1].resource.subject.reference =
  'https://other.example/Patient/nope';
assert.throws(() => normalizeImport(brokenRef), /referência de paciente/);
const dates = structuredClone(lgpd);
dates.consultations[0].attended_at = '2026-02-30';
assert.equal(normalizeImport(dates).records[0].occurred_at, null);
const unknown = structuredClone(fhir);
unknown.entry.push({ resource: { resourceType: 'Observation' } });
assert.match(normalizeImport(unknown).warnings.join(' '), /Observation/);
const contained = structuredClone(fhir);
const request = contained.entry[3].resource;
delete request.medicationCodeableConcept;
request.medicationReference = { reference: '#m' };
request.contained = [
  {
    resourceType: 'Medication',
    id: 'm',
    code: { text: 'Medicamento contido fictício' },
  },
];
assert.equal(
  normalizeImport(contained).records[2].title,
  'Medicamento contido fictício',
);
const structuredDose = structuredClone(fhir);
structuredDose.entry[3].resource.dosageInstruction = [
  {
    route: { text: 'Oral' },
    doseAndRate: [{ doseQuantity: { value: 20, unit: 'mg' } }],
    timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' } },
  },
];
const doseText = normalizeImport(structuredDose).records[2].text;
assert.match(doseText, /Dose: 20 mg/);
assert.match(doseText, /Frequência: 2/);
assert.match(doseText, /Unidade do período: d/);
assert.match(doseText, /Via: Oral/);
const badCpf = structuredClone(lgpd);
badCpf.patient.cpf = '11111111111';
assert.equal(normalizeImport(badCpf).patients[0].fields.cpf, '');
assert.ok(normalizeImport(badCpf).patients[0].warnings.length);
console.log(
  'PASS parser: LGPD, FHIR, vínculo, datas distintas, referências, avisos, CPF e exclusão de credenciais.',
);
if (process.argv.includes('--parser-only')) process.exit(0);
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
  const email = `import-${crypto.randomUUID()}@example.invalid`,
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
async function call(u, c, action, d, query = '') {
  const r = await imports(
    new Request(
      'http://test.local/api/imports' + (action ? '?action=' + action : query),
      {
        method: action ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${u.token}`,
          'X-Clinic-Id': c,
          'X-Import-Action': '1',
          Origin: 'http://test.local',
        },
        body: action ? JSON.stringify(d) : undefined,
      },
    ),
  );
  return { status: r.status, data: await r.json() };
}
async function preview(u, c, file = lgpd, source = 'Sistema teste') {
  const r = await call(u, c, 'preview', { source, file: JSON.stringify(file) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
function selection(p, target) {
  return p.plan.patients.map((x) => ({
    source_id: x.source_id,
    target: target || x.linked_id || 'new',
  }));
}
async function commit(u, c, p, choices = selection(p)) {
  return call(u, c, 'commit', { id: p.id, confirmed: true, choices });
}
try {
  const owner = await user(),
    secretary = await user(),
    other = await user();
  for (const u of [owner, other]) {
    const r = await u.db.rpc('create_clinic', {
      clinic_name: 'Importações sintéticas',
    });
    assert.ifError(r.error);
    clinics.push(r.data);
  }
  const [c, c2] = clinics;
  assert.ifError(
    (
      await admin
        .from('clinic_members')
        .insert({ clinic_id: c, user_id: secretary.id, role: 'secretary' })
    ).error,
  );
  assert.equal(
    (
      await call(secretary, c, 'preview', {
        source: 'Teste',
        file: JSON.stringify(lgpd),
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(owner, c, 'preview', { source: 'Teste', file: '{"patient":' }))
      .status,
    422,
  );
  const p = await preview(owner, c);
  assert.equal(
    (await admin.from('patients').select('id').eq('clinic_id', c)).data.length,
    0,
    'preview creates no patients',
  );
  assert.equal(
    (await admin.from('import_records').select('id').eq('clinic_id', c)).data
      .length,
    0,
  );
  assert.ok(
    (await owner.db.from('import_records').insert({})).error,
    'direct writes blocked',
  );
  assert.equal(
    (await commit(other, c2, p)).status,
    403,
    'cross-clinic commit blocked',
  );
  const responses = await Promise.all([
    commit(owner, c, p),
    commit(owner, c, p),
  ]);
  for (const r of responses)
    assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(
    responses[0].data,
    responses[1].data,
    'commit replay idempotent',
  );
  const result = responses[0].data.result,
    pid = result.patients[0].id;
  assert.equal(result.imported, 3);
  assert.equal(result.created, 1);
  const second = await preview(owner, c);
  assert.equal(second.plan.patients[0].linked_id, pid);
  assert.ok(second.plan.records.every((r) => r.duplicate));
  const repeat = await commit(owner, c, second);
  assert.equal(repeat.status, 200, JSON.stringify(repeat.data));
  assert.equal(repeat.data.result.imported, 0);
  assert.equal(repeat.data.result.skipped, 3);
  assert.equal(
    (await owner.db.from('import_records').select('id').eq('clinic_id', c)).data
      .length,
    3,
  );
  const history = await call(owner, c, null, null, '?patientId=' + pid);
  assert.equal(history.data.total, 3);
  assert.equal(
    (await call(secretary, c, null, null, '?patientId=' + pid)).status,
    403,
  );
  assert.equal(
    (await secretary.db.from('import_records').select('*')).data.length,
    0,
  );
  const changed = structuredClone(lgpd);
  changed.consultations[0].hma = 'Alteração diferente';
  changed.medications.push({ id: 'should-rollback', name: 'Novo item' });
  const conflict = await preview(owner, c, changed);
  assert.ok(conflict.plan.records.some((r) => r.conflict));
  assert.equal((await commit(owner, c, conflict)).status, 409);
  assert.equal(
    (await owner.db.from('import_records').select('id').eq('clinic_id', c)).data
      .length,
    3,
    'conflict rolls back everything',
  );
  const newOrigin = await preview(owner, c, lgpd, 'Outra exportação');
  assert.equal(newOrigin.plan.patients[0].candidates[0].id, pid);
  assert.equal(
    (await commit(owner, c, newOrigin)).status,
    409,
    'cannot create duplicate name',
  );
  assert.equal(
    (await commit(owner, c, newOrigin, selection(newOrigin, pid))).status,
    200,
    'explicitly link existing patient',
  );
  const fresh = await preview(owner, c, fhir);
  const freshId = fresh.id;
  await admin
    .from('import_batches')
    .update({ expires_at: '2000-01-01T00:00:00Z' })
    .eq('id', freshId);
  assert.equal(
    (await commit(owner, c, fresh)).status,
    409,
    'expired preview blocked',
  );
  const cancelled = await preview(owner, c, fhir);
  assert.equal(
    (await call(owner, c, 'cancel', { id: cancelled.id })).status,
    200,
  );
  assert.equal((await commit(owner, c, cancelled)).status, 409);
  assert.equal(
    (await call(other, c2, 'revert', { id: result.id })).status,
    403,
  );
  assert.equal((await call(owner, c, 'revert', { id: result.id })).status, 200);
  assert.equal(
    (await call(owner, c, 'revert', { id: result.id })).status,
    200,
    'revert replay',
  );
  const active = (
    await owner.db
      .from('import_records')
      .select('*')
      .eq('clinic_id', c)
      .is('withdrawn_at', null)
  ).data;
  assert.equal(active.length, 3, 'other batch preserved');
  assert.equal(
    (await owner.db.from('patients').select('id').eq('clinic_id', c)).data
      .length,
    1,
    'patient preserved on undo',
  );
  const again = await preview(owner, c);
  const reimport = await commit(owner, c, again);
  assert.equal(reimport.status, 200, JSON.stringify(reimport.data));
  assert.equal(reimport.data.result.imported, 3);
  const firstFHIR = await preview(owner, c, fhir, 'FHIR rollback');
  const fhirSaved = await commit(owner, c, firstFHIR);
  assert.equal(fhirSaved.status, 200, JSON.stringify(fhirSaved.data));
  const multi = structuredClone(fhir);
  multi.entry.unshift({
    resource: {
      resourceType: 'Patient',
      id: 'new-before-conflict',
      name: [{ text: 'Pessoa fictícia que deve reverter' }],
    },
  });
  multi.entry.push({
    resource: {
      resourceType: 'Encounter',
      id: 'new-visit',
      subject: { reference: 'Patient/new-before-conflict' },
      status: 'finished',
      period: { start: '2026-01-01' },
    },
  });
  multi.entry[2].resource.text.div = '<div>Conflito deliberado</div>';
  const multiPreview = await preview(owner, c, multi, 'FHIR rollback');
  const failed = await commit(owner, c, multiPreview);
  assert.equal(failed.status, 409, JSON.stringify(failed.data));
  assert.equal(
    (
      await admin
        .from('patients')
        .select('id')
        .eq('clinic_id', c)
        .eq('name', 'Pessoa fictícia que deve reverter')
    ).data.length,
    0,
    'rollback removes patient inserted before late conflict',
  );
  assert.equal(
    (
      await admin
        .from('import_records')
        .select('id')
        .eq('clinic_id', c)
        .eq('source_id', 'new-visit')
    ).data.length,
    0,
    'rollback removes earlier records',
  );
  const audit = (
    await owner.db
      .from('audit_events')
      .select('action')
      .eq('clinic_id', c)
      .eq('entity_type', 'import_batches')
  ).data;
  assert.ok(audit.some((x) => x.action === 'import_commit'));
  assert.ok(audit.some((x) => x.action === 'import_revert'));
  console.log(
    'PASS DB: prévia sem importação, confirmação, duplicados, concorrência, rollback, vínculo, RLS, expiração, cancelamento, desfazer, reimportar e auditoria.',
  );
} finally {
  for (const c of clinics)
    for (const t of [
      'import_records',
      'import_patient_links',
      'import_batches',
      'audit_events',
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
