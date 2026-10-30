// Testes negativos com papéis efetivos PostgreSQL. Somente fixtures sintéticas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import {
  createSignatureTrustDb,
  trustMigration,
  oauthMigration,
  attemptsMigration,
  evidenceMigration,
} from './helpers/signature-trust-db.mjs';

const h = createSignatureTrustDb({
  baseline: process.env.SIGNATURE_TRUST_TEST_BASELINE === '1',
});
const clinic = '10000000-0000-4000-8000-000000000001';
const otherClinic = '10000000-0000-4000-8000-000000000002';
const doctor = '20000000-0000-4000-8000-000000000001';
const colleague = '20000000-0000-4000-8000-000000000002';
const outsider = '20000000-0000-4000-8000-000000000003';
const document = '30000000-0000-4000-8000-000000000001';
const session = '40000000-0000-4000-8000-000000000001';
const state = '50000000-0000-4000-8000-000000000001';
const signed = '60000000-0000-4000-8000-000000000001';
const actor = { role: 'authenticated', user: doctor };
const signature = {
  clinic_id: clinic,
  document_id: document,
  document_version: 1,
  signer_user_id: doctor,
  signer_doctor_id: doctor,
  provider: 'local_simulation',
  certificate_subject: 'CN=SINTETICO',
  certificate_issuer: 'SINTETICO',
  certificate_serial: '1',
  certificate_fingerprint: 'a'.repeat(64),
  cpf_from_certificate: '52998224725',
  document_hash: 'b'.repeat(64),
  unsigned_pdf_hash: 'c'.repeat(64),
  signed_pdf_hash: 'd'.repeat(64),
  signed_pdf_storage_path: 'synthetic/original.pdf',
  status: 'SIGNED',
  verification_status: 'UNVERIFIED',
};
function insert(table, values, context = { role: 'service_role' }) {
  return h.sql(
    `insert into ${table} (${Object.keys(values).join(',')}) values (${Object.values(values).map(h.lit).join(',')}) returning id;`,
    context,
  );
}
function denied(query, context = actor) {
  assert.throws(
    () => h.sql(query, context),
    (error) => /42501/.test(String(error.stderr || error.message)),
  );
}
try {
  h.sql(`insert into auth.users values ('${doctor}'),('${colleague}'),('${outsider}');
    insert into clinics(id,name) values ('${clinic}','Clínica sintética'),('${otherClinic}','Outra clínica sintética');
    insert into clinic_members(clinic_id,user_id,role) values ('${clinic}','${doctor}','doctor'),('${clinic}','${colleague}','owner'),('${otherClinic}','${outsider}','doctor');
    insert into patients(clinic_id,id,name) values ('${clinic}','synthetic','Paciente sintético');
    insert into clinical_documents(id,clinic_id,patient_id,author_id,kind,patient_name,physician_name,physician_registration,document_date,text,status)
      values ('${document}','${clinic}','synthetic','${doctor}','Receita','Paciente sintético','Prescritor sintético','CRM 12345 SP','2026-10-29','Modalidade: Receita simples','SIGNING');`);
  insert('signature_sessions', {
    id: session,
    clinic_id: clinic,
    user_id: doctor,
    access_token_encrypted: 'synthetic-ciphertext',
    cpf: '52998224725',
    certificate_alias: 'synthetic',
    certificate_subject: 'CN=SINTETICO',
    certificate_issuer: 'SINTETICO',
    certificate_valid_from: '2026-01-01',
    certificate_valid_to: '2027-01-01',
    expires_at: '2099-01-01',
  });
  insert('signature_oauth_states', {
    id: state,
    clinic_id: clinic,
    user_id: doctor,
    state_hash: 'synthetic-state',
    code_verifier_encrypted: 'synthetic-verifier',
    redirect_uri: 'https://synthetic.invalid',
    expires_at: '2099-01-01',
  });
  insert('digital_signatures', { ...signature, id: signed });
  h.sql(
    `update clinical_documents set status='SIGNED',signed_pdf_path='synthetic/original.pdf' where id='${document}';`,
  );
  await test('01 anon não cria assinatura', () =>
    denied(
      `insert into digital_signatures(document_id) values ('${document}');`,
      { role: 'anon' },
    ));
  await test('02 autenticado não fabrica assinatura VALID', () => {
    assert.throws(
      () =>
        insert(
          'digital_signatures',
          { ...signature, verification_status: 'VALID' },
          actor,
        ),
      (e) => /42501/.test(String(e.stderr || e.message)),
    );
  });
  await test('03 médico não modifica hash', () =>
    denied(
      `update digital_signatures set signed_pdf_hash='forjado' where id='${signed}';`,
    ));
  await test('04 médico não modifica caminho do arquivo', () =>
    denied(
      `update digital_signatures set signed_pdf_storage_path='forjado.pdf' where id='${signed}';`,
    ));
  await test('05 médico não modifica CPF da sessão', () =>
    denied(
      `update signature_sessions set cpf='11144477735' where id='${session}';`,
    ));
  await test('06 médico não substitui token cifrado', () =>
    denied(
      `update signature_sessions set access_token_encrypted='forjado' where id='${session}';`,
    ));
  await test('07 médico não modifica estado OAuth', () =>
    denied(
      `update signature_oauth_states set redirect_uri='https://synthetic.invalid/forjado' where id='${state}';`,
    ));
  await test('08 médico não exclui assinatura', () =>
    denied(`delete from digital_signatures where id='${signed}';`));
  await test('09 proprietário da mesma clínica não acessa sessão individual alheia', () => {
    assert.equal(
      h.sql(`select count(id) from signature_sessions where id='${session}';`, {
        role: 'authenticated',
        user: colleague,
      }),
      '0',
    );
  });
  await test('10 outra clínica não lê nem manipula confiança', () => {
    const context = { role: 'authenticated', user: outsider };
    assert.equal(
      h.sql('select count(id) from digital_signatures;', context),
      '0',
    );
    assert.equal(
      h.sql('select count(id) from signature_sessions;', context),
      '0',
    );
    denied(
      `update signature_sessions set revoked=false where id='${session}';`,
      context,
    );
  });
  await test('11 usuário não executa RPC privilegiada SNCR com parâmetros arbitrários', () => {
    // RPCs SNCR da main: só o backend (service_role) executa.
    denied(
      `select sncr_store_numbers(gen_random_uuid(),'${clinic}','${doctor}','[]'::jsonb);`,
    );
    denied(
      `select sncr_rce_finish(gen_random_uuid(),'${clinic}','${doctor}',gen_random_uuid(),'x','x',now(),'{}'::jsonb);`,
    );
  });
  await test('12 frontend não forja vínculos documentais nem estado SIGNED por escrita direta', () => {
    denied(
      `update digital_signatures set document_id=gen_random_uuid(),signer_user_id='${colleague}' where id='${signed}';`,
    );
    denied(
      `update clinical_documents set status='SIGNED',signed_pdf_path='forjado.pdf' where id='${document}';`,
    );
  });
  await test('tokens, certificado bruto e verificador OAuth não são legíveis pelo navegador', () => {
    for (const column of ['access_token_encrypted', 'certificate_raw'])
      denied(`select ${column} from signature_sessions;`);
    denied('select * from signature_oauth_states;');
  });
  await test('sessão antiga não pode ser reativada pelo médico', () => {
    h.sql(`update signature_sessions set revoked=true where id='${session}';`, {
      role: 'service_role',
    });
    denied(
      `update signature_sessions set revoked=false where id='${session}';`,
    );
    assert.equal(
      h.sql(`select revoked from signature_sessions where id='${session}';`),
      't',
    );
  });
  if (process.env.SIGNATURE_TRUST_TEST_BASELINE !== '1') {
    await test('autenticado não cria sessão nem estado OAuth concluído', () => {
      for (const table of ['signature_sessions', 'signature_oauth_states'])
        denied(
          `insert into ${table}(clinic_id,user_id) values ('${clinic}','${doctor}');`,
        );
    });
    await test('leitura segura da própria sessão e documentos continua permitida', () => {
      assert.equal(
        h.sql(
          `select count(id) from signature_sessions where id='${session}';`,
          actor,
        ),
        '1',
      );
      assert.equal(
        h.sql(
          `select count(id) from clinical_documents where id='${document}';`,
          actor,
        ),
        '1',
      );
      assert.equal(
        h.sql(
          `select signed_pdf_hash from digital_signatures where id='${signed}';`,
          actor,
        ),
        signature.signed_pdf_hash,
      );
      assert.equal(
        h.sql('select count(id) from digital_signatures;', {
          role: 'authenticated',
          user: colleague,
        }),
        '1',
      );
    });
    await test('backend não altera ou apaga metadados concluídos nem troca identidade da sessão', () => {
      for (const query of [
        `update digital_signatures set verification_status='VALID' where id='${signed}';`,
        `delete from digital_signatures where id='${signed}';`,
        `update signature_sessions set cpf='11144477735' where id='${session}';`,
      ])
        denied(query, { role: 'service_role' });
    });
    await test('nova assinatura exige clínica, autor, versão e estado documental correspondentes', () => {
      for (const change of [
        { clinic_id: otherClinic },
        { document_version: 2 },
        { signer_user_id: colleague },
        { signer_doctor_id: colleague },
        {},
      ])
        assert.throws(
          () => insert('digital_signatures', { ...signature, ...change }),
          (e) => /23514/.test(String(e.stderr || e.message)),
        );
      assert.equal(h.sql('select count(*) from digital_signatures;'), '1');
    });
    await test('RPC pública de documentos não aceita campos de confiança forjados', () => {
      const payload = {
        id: '30000000-0000-4000-8000-000000000002',
        patient_id: 'synthetic',
        kind: 'Receita',
        text: 'Modalidade: Receita simples',
        physician_name: 'Sintético',
        physician_registration: 'CRM 12345 SP',
        document_date: '2026-10-29',
        version: 0,
        status: 'SIGNED',
        signed_pdf_path: 'forjado.pdf',
        author_id: colleague,
      };
      const doc = JSON.parse(
        h.sql(
          `select document_write('${clinic}',${h.lit(payload)}::jsonb);`,
          actor,
        ),
      );
      assert.equal(doc.status, 'DRAFT');
      assert.equal(doc.signed_pdf_path, null);
      assert.equal(doc.author_id, doctor);
      denied(
        `select document_write('${otherClinic}',${h.lit(payload)}::jsonb);`,
      );
    });
    await test('RLS recusa escrita mesmo se um GRANT de tabela for reintroduzido', () => {
      // Transação local revertida: prova da política independentemente do REVOKE.
      assert.equal(
        h.sql(
          `begin; grant update on signature_sessions to authenticated; set local role authenticated;
        update signature_sessions set cpf='11144477735' where id='${session}' returning id; rollback;`,
          { user: doctor },
        ),
        '',
      );
      assert.equal(
        h.sql(`select cpf from signature_sessions where id='${session}';`),
        '52998224725',
      );
      assert.equal(
        h.sql(
          "select has_table_privilege('authenticated','signature_sessions','update');",
        ),
        'f',
      );
    });
    await test('privilégios de coluna antigos são removidos na reaplicação', () => {
      h.sql(
        'grant select(access_token_encrypted),update(cpf) on signature_sessions to authenticated;',
      );
      h.applyTrust();
      denied('select access_token_encrypted from signature_sessions;');
      denied(
        `update signature_sessions set cpf='11144477735' where id='${session}';`,
      );
    });
    await test('evoluções também conservam escrita exclusiva do servidor', () => {
      denied(
        "insert into evolution_signatures(verification_status) values ('VALID');",
      );
      denied("update evolution_signatures set document_hash='forjado';");
      denied('delete from evolution_signatures;');
    });
    await test('migração reaplicável na cópia descartável sem alterar assinaturas', () => {
      const before = h.sql(
        'select jsonb_agg(to_jsonb(d) order by id) from digital_signatures d;',
      );
      h.applyTrust();
      assert.equal(
        h.sql(
          'select jsonb_agg(to_jsonb(d) order by id) from digital_signatures d;',
        ),
        before,
      );
      assert.deepEqual(
        h.applied,
        readdirSync(new URL('../supabase/migrations/', import.meta.url))
          .filter((file) => file.endsWith('.sql') && ![trustMigration, oauthMigration, attemptsMigration, evidenceMigration].includes(file))
          .sort(),
      );
    });
    await test('gatilho não oferece RPC SECURITY DEFINER e não concede EXECUTE', () => {
      assert.equal(
        h.sql(
          "select prosecdef from pg_proc where oid='public.signature_metadata_document_guard()'::regprocedure;",
        ),
        'f',
      );
      for (const role of ['anon', 'authenticated', 'service_role'])
        assert.equal(
          h.sql(
            `select has_function_privilege('${role}','public.signature_metadata_document_guard()','execute');`,
          ),
          'f',
        );
      assert.match(
        h.sql(
          "select proconfig::text from pg_proc where oid='public.signature_metadata_document_guard()'::regprocedure;",
        ),
        /pg_catalog, public, pg_temp/,
      );
      assert.equal(
        h.sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f' and p.prosecdef
         and pg_get_functiondef(p.oid) ~ '(digital_signatures|signature_sessions|signature_oauth_states)'
         and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'));`),
        '0',
      );
    });
  }
} finally {
  h.cleanup();
}
