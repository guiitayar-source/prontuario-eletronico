import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { captureHandler } from '../lib/capture.ts';
export function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(
    readFileSync(
      new URL('../drizzle/0000_little_greymalkin.sql', import.meta.url),
      'utf8',
    ),
  );
  sql.exec(
    readFileSync(
      new URL('../drizzle/0001_broad_spot.sql', import.meta.url),
      'utf8',
    ),
  );
  sql.exec(
    readFileSync(
      new URL('../drizzle/0002_great_vector.sql', import.meta.url),
      'utf8',
    ),
  );
  const db = {
    prepare(query) {
      const statement = sql.prepare(query);
      let args = [];
      const wrapped = {
        bind(...a) {
          args = a;
          return wrapped;
        },
        async first() {
          return statement.get(...args) ?? null;
        },
        async all() {
          return { results: statement.all(...args) };
        },
        async run() {
          return { meta: { changes: statement.run(...args).changes } };
        },
      };
      return wrapped;
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sql.exec('COMMIT');
        return results;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const objects = new Map();
  const bucket = {
    async put(key, bytes) {
      objects.set(key, new Uint8Array(bytes));
    },
    async get(key) {
      return objects.has(key) ? { body: objects.get(key) } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const handler = captureHandler(db, bucket);
  async function call(
    action,
    data,
    { user = 'doctor-a', token, origin = 'https://demo.test' } = {},
  ) {
    const headers = { 'X-Capture-Action': '1', origin };
    if (user) headers['oai-authenticated-user-id'] = user;
    if (token) headers['x-device-token'] = token;
    if (data !== undefined && !(data instanceof FormData))
      headers['content-type'] = 'application/json';
    return handler(
      new Request(`https://demo.test/api/capture?action=${action}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers,
        body:
          data === undefined
            ? undefined
            : data instanceof FormData
              ? data
              : JSON.stringify(data),
      }),
    );
  }
  async function connect() {
    const response = await call('connect', { category: 'exam' });
    assert.equal(response.status, 201);
    return response.json();
  }
  async function upload(
    p,
    {
      id = crypto.randomUUID(),
      bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      type = 'image/png',
      name = 'exame-ficticio.png',
      user,
      token = p.token,
    } = {},
  ) {
    const form = new FormData();
    form.set('requestId', p.request.id);
    form.set('uploadId', id);
    form.set('file', new File([bytes], name, { type }));
    return call('upload', form, { user, token });
  }
  return { sql, db, objects, bucket, call, connect, upload };
}
