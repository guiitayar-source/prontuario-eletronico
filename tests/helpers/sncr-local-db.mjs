// Adaptador de teste para PostgreSQL REAL via psql. Não emula o banco.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { containerEngine, containerImage } from './sncr-container.mjs';
export function createSncrDb({ signatureIdentityGuard = false } = {}) {
  const inspect = JSON.parse(
    execFileSync(containerEngine, ['inspect', 'psywrite-sncr-3a-disposable'], {
      encoding: 'utf8',
    }),
  )[0];
  assert.equal(inspect.HostConfig.NetworkMode, 'none');
  assert.equal(inspect.Mounts.length, 0);
  assert.equal(inspect.State.Running, true);
  assert.equal(
    inspect.Config.Image,
    containerImage,
  );
  const container = inspect.Id,
    database = `sncr_3b_test_${randomUUID().replaceAll('-', '')}`;
  const args = (db = database) => [
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
  ];
  function sql(s, role = 'postgres', db = database) {
    return execFileSync(containerEngine, args(db), {
      input: `set role ${role}; set statement_timeout='15s'; ${s}`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 25000,
    }).trim();
  }
  function asyncSql(s, role = 'service_role') {
    return new Promise((resolve, reject) => {
      const p = spawn(containerEngine, args());
      let out = '',
        err = '';
      const timer = setTimeout(() => {
        p.kill();
        reject(Error('Teste excedeu tempo limite'));
      }, 25000);
      p.stdout.on('data', (x) => (out += x));
      p.stderr.on('data', (x) => (err += x));
      p.on('error', reject);
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code) reject(Object.assign(Error(err), { stderr: err }));
        else resolve(out.trim());
      });
      p.stdin.end(`set role ${role}; set statement_timeout='15s'; ${s}`);
    });
  }
  const lit = (v) =>
    v === null
      ? 'null'
      : typeof v === 'boolean' || typeof v === 'number'
        ? String(v)
        : `'${(typeof v === 'object' ? JSON.stringify(v) : String(v)).replaceAll("'", "''")}'`;
  function statement(name, params) {
    assert.match(name, /^sncr_[a-z_]+$/);
    return `select public.${name}(${Object.entries(params)
      .map(([k, v]) => {
        assert.match(k, /^p_[a-z_]+$/);
        return `${k} => ${lit(v)}`;
      })
      .join(',')});`;
  }
  let finishTimeout = false;
  const db = {
    rpc: async (name, params) => {
      try {
        const query = statement(name, params);
        // Timeout REAL no PostgreSQL: transação inteira é desfeita, após a tentativa de conclusão.
        const timeout = finishTimeout && name === 'sncr_finish_signing';
        if (timeout) finishTimeout = false;
        const out = await asyncSql(
          timeout
            ? `set statement_timeout='100ms'; begin; ${query} select pg_sleep(1); commit;`
            : query,
        );
        return { data: JSON.parse(out), error: null };
      } catch (e) {
        const message = String(e.stderr || e.message);
        return {
          data: null,
          error: {
            code: message.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1],
            message,
          },
        };
      }
    },
  };
  sql(
    `create database ${database} owner postgres template template0;`,
    'supabase_admin',
    'postgres',
  );
  const cleanup = () =>
    sql(
      `drop database ${database} with (force);`,
      'supabase_admin',
      'postgres',
    );
  try {
    sql(`create schema auth; grant usage on schema public to anon,authenticated,service_role;
   create table auth.users(id uuid primary key);
   create table clinics(id uuid primary key);
   create type clinic_role as enum ('owner','doctor','secretary');
   create table clinic_members(clinic_id uuid references clinics,user_id uuid references auth.users,role clinic_role not null,primary key(clinic_id,user_id));
   create table document_profiles(clinic_id uuid references clinics,user_id uuid references auth.users,physician_registration text not null,primary key(clinic_id,user_id));
   create table clinical_documents(id uuid primary key,clinic_id uuid not null references clinics,author_id uuid not null references auth.users,patient_id text not null,kind text not null,status text not null default 'DRAFT',physician_registration text not null,version integer not null,text text not null,document_date date,patient_name text not null,physician_name text not null,consultation_id uuid,signed_pdf_path text,updated_at timestamptz default now());
   create table audit_events(id bigint generated always as identity primary key,clinic_id uuid not null references clinics,actor_id uuid not null references auth.users,action text not null,entity_type text not null,entity_id text not null,context jsonb not null);`);
    const signingMigration = readFileSync(
      new URL(
        '../../supabase/migrations/20260925010000_digital_signatures.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const signatureTable = signingMigration.match(
      /create table if not exists public\.digital_signatures \([\s\S]*?\n\);/,
    )[0];
    sql(signatureTable);
    sql(
      "alter table document_profiles add column letterhead_title text default '',add column letterhead_address text default '',add column letterhead_phone text default ''; create table patients(clinic_id uuid,id text,cpf text,street text,address_number text,complement text,neighborhood text,city text,state text,primary key(clinic_id,id)); grant select on public.clinical_documents,public.document_profiles,public.patients to service_role;",
    );
    const original = readFileSync(
      new URL(
        '../../supabase/migrations/20261027010000_sncr_numbering.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const guard =
      "do $$ begin\n raise exception 'Migração SNCR em revisão: não aplicar';\nend $$;";
    assert.equal(original.split(guard).length, 2);
    sql(
      `begin; ${original.replace(guard, '-- somente cópia descartável')} commit;`,
    );
    if (signatureIdentityGuard) {
      // Coexistência com o gatilho de imutabilidade já existente, sem reescrevê-lo.
      const immutable = signingMigration.match(/create or replace function public\.check_clinical_document_immutable\(\)[\s\S]*?\$\$;/)?.[0];
      const immutableTrigger = signingMigration.match(/create trigger trg_check_clinical_document_immutable[\s\S]*?execute function public\.check_clinical_document_immutable\(\);/)?.[0];
      assert.ok(immutable && immutableTrigger);
      sql(immutable + '\n' + immutableTrigger);
      const identity = readFileSync(new URL('../../supabase/migrations/20261028020000_signature_identity_guard.sql', import.meta.url), 'utf8');
      const identityGuard = "do $$ begin\n raise exception 'Migração de identidade de assinatura em revisão: não aplicar';\nend $$;";
      assert.equal(identity.split(identityGuard).length, 2);
      sql(`begin; ${identity.replace(identityGuard, '-- somente cópia descartável')} commit;`);
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  const applicationDb = {
    ...db,
    from: (table) => {
      assert.ok(
        ['clinical_documents', 'patients', 'document_profiles'].includes(table),
      );
      const filters = [];
      const query = {
        select: () => query,
        eq: (column, value) => {
          assert.ok(['id', 'clinic_id', 'user_id'].includes(column));
          filters.push(`${column}=${lit(value)}`);
          return query;
        },
        maybeSingle: async () => {
          try {
            return {
              data: JSON.parse(
                await asyncSql(
                  `select coalesce((select to_jsonb(d) from ${table} d where ${filters.join(' and ')}),'null'::jsonb);`,
                ),
              ),
              error: null,
            };
          } catch (e) {
            return { data: null, error: { message: e.message } };
          }
        },
      };
      return query;
    },
  };
  return {
    db,
    applicationDb,
    sql,
    asyncSql,
    statement,
    lit,
    cleanup,
    container,
    timeoutFinish: () => {
      finishTimeout = true;
    },
  };
}
