import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const clinic = 'aaaaaaaa-0000-4000-8000-000000000001';
const user = 'bbbbbbbb-0000-4000-8000-000000000001';
const other = 'bbbbbbbb-0000-4000-8000-000000000002';
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table public.current_actor(id uuid);
    insert into public.current_actor values('${user}');
    create function auth.uid() returns uuid language sql as $$ select id from public.current_actor $$;
    create table auth.users(id uuid primary key);
    create type public.clinic_role as enum ('owner','doctor','secretary');
    create table public.clinics(id uuid primary key);
    create table public.patients(clinic_id uuid,id text,name text,social_name text,primary key(clinic_id,id));
    create table public.consultations(id uuid primary key,clinic_id uuid,patient_id text);
    create table public.audit_events(clinic_id uuid,actor_id uuid,action text,entity_type text,entity_id text,context jsonb);
    create function public.has_clinic_role(c uuid, roles public.clinic_role[]) returns boolean language sql as $$ select true $$;
    create function public.record_change() returns trigger language plpgsql as $$ begin return coalesce(new,old); end $$;
    insert into public.clinics values('${clinic}');
    insert into auth.users values('${user}'),('${other}');
  `);
  for (const file of [
    '20260912060000_documents.sql',
    '20260925010000_digital_signatures.sql',
    '20260929010000_prescription_templates_profiles.sql',
  ]) {
    let sql = await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8');
    // A migração de assinaturas depende de tabelas não relevantes aqui: aplica só o trecho de document_profiles.
    if (file.startsWith('20260925')) sql = sql.slice(0, sql.indexOf('-- Trigger para garantir'));
    await db.exec(sql);
  }
  const tpl = async (action, d) =>
    (await db.query('select public.prescription_template_write($1,$2,$3::jsonb) as t', [clinic, action, JSON.stringify(d)])).rows[0].t;
  const id = crypto.randomUUID();
  const saved = await tpl('save', { id, name: ' Sertralina 50 ', text: '1) Sertralina 50 mg' });
  assert.equal(saved.name, 'Sertralina 50');
  assert.equal((await tpl('save', { id, name: 'Sertralina 50', text: 'Atualizado' })).text, 'Atualizado');
  await assert.rejects(() => tpl('save', { id: crypto.randomUUID(), name: 'sertralina 50', text: 'x' }), /mesmo nome|nome/);
  await db.exec(`update public.current_actor set id='${other}'`);
  await assert.rejects(() => tpl('save', { id, name: 'Roubo', text: 'x' }), /privilege/);
  await assert.rejects(() => tpl('delete', { id }), /não encontrado/);
  await db.exec(`update public.current_actor set id='${user}'`);
  await tpl('delete', { id });
  assert.equal((await db.query('select count(*)::int as n from public.prescription_templates')).rows[0].n, 0);

  const profile = async (d) =>
    (await db.query('select public.document_profile_write($1,$2::jsonb) as p', [clinic, JSON.stringify(d)])).rows[0].p;
  await db.exec(`insert into public.document_profiles(clinic_id,user_id,physician_name,physician_registration,cpf) values('${clinic}','${user}','Cert','', '12345678900')`);
  const p = await profile({ physician_name: 'Dra. Teste', physician_registration: 'CRM 1', letterhead_title: 'CONSULTÓRIO', letterhead_address: 'Rua A, 1', letterhead_phone: 'Tel.: 1' });
  assert.equal(p.letterhead_address, 'Rua A, 1');
  assert.equal(p.cpf, undefined, 'CPF não é devolvido');
  assert.equal((await db.query(`select cpf from public.document_profiles where user_id='${user}'`)).rows[0].cpf, '12345678900', 'CPF preservado');
  await assert.rejects(() => profile({ letterhead_title: 'x'.repeat(121) }), /tamanho/);
  console.log('PASS: modelos de receita por usuário e timbre do profissional.');
} finally {
  await db.close();
}
