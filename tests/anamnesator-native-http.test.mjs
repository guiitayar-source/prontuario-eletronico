import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { anamnesatorNative } from '../lib/supabase/anamnesator.ts';

const token = 'a'.repeat(64),
  device = 'b'.repeat(64),
  id = crypto.randomUUID();
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://synthetic.invalid';
process.env.SUPABASE_SECRET_KEY = 'synthetic-server-only-key';
const calls = [];
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  assert.match(
    url,
    /^https:\/\/synthetic\.invalid\/rest\/v1\/rpc\/anamnesator_native_(claim|result)$/,
  );
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  return Response.json(
    url.endsWith('claim')
      ? {
          id,
          consultation_id: crypto.randomUUID(),
          patient_label: 'Paciente sintético',
          expires_at: new Date().toISOString(),
        }
      : { received: true, revision: body.d.revision },
  );
};
const request = (action, data, overrides = {}) =>
  new Request(
    'https://psywrite.vercel.app/api/anamnesator/native?action=' +
      action +
      '&id=' +
      id,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Anamnesator-Native': '1',
        Authorization: 'Bearer ' + token,
        ...overrides,
      },
      body: JSON.stringify(data),
    },
  );
try {
  await test('Native claim sends only hashes to PostgreSQL', async () => {
    const response = await anamnesatorNative(
      request('claim', { device_token: device }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      calls.at(-1).body.pair_hash,
      createHash('sha256').update(token).digest('hex'),
    );
    assert.equal(
      calls.at(-1).body.device_hash,
      createHash('sha256').update(device).digest('hex'),
    );
    const text = await response.text();
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(device), false);
  });
  await test('Native result accepts text without any audio/storage operation', async () => {
    const d = { revision: 1, transcription: 'Texto sintético', draft: '' };
    const response = await anamnesatorNative(request('result', d));
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1).body.d, d);
  });
  await test('Browser origins and missing/bad authorization never reach the database', async () => {
    const count = calls.length;
    for (const headers of [
      { Origin: 'https://psywrite.vercel.app' },
      { Authorization: token },
      { Authorization: 'Bearer short' },
      { 'X-Anamnesator-Native': '0' },
    ]) {
      assert.equal(
        (
          await anamnesatorNative(
            request(
              'result',
              { revision: 1, transcription: 'text', draft: '' },
              headers,
            ),
          )
        ).status,
        403,
      );
    }
    assert.equal(calls.length, count);
  });
  await test('Audio bodies and audio fields are rejected before database access', async () => {
    const count = calls.length;
    const audio = new Request(
      'https://psywrite.vercel.app/api/anamnesator/native?action=result&id=' +
        id,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Anamnesator-Native': '1',
          Authorization: 'Bearer ' + token,
        },
        body: new Uint8Array([82, 73, 70, 70]),
      },
    );
    assert.equal((await anamnesatorNative(audio)).status, 415);
    assert.equal(
      (
        await anamnesatorNative(
          request('result', {
            revision: 1,
            transcription: 'text',
            draft: '',
            audio: 'base64',
          }),
        )
      ).status,
      422,
    );
    assert.equal(calls.length, count);
  });
  await test('Invalid revisions, oversized text and malformed JSON are rejected', async () => {
    const count = calls.length;
    for (const data of [
      { revision: 0, transcription: 'text', draft: '' },
      { revision: 1, transcription: '', draft: '' },
      { revision: 1, transcription: 'x'.repeat(100001), draft: '' },
      { revision: 1, transcription: {}, draft: '' },
    ]) {
      assert.equal(
        (await anamnesatorNative(request('result', data))).status,
        422,
      );
    }
    assert.equal(calls.length, count);
  });
} finally {
  globalThis.fetch = original;
}
