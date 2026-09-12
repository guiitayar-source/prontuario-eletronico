import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { patientsHandler } from '../lib/patients.ts';
function setup() {
  const f = fixture(),
    handler = patientsHandler(f.db);
  async function call(query = '', data, owner = 'doctor-a') {
    return handler(
      new Request('https://demo.test/api/patients?' + query, {
        method: data ? 'POST' : 'GET',
        headers: {
          ...(owner ? { 'oai-authenticated-user-id': owner } : {}),
          'Content-Type': 'application/json',
          'X-Patient-Action': '1',
        },
        body: data ? JSON.stringify(data) : undefined,
      }),
    );
  }
  return { ...f, patientCall: call };
}
async function create(f, fields = {}, owner) {
  const response = await f.patientCall(
    'action=create',
    { id: crypto.randomUUID(), name: 'Paciente Fictício Teste', ...fields },
    owner,
  );
  assert.equal(response.status, 201);
  return (await response.json()).patient;
}
test('create and retrieve a full registration; search without accents; optimistic update', async () => {
  const f = setup();
  const p = await create(f, {
    name: 'Pessoa Fictícia Ágata',
    dob: '2001-02-03',
    phone: '(11) 99999-0000',
    city: 'Cidade fictícia',
    admin_notes: 'Dado sintético',
  });
  const fresh = (await (await f.patientCall('id=' + p.id)).json()).patient;
  assert.equal(fresh.phone, '(11) 99999-0000');
  assert.equal(fresh.city, 'Cidade fictícia');
  assert.ok(fresh.draft_key);
  assert.equal(
    (await (await f.patientCall('q=agata')).json()).patients.length,
    1,
  );
  const update = await f.patientCall('action=update', {
    ...p,
    name: 'Pessoa Atualizada',
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).patient.version, 2);
  assert.equal(
    (await f.patientCall('action=update', { ...p, name: 'Sobrescrita' }))
      .status,
    409,
  );
  assert.equal(
    (await (await f.patientCall('id=' + p.id)).json()).patient.name,
    'Pessoa Atualizada',
  );
});
test('rejects invalid fields and duplicate CPF while allowing missing CPF', async () => {
  const f = setup();
  assert.equal(
    (
      await f.patientCall('action=create', {
        id: crypto.randomUUID(),
        name: '',
        dob: '2025-02-31',
        cpf: '11111111111',
      })
    ).status,
    422,
  );
  const p = await create(f, { cpf: '529.982.247-25' });
  assert.equal(p.cpf, '52998224725');
  assert.equal(
    (
      await f.patientCall('action=create', {
        id: crypto.randomUUID(),
        name: 'Duplicado fictício',
        cpf: '52998224725',
      })
    ).status,
    409,
  );
  await create(f);
  await create(f);
  await create(f, { cpf: '52998224725' }, 'doctor-b');
  assert.equal((await f.patientCall('action=create', { ...p })).status, 200);
});
test('patient records remain isolated by account', async () => {
  const f = setup(),
    p = await create(f);
  assert.equal(
    (await f.patientCall('id=' + p.id, undefined, 'doctor-b')).status,
    404,
  );
  assert.equal(
    (
      await f.patientCall(
        'action=update',
        { ...p, name: 'Tentativa' },
        'doctor-b',
      )
    ).status,
    404,
  );
  assert.equal((await f.patientCall('', undefined, '')).status, 401);
  assert.equal(
    (await (await f.patientCall('q=Paciente', undefined, 'doctor-b')).json())
      .patients.length,
    0,
  );
});
test('attachments stay with the request patient when another record is viewed', async () => {
  const f = setup(),
    a = await create(f, { name: 'Paciente Fictício A' }),
    b = await create(f, { name: 'Paciente Fictício B' });
  const p = await (
    await f.call('connect', { category: 'exam', patientId: a.id })
  ).json();
  assert.equal(p.request.patient_name, a.name);
  await f.call('list&patientId=' + b.id);
  const result = await f.upload(p);
  assert.equal(result.status, 201);
  const { id } = await result.json();
  assert.equal(
    (await (await f.call('list&patientId=' + a.id)).json()).attachments.length,
    1,
  );
  assert.equal(
    (await (await f.call('list&patientId=' + b.id)).json()).attachments.length,
    0,
  );
  assert.equal((await f.call(`file&id=${id}&patientId=${b.id}`)).status, 404);
  assert.equal(
    (await f.call('classify', { id, patientId: b.id, category: 'exam' }))
      .status,
    404,
  );
  assert.equal((await f.call(`file&id=${id}&patientId=${a.id}`)).status, 200);
});
