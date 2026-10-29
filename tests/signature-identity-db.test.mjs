import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSncrDb } from './helpers/sncr-local-db.mjs';

const h = createSncrDb({ signatureIdentityGuard: true });
const clinic = '10000000-0000-4000-8000-000000000001';
const doctor = '20000000-0000-4000-8000-000000000001';
const doc = '30000000-0000-4000-8000-000000000001';
const original = readFileSync(new URL('../supabase/migrations/20261028020000_signature_identity_guard.sql', import.meta.url), 'utf8');
const guard = "do $$ begin\n raise exception 'Migração de identidade de assinatura em revisão: não aplicar';\nend $$;";
try {
  assert.equal(original.split(guard).length, 2);
  assert.throws(() => h.sql(original), /em revisão/);
  h.sql(`insert into auth.users values ('${doctor}'),(md5('other-doctor')::uuid); insert into clinics values ('${clinic}'),(md5('other-clinic')::uuid);
    insert into clinical_documents(id,clinic_id,author_id,patient_id,kind,status,physician_registration,version,text,patient_name,physician_name,document_date)
    values ('${doc}','${clinic}','${doctor}','synthetic','Receita','DRAFT','CRM 12345 SP',1,'Modalidade: Receita simples','Paciente sintético','Prescritor sintético','2026-10-28');
    update clinical_documents set status='SIGNING' where id='${doc}';`);
  const identityChanges = ["author_id=md5('other-doctor')::uuid", "clinic_id=md5('other-clinic')::uuid", "patient_id='other-patient'", "id=md5('other-document')::uuid", "text='alterado'", 'version=version+1', "physician_name='Outro medico'", "physician_registration='CRM 99999 SP'", "patient_name='Outro paciente'", "document_date='2026-10-27'", "consultation_id=gen_random_uuid()"];
  await test('autor, clinica, identidade, versao e vinculos ficam congelados durante SIGNING', () => {
    for (const change of identityChanges)
      assert.throws(() => h.sql(`update clinical_documents set ${change} where id='${doc}';`), /23514/);
    assert.throws(() => h.sql(`delete from clinical_documents where id='${doc}';`), /23514/);
    assert.equal(h.sql(`select status||':'||version from clinical_documents where id='${doc}';`), 'SIGNING:1');
  });
  await test('conclusao preserva versao e caminho original e recusa reinicio', () => {
    h.sql(`update clinical_documents set status='SIGNED',signed_pdf_path='synthetic/original.pdf' where id='${doc}';`);
    for (const change of ["status='SIGNING'", "status='SIGNATURE_FAILED'", "signed_pdf_path='synthetic/replacement.pdf'", 'version=version+1'])
      assert.throws(() => h.sql(`update clinical_documents set ${change} where id='${doc}';`), /23514/);
    assert.equal(h.sql(`select status||':'||version||':'||signed_pdf_path from clinical_documents where id='${doc}';`), 'SIGNED:1:synthetic/original.pdf');
  });
  await test('SIGNED preserva autor, identidade e vinculo mesmo com escrita privilegiada', () => {
    for (const change of identityChanges)
      assert.throws(() => h.sql(`update clinical_documents set ${change} where id='${doc}';`));
    assert.throws(() => h.sql(`delete from clinical_documents where id='${doc}';`), /23514/);
    assert.equal(h.sql(`select author_id::text||':'||clinic_id::text||':'||version from clinical_documents where id='${doc}';`), `${doctor}:${clinic}:1`);
    assert.equal(h.sql("select has_function_privilege('authenticated','public.signature_document_identity_guard()','execute');"), 'f');
  });
} finally {
  h.cleanup();
}
