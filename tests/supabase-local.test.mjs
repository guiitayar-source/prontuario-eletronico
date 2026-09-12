import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const cli = path.resolve('node_modules/.bin/supabase');
const rawStatus = execFileSync(cli, ['status', '-o', 'json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const status = JSON.parse(rawStatus.slice(rawStatus.indexOf('{')));
const admin = createClient(status.API_URL, status.SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = crypto.randomUUID();
const password = 'Local_test_123456789';
const users = [];
let clinicId;

async function createUser(label) {
  const email = `${label}.${stamp}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(error);
  users.push(data.user.id);

  const client = createClient(status.API_URL, status.PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  return { client, id: data.user.id };
}

try {
  const owner = await createUser('owner');
  const secretary = await createUser('secretary');

  const created = await owner.client.rpc('create_clinic', {
    clinic_name: 'Clínica fictícia de teste',
  });
  assert.ifError(created.error);
  clinicId = created.data;

  const inserted = await owner.client.from('patients').insert({
    clinic_id: clinicId,
    id: `patient-${stamp}`,
    name: 'Paciente Fictício',
    search_text: 'paciente ficticio',
  });
  assert.ifError(inserted.error);

  const ownerView = await owner.client
    .from('patients')
    .select('id')
    .eq('clinic_id', clinicId);
  assert.ifError(ownerView.error);
  assert.equal(ownerView.data.length, 1);

  const isolatedView = await secretary.client
    .from('patients')
    .select('id')
    .eq('clinic_id', clinicId);
  assert.ifError(isolatedView.error);
  assert.equal(isolatedView.data.length, 0);

  const blockedUpload = await secretary.client.storage
    .from('clinical-files')
    .upload(`${clinicId}/blocked.pdf`, new Uint8Array([37, 80, 68, 70]), {
      contentType: 'application/pdf',
    });
  assert.ok(blockedUpload.error);

  const invited = await owner.client.from('clinic_members').insert({
    clinic_id: clinicId,
    user_id: secretary.id,
    role: 'secretary',
  });
  assert.ifError(invited.error);

  const sharedView = await secretary.client
    .from('patients')
    .select('id')
    .eq('clinic_id', clinicId);
  assert.ifError(sharedView.error);
  assert.equal(sharedView.data.length, 1);

  const allowedUpload = await secretary.client.storage
    .from('clinical-files')
    .upload(`${clinicId}/patients/${stamp}/exam.pdf`, new Uint8Array([37, 80, 68, 70]), {
      contentType: 'application/pdf',
    });
  assert.ifError(allowedUpload.error);

  const auditInsert = await secretary.client.from('audit_events').insert({
    clinic_id: clinicId,
    actor_id: secretary.id,
    action: 'test_access',
    entity_type: 'patient',
    entity_id: `patient-${stamp}`,
  });
  assert.ifError(auditInsert.error);

  const secretaryAudit = await secretary.client
    .from('audit_events')
    .select('id')
    .eq('clinic_id', clinicId);
  assert.ifError(secretaryAudit.error);
  assert.equal(secretaryAudit.data.length, 0);

  const ownerAudit = await owner.client
    .from('audit_events')
    .select('id')
    .eq('clinic_id', clinicId);
  assert.ifError(ownerAudit.error);
  assert.equal(ownerAudit.data.length, 1);

  console.log('Supabase local: isolamento, compartilhamento, arquivos e auditoria verificados.');
} finally {
  if (clinicId) await admin.from('clinics').delete().eq('id', clinicId);
  for (const id of users) await admin.auth.admin.deleteUser(id);
}
