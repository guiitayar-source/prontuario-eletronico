import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const clinicA = 'aaaaaaaa-0000-4000-8000-000000000001';
const clinicB = 'aaaaaaaa-0000-4000-8000-000000000002';
const ownerUser = 'bbbbbbbb-0000-4000-8000-000000000001';
const doctorUser = 'bbbbbbbb-0000-4000-8000-000000000002';
const secretaryUser = 'bbbbbbbb-0000-4000-8000-000000000003';
const otherUser = 'bbbbbbbb-0000-4000-8000-000000000004';

try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create table auth.users(id uuid primary key);
    create type public.clinic_role as enum ('owner','doctor','secretary');
    create table public.clinics(id uuid primary key);
    create table public.clinic_members(clinic_id uuid, user_id uuid, role public.clinic_role);
    create table public.patients(clinic_id uuid, id text, primary key(clinic_id, id));
    create table public.capture_requests(clinic_id uuid, id text primary key);
    create type public.attachment_category as enum ('pending','exam','report','other');
    create table public.attachments(
      id text primary key,
      clinic_id uuid not null,
      request_id text not null,
      patient_id text not null,
      name text not null,
      mime text not null,
      size bigint not null,
      storage_path text not null unique,
      category public.attachment_category not null default 'pending',
      created_at timestamptz not null default now(),
      archived_at timestamptz,
      archived_by uuid
    );
    create table public.audit_events(clinic_id uuid, actor_id uuid, action text, entity_type text, entity_id text, occurred_at timestamptz default now());

    create function public.is_clinic_member(c uuid) returns boolean language sql security definer stable as $$
      select exists(select 1 from public.clinic_members where clinic_id=c and user_id=auth.uid()) $$;
    create function public.has_clinic_role(c uuid, roles public.clinic_role[]) returns boolean language sql security definer stable as $$
      select exists(select 1 from public.clinic_members where clinic_id=c and user_id=auth.uid() and role=any(roles)) $$;
    create function public.record_change() returns trigger language plpgsql security definer as $$ begin
      if auth.uid() is not null then
        insert into public.audit_events(clinic_id, actor_id, action, entity_type, entity_id)
        values(coalesce(new.clinic_id, old.clinic_id), auth.uid(), lower(tg_op), tg_table_name, coalesce(new.id, old.id)::text);
      end if;
      return coalesce(new, old);
    end $$;

    create trigger attachments_audit after insert or update or delete on public.attachments
      for each row execute function public.record_change();

    create function public.fhir_snapshot(c uuid,p text) returns jsonb language sql as $$ select jsonb_build_object('patient',p) $$;

    create function public.capture_internal(c uuid, action text, d jsonb default '{}', device_token text default null)
    returns jsonb language plpgsql security definer as $$
    begin
      return jsonb_build_object('internal', true);
    end $$;

    grant usage on schema public,auth to authenticated;
    grant select on public.clinic_members, public.attachments, public.audit_events to authenticated;

    insert into public.clinics values('${clinicA}'), ('${clinicB}');
    insert into auth.users values('${ownerUser}'), ('${doctorUser}'), ('${secretaryUser}'), ('${otherUser}');
    insert into public.clinic_members values
      ('${clinicA}', '${ownerUser}', 'owner'),
      ('${clinicA}', '${doctorUser}', 'doctor'),
      ('${clinicA}', '${secretaryUser}', 'secretary'),
      ('${clinicB}', '${otherUser}', 'doctor');

    insert into public.patients values('${clinicA}', 'p1'), ('${clinicB}', 'p2');
    insert into public.capture_requests values('${clinicA}', 'req1');

    insert into public.attachments(id, clinic_id, request_id, patient_id, name, mime, size, storage_path, category)
    values
      ('att-test', '${clinicA}', 'req1', 'p1', 'foto-teste.jpg', 'image/jpeg', 1024, '${clinicA}/att-test.jpg', 'exam'),
      ('att-exam', '${clinicA}', 'req1', 'p1', 'foto-hemograma.jpg', 'image/jpeg', 2048, '${clinicA}/att-exam.jpg', 'exam'),
      ('att-archived', '${clinicA}', 'req1', 'p1', 'foto-antiga.jpg', 'image/jpeg', 4096, '${clinicA}/att-archived.jpg', 'exam');
    update public.attachments set archived_at = now(), archived_by = '${doctorUser}'::uuid where id = 'att-archived';
  `);

  for (const file of [
    '20260914010000_exams.sql',
    '20260914010100_exam_catalog.sql',
    '20260914010200_exam_fhir.sql',
    '20260915010000_ai_reviewed_exams.sql',
    '20260924010000_permanent_attachment_delete.sql',
  ]) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  }

  await db.exec('set role authenticated;');

  const callCapture = async (action, d, asUser, c = clinicA) => {
    await db.query(`select set_config('test.uid', $1, false)`, [asUser]);
    return (await db.query(`select public.capture_command($1, $2, $3::jsonb) as res`, [c, action, JSON.stringify(d)])).rows[0].res;
  };

  const writeExam = async (d, asUser, c = clinicA) => {
    await db.query(`select set_config('test.uid', $1, false)`, [asUser]);
    return (await db.query(`select public.exam_write($1, 'result', $2::jsonb) as record`, [c, JSON.stringify(d)])).rows[0].record;
  };

  // 1. Doctor tries to purge 'att-test' which has NO exam results filled yet
  await assert.rejects(
    callCapture('purge', { id: 'att-test', patientId: 'p1' }, doctorUser),
    /A exclusão definitiva pelo médico só é permitida após os exames/
  );

  // 2. Owner (admin) CAN purge 'att-test' without exam results (freeing space)
  const ownerPurgeResult = await callCapture('purge', { id: 'att-test', patientId: 'p1' }, ownerUser);
  assert.equal(ownerPurgeResult.id, 'att-test');
  const attTestQuery = await db.query("select * from public.attachments where id = 'att-test'");
  assert.equal(attTestQuery.rows.length, 0, 'att-test must be physically deleted from attachments');

  // Verify audit event was recorded for att-test deletion
  const auditTest = await db.query("select * from public.audit_events where entity_type = 'attachments' and entity_id = 'att-test' and action = 'delete'");
  assert.equal(auditTest.rows.length, 1);
  assert.equal(auditTest.rows[0].actor_id, ownerUser);

  // 3. Fill an exam result referencing 'att-exam'
  const def = (await db.query("select id from public.exam_definitions where name = 'AST / TGO' limit 1")).rows[0];
  const examId = crypto.randomUUID();
  await writeExam({
    id: examId,
    patient_id: 'p1',
    definition_id: def.id,
    collected_on: '2026-09-24',
    values: {
      value: { value: '20,5', unit: 'U/L', reference: '10–40' },
    },
    attachment_id: 'att-exam',
    source: 'ai_reviewed',
    provenance: {
      attachment_id: 'att-exam',
      provider: 'google',
      model: 'gemini-2.5-flash',
      extracted_at: new Date().toISOString(),
      reviewed_at: new Date().toISOString(),
    },
  }, doctorUser);

  // 4. Now that exam is filled, Doctor CAN purge 'att-exam'
  const doctorPurgeResult = await callCapture('purge', { id: 'att-exam', patientId: 'p1' }, doctorUser);
  assert.equal(doctorPurgeResult.id, 'att-exam');
  const attExamQuery = await db.query("select * from public.attachments where id = 'att-exam'");
  assert.equal(attExamQuery.rows.length, 0, 'att-exam must be physically deleted from attachments');

  // Verify exam_results kept the record and attachment_id was set null by on delete set null
  const savedExam = (await db.query("select * from public.exam_results where id = $1", [examId])).rows[0];
  assert.equal(savedExam.attachment_id, null, 'attachment_id should be set to null on exam_results');
  assert.equal(savedExam.provenance.attachment_id, 'att-exam', 'provenance JSON keeps the original attachment reference');
  assert.equal(savedExam.values.value.value, '20,5', 'clinical values are preserved');

  // Verify audit event for doctor's purge
  const auditDoctor = await db.query("select * from public.audit_events where entity_type = 'attachments' and entity_id = 'att-exam' and action = 'delete'");
  assert.equal(auditDoctor.rows.length, 1);
  assert.equal(auditDoctor.rows[0].actor_id, doctorUser);

  // 5. Secretary cannot purge attachments
  await assert.rejects(
    callCapture('purge', { id: 'att-archived', patientId: 'p1' }, secretaryUser),
    /insufficient_privilege/
  );

  // 6. User from other clinic cannot purge
  await assert.rejects(
    callCapture('purge', { id: 'att-archived', patientId: 'p1' }, otherUser),
    /insufficient_privilege/
  );

  // 7. Owner can purge already archived attachment
  const purgeArchivedResult = await callCapture('purge', { id: 'att-archived', patientId: 'p1' }, ownerUser);
  assert.equal(purgeArchivedResult.id, 'att-archived');
  const attArchivedQuery = await db.query("select * from public.attachments where id = 'att-archived'");
  assert.equal(attArchivedQuery.rows.length, 0);

  console.log('PASS: permanent attachment deletion (owner permissions, doctor exam-filled condition, cascade set null, audit trail).');
} finally {
  await db.close();
}
