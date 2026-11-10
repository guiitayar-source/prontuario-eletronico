import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const c = 'aaaaaaaa-0000-4000-8000-000000000001',
  other = 'aaaaaaaa-0000-4000-8000-000000000002';
const owner = 'bbbbbbbb-0000-4000-8000-000000000001',
  doctor = 'bbbbbbbb-0000-4000-8000-000000000002',
  secretary = 'bbbbbbbb-0000-4000-8000-000000000003';
const med = 'cccccccc-0000-4000-8000-000000000001';
const db = new PGlite();
const migration = async (name) =>
  db.exec(
    await readFile(
      new URL('../supabase/migrations/' + name, import.meta.url),
      'utf8',
    ),
  );
const user = (id) =>
  db.exec(
    `reset role; select set_config('test.uid','${id}',false); set role authenticated;`,
  );
const admin = () => db.exec('reset role;');
const review = (state, version, clinic = c) =>
  db.query('select public.medication_review_write($1,$2) as result', [
    clinic,
    { patient_id: 'p', state, version },
  ]);
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create type public.clinic_role as enum ('owner','doctor','secretary');
    create table public.clinics(id uuid primary key);
    create table public.clinic_members(clinic_id uuid,user_id uuid,role public.clinic_role);
    create table public.patients(clinic_id uuid,id text,name text,social_name text,primary key(clinic_id,id));
    create function public.has_clinic_role(c uuid,roles public.clinic_role[]) returns boolean language sql security definer stable as $$ select exists(select 1 from public.clinic_members where clinic_id=c and user_id=auth.uid() and role=any(roles)) $$;
    create table public.audit_events(id bigint generated always as identity primary key,clinic_id uuid,actor_id uuid,action text,entity_type text,entity_id text,occurred_at timestamptz default now(),context jsonb default '{}');
    create function public.record_change() returns trigger language plpgsql as $$ begin return coalesce(new,old); end $$;
    create table public.consultations(id uuid,clinic_id uuid,patient_id text);
    create table public.consultation_addenda(id uuid,clinic_id uuid,consultation_id uuid);
    grant usage on schema public,auth to authenticated;
    insert into public.clinics values('${c}'),('${other}');
    insert into auth.users values('${owner}'),('${doctor}'),('${secretary}');
    insert into public.clinic_members values('${c}','${owner}','owner'),('${c}','${doctor}','doctor'),('${c}','${secretary}','secretary');
    insert into public.patients values('${c}','p','Paciente Sintético',null),('${other}','p','Outra clínica',null);
  `);
  await migration('20260913010000_clinical_context.sql');
  await migration('20261104010000_medication_review.sql');
  await migration('20261104011000_audit_search.sql');
  await migration('20261104012000_backup_status.sql');
  await test('revisão exige confirmação, controla versão, invalida após edição e isola clínicas/papéis', async () => {
    await user(owner);
    assert.equal(
      (await db.query('select * from patient_medication_states')).rows.length,
      0,
    );
    assert.equal((await review('none', 0)).rows[0].result.state, 'none');
    await assert.rejects(review('none', 0), /outra janela/);
    await assert.rejects(review('known', 1), /Cadastre/);
    await db.query('select clinical_context_write($1,$2,$3)', [
      c,
      'medication',
      {
        id: med,
        patient_id: 'p',
        version: 0,
        name: 'Item sintético',
        status: 'active',
      },
    ]);
    const row = (await db.query('select * from patient_medication_states'))
      .rows[0];
    assert.equal(row.state, 'unknown');
    assert.equal(row.version, 2);
    assert.ok(row.reviewed_at);
    await assert.rejects(review('none', 2), /suspenda/);
    assert.equal((await review('known', 2)).rows[0].result.state, 'known');
    await assert.rejects(review('none', 0, other), { code: '42501' });
    await user(secretary);
    assert.equal(
      (await db.query('select * from patient_medication_states')).rows.length,
      0,
    );
    await assert.rejects(review('unknown', 3), { code: '42501' });
    await user(doctor);
    assert.equal((await review('unknown', 3)).rows[0].result.state, 'unknown');
  });
  await test('auditoria pagina além de 100, filtra todo o histórico e mantém isolamento', async () => {
    await admin();
    await db.query(
      `insert into audit_events(clinic_id,actor_id,action,entity_type,entity_id,occurred_at) select $1,$2,'update','patients','p','2026-11-02T12:00:00Z'::timestamptz from generate_series(1,205)`,
      [c, owner],
    );
    await db.query(
      "insert into audit_events(clinic_id,actor_id,action,entity_type,entity_id) values($1,$2,'update','patients','p')",
      [other, owner],
    );
    await user(owner);
    const first = (await db.query('select * from audit_search($1)', [c])).rows;
    assert.equal(first.length, 101);
    assert.ok(first.every((r) => r.clinic_id === c));
    const cursor = first[99].id;
    // Uma inserção entre páginas não duplica nem pula eventos anteriores ao cursor.
    await admin();
    await db.query(
      "insert into audit_events(clinic_id,actor_id,action,entity_type,entity_id) values($1,$2,'insert','patients','p')",
      [c, owner],
    );
    await user(owner);
    const second = (
      await db.query('select * from audit_search($1,$2)', [c, cursor])
    ).rows;
    assert.equal(second.length, 101);
    assert.equal(second[0].id, first[100].id);
    const filtered = (
      await db.query(
        "select * from audit_search($1,null,'2026-11-02T03:00:00Z','2026-11-03T03:00:00Z',$2,'Sintético','update','clinical')",
        [c, owner],
      )
    ).rows;
    assert.equal(filtered.length, 101);
    assert.ok(filtered.every((r) => r.patient_id === 'p'));
    assert.equal(
      (
        await db.query(
          "select * from audit_search($1,null,null,null,null,'inexistente')",
          [c],
        )
      ).rows.length,
      0,
    );
    await assert.rejects(db.query('select * from audit_search($1)', [other]), {
      code: '42501',
    });
    await user(secretary);
    await assert.rejects(db.query('select * from audit_search($1)', [c]), {
      code: '42501',
    });
  });
  await test('backup: só titular declara cópia de evento verificado da própria clínica', async () => {
    await admin();
    const id = 'dddddddd-0000-4000-8000-000000000001';
    await db.query(
      "insert into clinic_backup_events(id,clinic_id,kind,source,backup_at,occurred_at,verification_seconds) values($1,$2,'verified','scheduled',now()-interval '2 hours',now()-interval '1 hour',45)",
      [id, c],
    );
    await user(owner);
    const payload = {
      id: 'dddddddd-0000-4000-8000-000000000002',
      verified_event_id: id,
      copied_at: new Date(Date.now() - 60000).toISOString(),
    };
    const call = (clinic = c, d = payload) =>
      db.query('select backup_external_copy_write($1,$2) as result', [
        clinic,
        d,
      ]);
    assert.equal((await call()).rows[0].result.source, 'owner_declaration');
    assert.equal((await call()).rows[0].result.id, payload.id);
    await assert.rejects(
      call(c, {
        ...payload,
        id: crypto.randomUUID(),
        copied_at: '2999-01-01T00:00:00Z',
      }),
      /data da cópia/,
    );
    await assert.rejects(call(other), { code: '42501' });
    await assert.rejects(
      db.query(
        "insert into clinic_backup_events(id,clinic_id,kind,source,backup_at) values(gen_random_uuid(),$1,'verified','scheduled',now())",
        [c],
      ),
      { code: '42501' },
    );
    await user(doctor);
    assert.equal(
      (await db.query('select * from clinic_backup_events')).rows.length,
      0,
    );
    await assert.rejects(call(), { code: '42501' });
    await user(secretary);
    await assert.rejects(call(), { code: '42501' });
  });
} finally {
  await db.close();
}
