import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const clinic = 'aaaaaaaa-0000-4000-8000-000000000001';
const user = 'bbbbbbbb-0000-4000-8000-000000000001';
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${user}'::uuid $$;
    create table auth.users(id uuid primary key);
    create type public.clinic_role as enum ('owner','doctor','secretary');
    create table public.clinics(id uuid primary key);
    create table public.patients(clinic_id uuid,id text,name text,social_name text,primary key(clinic_id,id));
    create table public.consultations(id uuid primary key,clinic_id uuid,patient_id text);
    create function public.has_clinic_role(c uuid, roles public.clinic_role[]) returns boolean language sql as $$ select true $$;
    create function public.record_change() returns trigger language plpgsql as $$ begin return new; end $$;
    insert into public.clinics values('${clinic}');
    insert into auth.users values('${user}');
    insert into public.patients values('${clinic}','patient','Paciente teste','');
  `);
  for (const file of ['20260912060000_documents.sql','20260921010000_optional_prescription_date.sql'])
    await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  const write = async d => (await db.query('select public.document_write($1,$2::jsonb) as doc', [clinic, JSON.stringify(d)])).rows[0].doc;
  for (const date of ['', null, undefined, '2026-09-21']) {
    const draft = { id: crypto.randomUUID(), patient_id: 'patient', kind: 'Receita', text: 'Teste', physician_name: 'Teste', physician_registration: '', document_date: date, version: 0 };
    const saved = await write(draft);
    assert.equal(saved.document_date, date || null);
    assert.equal((await write(draft)).version, 1, 'Repeated create stays idempotent without date');
    const dated = await write({ ...saved, document_date: '2026-09-22' });
    const cleared = await write({ ...dated, document_date: '' });
    assert.equal(cleared.document_date, null);
    await assert.rejects(() => write({ ...cleared, kind: 'Atestado' }), /clinical_documents_date_required/);
    await assert.rejects(() => write({ ...cleared, document_date: 'invalid' }), /date/);
  }
  console.log('PASS: receitas sem data, reenvio, edição e exigência de data nos demais documentos.');
} finally { await db.close(); }
