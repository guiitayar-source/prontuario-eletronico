// PostgreSQL real, isolado e sem .env. Reaplica os arquivos SQL históricos inteiros.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { containerEngine, containerImage } from './sncr-container.mjs';

export const trustMigration = '20261030040100_signature_trust_permissions.sql';
export const trustGuard =
  "do $$ begin\n raise exception 'Migração de permissões de assinatura em revisão: não aplicar';\nend $$;";
const migrations = new URL('../../supabase/migrations/', import.meta.url);
export const oauthMigration = '20261030040200_signature_oauth_attempts.sql';
export const oauthGuard = "do $$ begin\n raise exception 'Migração OAuth de assinatura em revisão: não aplicar';\nend $$;";
export const attemptsMigration = '20261030040300_document_signing_attempts.sql';
export const attemptsGuard = "do $$ begin\n raise exception 'Migração de tentativas de assinatura em revisão: não aplicar';\nend $$;";
export const evidenceMigration = '20261030040400_revocation_evidence.sql';
export const evidenceGuard = "do $$ begin\n raise exception 'Migração de evidências de revogação em revisão: não aplicar';\nend $$;";
export function createSignatureTrustDb({ baseline = false, oauth = false, attempts = false, revocationEvidence = false } = {}) {
  const inspect = JSON.parse(
    execFileSync(containerEngine, ['inspect', 'psywrite-sncr-3a-disposable'], {
      encoding: 'utf8',
    }),
  )[0];
  assert.equal(inspect.HostConfig.NetworkMode, 'none');
  assert.equal(inspect.Mounts.length, 0);
  assert.equal(inspect.Config.Image, containerImage);
  assert.equal(inspect.State.Running, true);
  assert.equal(inspect.Config.Labels?.['psywrite.test'], 'lote-6c');
  const container = inspect.Id;
  const database = `signature_trust_${randomUUID().replaceAll('-', '')}`;
  const lit = (value) =>
    value == null
      ? 'null'
      : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`;
  function sql(
    statement,
    { role = 'postgres', user = null, db = database } = {},
  ) {
    assert.ok(
      [
        'postgres',
        'supabase_admin',
        'anon',
        'authenticated',
        'service_role',
      ].includes(role),
    );
    return execFileSync(
      containerEngine,
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-U',
        'supabase_admin',
        '-d',
        db,
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=verbose',
        '-qAt',
      ],
      {
        input: `set role ${role}; set statement_timeout='15s'; set request.jwt.claims=${lit({ role, ...(user ? { sub: user } : {}), aal: 'aal2' })}; ${statement}`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 25000,
      },
    ).trim();
  }
  const cleanup = () =>
    sql(`drop database ${database} with (force);`, {
      role: 'supabase_admin',
      db: 'postgres',
    });
  function applyTrust() {
    const source = readFileSync(new URL(trustMigration, migrations), 'utf8');
    assert.equal(
      source.split(trustGuard).length,
      2,
      'Bloqueio da migração deve permanecer intacto.',
    );
    sql(
      `begin; ${source.replace(trustGuard, '-- somente cópia descartável')} commit;`,
    );
  }
  sql(`create database ${database} owner postgres template template0;`, {
    role: 'supabase_admin',
    db: 'postgres',
  });
  const applied = [];
  try {
    // Interfaces de auth/storage são mínimas; não emulam GoTrue nem Storage API.
    // Os papéis/BYPASSRLS vêm da imagem Supabase, não são superusuários de teste.
    sql(`create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      create table auth.sessions(id uuid primary key,user_id uuid references auth.users,not_after timestamptz);
      create table auth.mfa_factors(user_id uuid references auth.users, status text);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt()->>'sub','')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets,name text,metadata jsonb,user_metadata jsonb,unique(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema public,auth,storage to anon,authenticated,service_role;
      grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;`);
    const guards = [
      "do $$ begin\n raise exception 'Migração de identidade de assinatura em revisão: não aplicar';\nend $$;",
      "do $$ begin\n raise exception 'Migração de receitas RCE/RET em revisão: não aplicar';\nend $$;",
    ];
    const history = [];
    for (const file of readdirSync(migrations)
      .filter((f) => f.endsWith('.sql') && ![trustMigration,oauthMigration,attemptsMigration,evidenceMigration].includes(f))
      .sort()) {
      let source = readFileSync(new URL(file, migrations), 'utf8');
      for (const guard of guards)
        if (source.includes(guard)) {
          assert.equal(source.split(guard).length, 2);
          source = source.replace(guard, '-- somente cópia descartável');
        }
      history.push(`begin; ${source} commit;`);
      applied.push(file);
    }
    sql(history.join('\n'));
    if (!baseline) applyTrust();
    if (oauth) {
      const source = readFileSync(new URL(oauthMigration, migrations), 'utf8');
      assert.equal(source.split(oauthGuard).length, 2);
      sql(`begin; ${source.replace(oauthGuard, '-- somente cópia descartável')} commit;`);
    }
    if (attempts) {
      const source=readFileSync(new URL(attemptsMigration,migrations),'utf8');
      assert.equal(source.split(attemptsGuard).length,2);
      sql(`begin; ${source.replace(attemptsGuard,'-- somente cópia descartável')} commit;`);
    }
    if (revocationEvidence) {
      assert.ok(attempts, 'A migração de evidências depende da de tentativas.');
      const source=readFileSync(new URL(evidenceMigration,migrations),'utf8');
      assert.equal(source.split(evidenceGuard).length,2);
      sql(`begin; ${source.replace(evidenceGuard,'-- somente cópia descartável')} commit;`);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return { container, database, sql, lit, cleanup, applyTrust, applied };
}
