// Integration against the local Cloudflare D1/R2 runtime. Never sends real data.
import assert from 'node:assert/strict';
const base = 'http://localhost:3000';
const signin = await fetch(`${base}/signin-with-chatgpt?return_to=/`, {
  redirect: 'manual',
});
const cookie = signin.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'Local sign-in cookie missing');
async function call(action, data, token) {
  const r = await fetch(`${base}/api/capture?action=${action}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      'X-Capture-Action': '1',
      origin: base,
      ...(token ? { 'X-Device-Token': token } : {}),
      ...(data !== undefined && !(data instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    body:
      data === undefined
        ? undefined
        : data instanceof FormData
          ? data
          : JSON.stringify(data),
  });
  const value = await r.json();
  assert.ok(r.ok, JSON.stringify(value));
  return value;
}
for (const path of ['/', '/celular'])
  assert.equal((await fetch(base + path)).status, 200);
assert.equal((await fetch(`${base}/api/capture?action=list`)).status, 401);
let pairing, id;
try {
  pairing = await call('connect', { category: 'exam' });
  const mobile = await call(
    `mobile&id=${pairing.id}`,
    undefined,
    pairing.token,
  );
  assert.equal(mobile.request.patient_name, 'Helena Costa');
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJVEAAAAASUVORK5CYII=',
    'base64',
  );
  const form = new FormData();
  form.set('requestId', pairing.request.id);
  form.set('uploadId', crypto.randomUUID());
  form.set(
    'file',
    new File([bytes], 'teste-ficticio.png', { type: 'image/png' }),
  );
  ({ id } = await call('upload', form, pairing.token));
  assert.ok((await call('list')).attachments.some((f) => f.id === id));
  await call('classify', { id, category: 'exam' });
  const downloaded = await fetch(`${base}/api/capture?action=file&id=${id}`, {
    headers: { cookie },
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  await call('complete', { id: pairing.request.id }, pairing.token);
  await call('disconnect', { id: pairing.id });
  const revoked = await fetch(
    `${base}/api/capture?action=mobile&id=${pairing.id}`,
    { headers: { cookie, 'X-Device-Token': pairing.token } },
  );
  assert.equal(revoked.status, 410);
  console.log(
    'Local HTTP integration passed: authentication, pairing, upload, classification, binary download, completion and revocation.',
  );
} finally {
  if (id) await call('delete', { id });
  if (pairing) await call('disconnect', { id: pairing.id });
}
