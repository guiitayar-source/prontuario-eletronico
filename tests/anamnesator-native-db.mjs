import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const db = new PGlite();
const c = 'aaaaaaaa-0000-4000-8000-000000000001',
  other = 'aaaaaaaa-0000-4000-8000-000000000002';
const doctor = 'bbbbbbbb-0000-4000-8000-000000000001',
  secretary = 'bbbbbbbb-0000-4000-8000-000000000002';
const visit = crypto.randomUUID(),
  foreign = crypto.randomUUID();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const pair = hash('synthetic-pair'),
  device = hash('synthetic-device');
let checks = 0;
const reject = async (promise) => {
  await assert.rejects(promise);
  checks++;
};
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
 insert into public.patients values('${c}','p','Paciente sintético'),('${other}','other-p','Outro paciente');
 insert into public.consultations(id,clinic_id,patient_id,author_id,text) values('${visit}','${c}','p','${doctor}','Evolução manual preservada'),('${foreign}','${other}','other-p','${doctor}','');
 `);
  await db.exec(
    await readFile(
      new URL(
        '../supabase/migrations/20261012010000_anamnesator_native.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const asDoctor = () =>
    db.exec(`reset role; set role authenticated; set test.uid='${doctor}';`);
  const create = async (consultation = visit) => {
    const id = crypto.randomUUID();
    const rows = (
      await db.query(
        "select public.anamnesator_request($1,'create',$2::jsonb) as r",
        [
          c,
          JSON.stringify({
            id,
            consultation_id: consultation,
            pair_hash: pair,
          }),
        ],
      )
    ).rows;
    assert.equal(rows[0].r.id, id);
    checks++;
    assert.equal('pair_hash' in rows[0].r, false);
    return id;
  };
  const claim = (id, p = pair, d = device) =>
    db.query('select public.anamnesator_native_claim($1,$2,$3) as r', [
      id,
      p,
      d,
    ]);
  const result = (
    id,
    d = device,
    revision = 1,
    transcription = 'Transcrição sintética',
    draft = '',
  ) =>
    db.query('select public.anamnesator_native_result($1,$2,$3::jsonb) as r', [
      id,
      d,
      JSON.stringify({ revision, transcription, draft }),
    ]);
  await asDoctor();
  const desktopId = crypto.randomUUID();
  const desktop = (d) =>
    db.query(
      "select public.anamnesator_request($1,'desktop_result',$2::jsonb) as r",
      [c, JSON.stringify(d)],
    );
  const desktopData = {
    id: desktopId,
    consultation_id: visit,
    revision: 1,
    transcription: 'Texto do notebook',
    draft: '',
  };
  await desktop(desktopData);
  checks++;
  await desktop({ ...desktopData, revision: 2, draft: 'Rascunho do notebook' });
  checks++;
  await desktop(desktopData);
  assert.equal(
    (
      await db.query(
        'select revision from public.anamnesator_requests where id=$1',
        [desktopId],
      )
    ).rows[0].revision,
    2,
  );
  checks++;
  await reject(
    desktop({ ...desktopData, consultation_id: foreign, revision: 3 }),
  );
  await db.exec('reset role; set role service_role;');
  await reject(claim(desktopId, '0'.repeat(64)));
  await asDoctor();
  const first = await create();
  await reject(create(foreign));
  await reject(claim(first)); // native functions are never callable by an authenticated browser.
  await reject(db.query('select pair_hash from public.anamnesator_requests'));
  await db.exec(`set test.strong='false';`);
  await reject(create());
  await db.exec(`set test.strong='true'; set test.uid='${secretary}';`);
  await reject(create());
  assert.equal(
    (await db.query('select id from public.anamnesator_requests')).rows.length,
    0,
  );
  checks++;
  await db.exec('reset role; set role service_role;');
  await reject(claim(first, hash('wrong-pair')));
  const linked = (await claim(first)).rows[0].r;
  assert.equal(linked.consultation_id, visit);
  checks++;
  assert.equal((await claim(first)).rows[0].r.id, first);
  checks++; // lost-response retry.
  await reject(claim(first, pair, hash('different-device')));
  await reject(result(first, hash('wrong-device')));
  assert.equal((await result(first)).rows[0].r.revision, 1);
  checks++;
  assert.equal((await result(first)).rows[0].r.revision, 1);
  checks++; // repeated delivery.
  await reject(result(first, device, 1, 'Conflicting content'));
  await result(first, device, 2, 'Texto revisado', 'Rascunho sintético');
  assert.equal((await result(first, device, 1)).rows[0].r.revision, 2);
  checks++; // stale retry cannot overwrite.
  await reject(result(first, device, 3, 'x'.repeat(100001)));
  await reject(
    db.query('select public.anamnesator_native_result($1,$2,$3::jsonb)', [
      first,
      device,
      JSON.stringify({
        revision: 3,
        transcription: 'text',
        draft: '',
        audio: 'forbidden',
      }),
    ]),
  );
  await db.exec('reset role;');
  assert.equal(
    (
      await db.query('select text from public.consultations where id=$1', [
        visit,
      ])
    ).rows[0].text,
    'Evolução manual preservada',
  );
  checks++;
  assert.equal(
    (
      await db.query(
        'select transcription from public.anamnesator_requests where id=$1',
        [first],
      )
    ).rows[0].transcription,
    'Texto revisado',
  );
  checks++;
  await db.query(
    "update public.anamnesator_requests set device_expires_at=now()-interval '1 second' where id=$1",
    [first],
  );
  await db.exec('set role service_role;');
  await reject(result(first, device, 3));
  await asDoctor();
  const second = await create();
  await db.exec('reset role;');
  await db.query(
    "update public.anamnesator_requests set pair_expires_at=now()-interval '1 second' where id=$1",
    [second],
  );
  await db.exec('set role service_role;');
  await reject(claim(second));
  await asDoctor();
  const third = await create();
  await db.exec('reset role; set role service_role;');
  await claim(third);
  await asDoctor();
  await db.query("select public.anamnesator_request($1,'cancel',$2::jsonb)", [
    c,
    JSON.stringify({ id: third }),
  ]);
  await db.exec('reset role; set role service_role;');
  await reject(result(third));
  await asDoctor();
  const fourth = await create();
  await db.exec('reset role; set role service_role;');
  await claim(fourth);
  await db.exec('reset role;');
  await db.query('delete from public.clinic_members where user_id=$1', [
    doctor,
  ]);
  await db.exec('set role service_role;');
  await reject(result(fourth));
  console.log(
    'Anamnesator: ' +
      checks +
      ' database authorization/retry/isolation checks passed.',
  );
} finally {
  await db.close();
}
