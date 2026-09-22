import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteConnection } from '../scripts/backup-connection.mjs';

const api = 'https://syntheticproject.supabase.co';
const direct = 'postgresql://postgres:synthetic-password@db.syntheticproject.supabase.co:5432/postgres';
const session = 'postgresql://postgres.syntheticproject:synthetic-password@aws-0-sa-east-1.pooler.supabase.com:5432/postgres';

test('accepts project-matched direct and session connections with mandatory TLS', () => {
  for (const uri of [direct, session, session.replace('postgresql:', 'postgres:')]) {
    const env = remoteConnection(api, uri);
    assert.equal(env.PGPORT, '5432');
    assert.equal(env.PGSSLMODE, 'require');
    assert.equal(env.PGCONNECT_TIMEOUT, '15');
  }
  assert.equal(remoteConnection(api, session.replace('synthetic-password', 'secret%40value')).PGPASSWORD, 'secret@value');
  assert.equal(remoteConnection(api, session + '?sslmode=disable').PGSSLMODE, 'require');
  const copied = session.replace('synthetic-password', '[YOUR-PASSWORD]');
  assert.equal(remoteConnection(api, copied, 'literal @/# database password').PGPASSWORD, 'literal @/# database password');
});

test('rejects cross-project credentials, unrelated hosts, transaction mode and malformed URLs without leaking secrets', () => {
  const invalid = [
    direct.replace('db.syntheticproject', 'db.otherproject'),
    session.replace('postgres.syntheticproject', 'postgres.otherproject'),
    session.replace(':5432', ':6543'),
    session.replace('pooler.supabase.com', 'pooler.supabase.com.attacker.invalid'),
    session.replace('aws-0-sa-east-1.pooler.supabase.com', '127.0.0.1'),
    session.replace('postgresql:', 'https:'),
    session.replace('/postgres', '/anotherdb'),
    session.replace('synthetic-password', ''),
    session.replace('synthetic-password', '[YOUR-PASSWORD]'),
    session.replace('synthetic-password', '%00'),
    session.replace('synthetic-password', '%ZZ'),
    'invalid',
  ];
  for (const uri of invalid) assert.throws(() => remoteConnection(api, uri), (error) => {
    assert.ok(!error.message.includes('synthetic-password'));
    return /mesmo projeto/.test(error.message);
  });
  assert.throws(() => remoteConnection('https://syntheticproject.supabase.co.attacker.invalid', session));
  assert.throws(() => remoteConnection(api, session, 'password\nwith-control-character'));
});
