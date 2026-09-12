import assert from 'node:assert/strict';
const base = 'http://localhost:3000';
const signin = await fetch(base + '/signin-with-chatgpt?return_to=/', {
  redirect: 'manual',
});
const cookie = signin.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const headers = {
  cookie,
  'X-Patient-Action': '1',
  'Content-Type': 'application/json',
  origin: base,
};
async function call(query = '', body) {
  const r = await fetch(base + '/api/patients?' + query, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
assert.equal((await fetch(base + '/api/patients')).status, 401);
assert.equal((await fetch(base + '/')).status, 200);
const id = crypto.randomUUID();
const result = await call('action=create', {
  id,
  name: 'Teste HTTP Fictício ' + id.slice(0, 8),
  dob: '2000-01-01',
  phone: '11999990000',
  admin_notes: 'Registro sintético de teste local',
});
assert.equal(result.status, 201, JSON.stringify(result.data));
const p = result.data.patient;
assert.equal((await call('id=' + id)).data.patient.name, p.name);
const update = await call('action=update', { ...p, city: 'Cidade de teste' });
assert.equal(update.status, 200);
assert.equal(update.data.patient.version, 2);
assert.equal(
  (await call('action=update', { ...p, city: 'Versão antiga' })).status,
  409,
);
assert.ok(
  (await call('q=' + encodeURIComponent(id.slice(0, 8)))).data.patients.some(
    (x) => x.id === id,
  ),
);
const c = await fetch(base + '/api/capture?action=connect', {
  method: 'POST',
  headers: { ...headers, 'X-Capture-Action': '1' },
  body: JSON.stringify({ category: 'exam', patientId: id }),
});
const pair = await c.json();
assert.equal(c.status, 201);
assert.equal(pair.request.patient_id, id);
assert.equal(pair.request.patient_name, p.name);
await fetch(base + '/api/capture?action=disconnect', {
  method: 'POST',
  headers: { ...headers, 'X-Capture-Action': '1' },
  body: JSON.stringify({ id: pair.id }),
});
console.log(
  'HTTP passed: authenticated create, persistence, update, conflict, search and patient-bound mobile pairing. Only synthetic data used in the local test database.',
);
