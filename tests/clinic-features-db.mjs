// Plano por clínica em PostgreSQL de verdade (WASM); auth e clínicas são sintéticos.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const db = new PGlite();
const c = 'aaaaaaaa-0000-4000-8000-000000000001',
  other = 'aaaaaaaa-0000-4000-8000-000000000002',
  later = 'aaaaaaaa-0000-4000-8000-000000000003';
const doctor = 'bbbbbbbb-0000-4000-8000-000000000001',
  secretary = 'bbbbbbbb-0000-4000-8000-000000000002';
const visit = crypto.randomUUID();
const pair = createHash('sha256').update('synthetic-pair').digest('hex');
const migration = (file) =>
  readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8');
try {
  await db.exec(`
 create role anon; create role authenticated; create role service_role;
 create schema auth;
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
 create table auth.users(id uuid primary key);
 create type public.clinic_role as enum ('owner','doctor','secretary');
 create table public.clinics(id uuid primary key);
 create table public.clinic_members(clinic_id uuid,user_id uuid,role public.clinic_role);
 create table public.patients(clinic_id uuid,id text,name text,primary key(clinic_id,id));
 create table public.consultations(id uuid primary key,clinic_id uuid,patient_id text,author_id uuid,finalized_at timestamptz,text text default '');
 create table public.audit_events(clinic_id uuid,actor_id uuid,action text,entity_type text,entity_id text);
 create function public.has_clinic_role(c uuid, roles public.clinic_role[]) returns boolean language sql security definer stable as $$
 select coalesce(current_setting('test.strong',true),'true')<>'false' and exists(select 1 from public.clinic_members where clinic_id=c and user_id=auth.uid() and role=any(roles)) $$;
 grant usage on schema public,auth to authenticated,service_role,anon;
 insert into public.clinics values('${c}'),('${other}');
 insert into auth.users values('${doctor}'),('${secretary}');
 insert into public.clinic_members values('${c}','${doctor}','doctor'),('${c}','${secretary}','secretary');
 insert into public.patients values('${c}','p','Paciente sintético');
 insert into public.consultations(id,clinic_id,patient_id,author_id) values('${visit}','${c}','p','${doctor}');
 `);
  await db.exec(await migration('20261012010000_anamnesator_native.sql'));
  await db.exec(await migration('20261015135205_clinic_features.sql'));
  const as = (user, strong = true) =>
    db.exec(
      `reset role; set role authenticated; set test.uid='${user}'; set test.strong='${strong}';`,
    );
  const asAdmin = () => db.exec('reset role;');

  // Clínicas existentes mantêm tudo; as criadas depois começam sem nada.
  await db.exec(`insert into public.clinics values('${later}');`);
  const plans = (
    await db.query(
      'select clinic_id,features from public.clinic_features order by clinic_id',
    )
  ).rows;
  assert.deepEqual(plans, [
    { clinic_id: c, features: ['ia', 'anamnesator'] },
    { clinic_id: other, features: ['ia', 'anamnesator'] },
  ]);
  await assert.rejects(
    db.exec(
      `insert into public.clinic_features values('${later}',array['agenda_premium'])`,
    ),
  );

  // A equipe lê só o plano da própria clínica, e só com o segundo fator.
  for (const user of [doctor, secretary]) {
    await as(user);
    const rows = (
      await db.query('select clinic_id from public.clinic_features')
    ).rows;
    assert.deepEqual(rows, [{ clinic_id: c }]);
  }
  await as(doctor, false);
  assert.equal(
    (await db.query('select 1 from public.clinic_features')).rows.length,
    0,
  );

  // Ninguém da clínica muda o próprio plano, nem o proprietário.
  await db.exec(
    `reset role; insert into public.clinic_members values('${c}','${doctor}','owner');`,
  );
  await as(doctor);
  for (const sql of [
    `update public.clinic_features set features=array['ia','anamnesator'] where clinic_id='${c}'`,
    `insert into public.clinic_features values('${later}',array['ia'])`,
    `delete from public.clinic_features where clinic_id='${c}'`,
    `select public.anamnesator_requires_feature()`,
  ])
    await assert.rejects(db.exec(sql), /permission denied/);

  // Sem o Anamnesator no plano, o banco recusa até a chamada direta à função.
  const create = () =>
    db.query("select public.anamnesator_request($1,'create',$2::jsonb) as r", [
      c,
      JSON.stringify({
        id: crypto.randomUUID(),
        consultation_id: visit,
        pair_hash: pair,
      }),
    ]);
  await asAdmin();
  await db.exec(
    `update public.clinic_features set features=array['ia'] where clinic_id='${c}'`,
  );
  await as(doctor);
  await assert.rejects(create(), /não faz parte do plano/);
  await asAdmin();
  assert.equal(
    (await db.query('select 1 from public.anamnesator_requests')).rows.length,
    0,
  );
  await db.exec(
    `update public.clinic_features set features=array['anamnesator'] where clinic_id='${c}'`,
  );
  await as(doctor);
  assert.equal((await create()).rows[0].r.state, 'waiting');
  console.log(
    'Plano por clínica: leitura, bloqueio de escrita e Anamnesator validados.',
  );
} finally {
  await db.close();
}
