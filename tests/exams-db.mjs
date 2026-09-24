// Actual PostgreSQL execution in WASM; auth/storage scaffolding is synthetic.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const db = new PGlite();
const clinic = 'aaaaaaaa-0000-4000-8000-000000000001';
const other = 'aaaaaaaa-0000-4000-8000-000000000002';
const doctor = 'bbbbbbbb-0000-4000-8000-000000000001';
const secretary = 'bbbbbbbb-0000-4000-8000-000000000002';
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create table auth.users(id uuid primary key);
    create type public.clinic_role as enum ('owner','doctor','secretary');
    create table public.clinics(id uuid primary key);
    create table public.clinic_members(clinic_id uuid,user_id uuid,role public.clinic_role);
    create table public.patients(clinic_id uuid,id text,primary key(clinic_id,id));
    create table public.attachments(id text primary key,clinic_id uuid,patient_id text,archived_at timestamptz);
    create table public.audit_events(clinic_id uuid,actor_id uuid,action text,entity_type text,entity_id text);
    create function public.has_clinic_role(c uuid, roles public.clinic_role[]) returns boolean language sql security definer stable as $$
      select coalesce(current_setting('test.strong',true),'true')<>'false' and exists(select 1 from public.clinic_members where clinic_id=c and user_id=auth.uid() and role=any(roles)) $$;
    create function public.record_change() returns trigger language plpgsql security definer as $$ begin
      if auth.uid() is not null then insert into public.audit_events values(new.clinic_id,auth.uid(),'insert',tg_table_name,new.id::text); end if; return new; end $$;
    create function public.fhir_snapshot(c uuid,p text) returns jsonb language sql as $$ select jsonb_build_object('patient',p) $$;
    create function public.is_clinic_member(c uuid) returns boolean language sql as $$ select true $$;
    create function public.capture_internal(c uuid, action text, d jsonb default '{}', device_token text default null) returns jsonb language sql as $$ select '{}'::jsonb $$;
    grant usage on schema public,auth to authenticated;
    grant select on public.clinic_members to authenticated;
    insert into public.clinics values('${clinic}'),('${other}');
    insert into auth.users values('${doctor}'),('${secretary}');
    insert into public.clinic_members values('${clinic}','${doctor}','doctor'),('${clinic}','${secretary}','secretary');
    insert into public.patients values('${clinic}','p'),('${other}','other-p');
    insert into public.attachments values('valid','${clinic}','p',null),('foreign','${other}','other-p',null);
  `);
  for (const file of [
    '20260914010000_exams.sql',
    '20260914010100_exam_catalog.sql',
    '20260914010200_exam_fhir.sql',
    '20260915010000_ai_reviewed_exams.sql',
    '20260924010000_permanent_attachment_delete.sql',
  ])
    await db.exec(
      await readFile(
        new URL('../supabase/migrations/' + file, import.meta.url),
        'utf8',
      ),
    );
  await db.exec(`set role authenticated; set test.uid='${doctor}';`);
  const catalog = (await db.query('select * from public.exam_definitions'))
    .rows;
  assert.equal(catalog.length, 25);
  const definition = catalog.find((d) => d.name === 'AST / TGO');
  const write = (action, d, c = clinic) =>
    db.query('select public.exam_write($1,$2,$3::jsonb) as record', [
      c,
      action,
      JSON.stringify(d),
    ]);
  const base = {
    id: crypto.randomUUID(),
    patient_id: 'p',
    definition_id: definition.id,
    collected_on: '2026-09-14',
    values: { value: { value: '20,5', unit: 'U/L', reference: '10–40' } },
    attachment_id: 'valid',
  };
  await write('result', base);
  assert.equal(
    (await db.query('select * from public.exam_results')).rows.length,
    1,
  );
  await assert.rejects(
    write('result', {
      ...base,
      id: crypto.randomUUID(),
      attachment_id: 'foreign',
    }),
  );
  await assert.rejects(
    write('result', {
      ...base,
      id: crypto.randomUUID(),
      patient_id: 'other-p',
    }),
  );
  await assert.rejects(
    write('result', {
      ...base,
      id: crypto.randomUUID(),
      collected_on: '2026-02-30',
    }),
  );
  await assert.rejects(
    write('result', {
      ...base,
      id: crypto.randomUUID(),
      values: { invalid: { value: '2', unit: '', reference: '' } },
    }),
  );
  await assert.rejects(
    write('result', {
      ...base,
      id: crypto.randomUUID(),
      values: { value: { value: '1.234,5', unit: 'U/L', reference: '' } },
    }),
  );
  await assert.rejects(db.exec('delete from public.exam_results'));
  await assert.rejects(
    db.exec("update public.exam_results set notes='changed'"),
  );
  await assert.rejects(
    write('result', { ...base, id: crypto.randomUUID() }, other),
  );
  const correction = {
    ...base,
    id: crypto.randomUUID(),
    supersedes_id: base.id,
    correction_reason: 'Correção de transcrição',
  };
  await write('result', correction);
  await assert.rejects(
    write('result', { ...correction, id: crypto.randomUUID() }),
  );
  const reviewed = {
    ...base,
    id: crypto.randomUUID(),
    source: 'ai_reviewed',
    provenance: {
      attachment_id: 'valid',
      provider: 'OpenAI',
      model: 'test-model',
      extracted_at: '2026-09-15T00:00:00Z',
      reviewed_at: '2026-09-15T00:01:00Z',
    },
  };
  await write('result', reviewed);
  assert.equal(
    (
      await db.query('select source from public.exam_results where id=$1', [
        reviewed.id,
      ])
    ).rows[0].source,
    'ai_reviewed',
  );
  await assert.rejects(
    write('result', {
      ...reviewed,
      id: crypto.randomUUID(),
      provenance: {},
    }),
  );
  const custom = {
    id: crypto.randomUUID(),
    name: 'Exame personalizado',
    aliases: ['teste'],
    fields: [
      {
        id: 'value',
        name: 'Resultado',
        type: 'choice',
        unit: '',
        options: ['Reagente', 'Não reagente'],
      },
    ],
  };
  await write('definition', custom);
  await assert.rejects(
    write('definition', {
      ...custom,
      id: crypto.randomUUID(),
      name: 'Duplicado',
      fields: [...custom.fields, ...custom.fields],
    }),
  );
  await assert.rejects(
    write('result', {
      ...base,
      id: crypto.randomUUID(),
      definition_id: custom.id,
    }),
  );
  const snapshot = (
    await db.query('select public.fhir_snapshot($1,$2) as s', [clinic, 'p'])
  ).rows[0].s;
  assert.equal(snapshot.exam_results.length, 3);
  assert.equal(snapshot.exam_definitions.length, 1);
  await assert.rejects(
    db.query('select public.fhir_snapshot_before_exams($1,$2)', [clinic, 'p']),
  );
  await db.exec("set test.strong='false'");
  assert.equal(
    (await db.query('select * from public.exam_results')).rows.length,
    0,
  );
  await assert.rejects(write('result', { ...base, id: crypto.randomUUID() }));
  await db.exec(`set test.strong='true'; set test.uid='${secretary}'`);
  assert.equal(
    (await db.query('select * from public.exam_results')).rows.length,
    0,
  );
  assert.equal(
    (await db.query('select * from public.exam_definitions')).rows.length,
    0,
  );
  await assert.rejects(write('result', { ...base, id: crypto.randomUUID() }));
  await db.exec('reset role');
  assert.equal(
    (await db.query('select * from public.audit_events')).rows.length,
    4,
  );
  console.log(
    'Exams SQL: catalog, persistence, RLS, MFA guard, correction conflicts, attachment scope, validation, audit and FHIR passed.',
  );
} finally {
  await db.close();
}
