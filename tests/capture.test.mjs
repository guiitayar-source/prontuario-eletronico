import { fixture } from './fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MAX_FILE } from '../lib/capture.ts';

test('computer → phone → upload → classify → download → delete', async () => {
  const f = fixture(),
    p = await f.connect();
  assert.equal(
    (await f.call(`mobile&id=${p.id}`, undefined, { token: p.token })).status,
    200,
  );
  const upload = await f.upload(p);
  assert.equal(upload.status, 201);
  const { id } = await upload.json();
  const list = await (await f.call('list')).json();
  assert.equal(list.attachments.length, 1);
  assert.equal(list.attachments[0].category, 'pending');
  assert.equal(
    (await f.call('classify', { id, category: 'exam' })).status,
    200,
  );
  const file = await f.call(`file&id=${id}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal((await file.arrayBuffer()).byteLength, 9);
  assert.equal(
    (await f.call('complete', { id: p.request.id }, { token: p.token })).status,
    200,
  );
  assert.equal(
    (await f.call('complete', { id: p.request.id }, { token: p.token })).status,
    200,
  );
  assert.equal((await f.call('delete', { id })).status, 200);
  assert.equal(f.objects.size, 0);
  assert.equal((await f.call(`file&id=${id}`)).status, 404);
});
test('requires signed-in owner, correct pairing token and same origin', async () => {
  const f = fixture(),
    p = await f.connect();
  assert.equal((await f.call('list', undefined, { user: '' })).status, 401);
  assert.equal(
    (
      await f.call(
        'connect',
        { category: 'exam' },
        { origin: 'https://evil.test' },
      )
    ).status,
    403,
  );
  assert.equal((await f.call(`mobile&id=${p.id}`)).status, 403);
  assert.equal(
    (await f.call(`mobile&id=${p.id}`, undefined, { token: '0'.repeat(64) }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.call(`mobile&id=${p.id}`, undefined, {
        token: p.token,
        user: 'doctor-b',
      })
    ).status,
    410,
  );
  assert.equal((await f.upload(p, { user: 'doctor-b' })).status, 404);
  const { id } = await (await f.upload(p)).json();
  assert.equal(
    (await f.call(`file&id=${id}`, undefined, { user: 'doctor-b' })).status,
    404,
  );
  assert.equal(
    (await f.call('delete', { id }, { user: 'doctor-b' })).status,
    404,
  );
  assert.equal(
    (await f.call('classify', { id, category: 'report' }, { user: 'doctor-b' }))
      .status,
    404,
  );
  assert.equal(
    (await (await f.call('list', undefined, { user: 'doctor-b' })).json())
      .attachments.length,
    0,
  );
});
test('closed, replaced and expired requests never receive another file', async () => {
  const f = fixture(),
    p = await f.connect();
  await f.call('request', { id: p.id, category: 'report' });
  assert.equal((await f.upload(p)).status, 409);
  assert.equal(f.objects.size, 0);
  const q = await f.connect();
  f.sql
    .prepare('UPDATE capture_requests SET expires_at = 0 WHERE id = ?')
    .run(q.request.id);
  assert.equal((await f.upload(q)).status, 409);
  const r = await f.connect();
  await f.call('disconnect', { id: r.id });
  assert.equal((await f.upload(r)).status, 410);
  const s = await f.connect();
  f.sql
    .prepare('UPDATE device_sessions SET expires_at = 0 WHERE id = ?')
    .run(s.id);
  assert.equal((await f.upload(s)).status, 410);
});
test('idempotent upload retry does not duplicate or replace content', async () => {
  const f = fixture(),
    p = await f.connect(),
    id = crypto.randomUUID();
  assert.equal((await f.upload(p, { id })).status, 201);
  assert.equal((await f.upload(p, { id })).status, 200);
  assert.equal(f.objects.size, 1);
  assert.equal((await (await f.call('list')).json()).attachments.length, 1);
});
test('rejects executable content, MIME spoofing, oversized files, invalid categories and patient injection', async () => {
  const f = fixture(),
    p = await f.connect();
  assert.equal(
    (
      await f.upload(p, {
        bytes: new TextEncoder().encode('<svg onload="alert(1)"/>'),
        type: 'image/png',
      })
    ).status,
    415,
  );
  assert.equal((await f.upload(p, { type: 'application/pdf' })).status, 415);
  assert.equal(
    (await f.upload(p, { bytes: new Uint8Array(MAX_FILE + 1) })).status,
    400,
  );
  assert.equal((await f.call('connect', { category: 'bad' })).status, 400);
  assert.equal(
    (await f.call('connect', { category: 'exam', patientId: 'other-patient' }))
      .status,
    404,
  );
});
test('disconnect during storage write rejects commit and cleans up object', async () => {
  const f = fixture(),
    p = await f.connect();
  const put = f.bucket.put;
  f.bucket.put = async (...args) => {
    await put(...args);
    await f.call('disconnect', { id: p.id });
  };
  assert.equal((await f.upload(p)).status, 409);
  assert.equal(f.objects.size, 0);
  assert.equal((await (await f.call('list')).json()).attachments.length, 0);
});
test('ten-file cap and manual classification preserve independent requests', async () => {
  const f = fixture(),
    p = await f.connect();
  for (let i = 0; i < 10; i++) assert.equal((await f.upload(p)).status, 201);
  assert.equal((await f.upload(p)).status, 409);
  assert.equal(f.objects.size, 10);
  const q = await f.connect();
  assert.equal((await f.upload(q)).status, 201);
  assert.equal((await (await f.call('list')).json()).attachments.length, 11);
});
