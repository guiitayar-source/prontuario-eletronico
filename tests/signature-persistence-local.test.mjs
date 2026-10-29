import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  attemptsMigration,
  attemptsGuard,
} from './helpers/signature-trust-db.mjs';
import { signingHarness } from './helpers/signing-persistence.mjs';
import { syntheticRceText } from './helpers/rce-fixture.mjs';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { reserveDocument, getNumberingContext } from '../lib/sncr/numbering.ts';
const env = await signingHarness(),
  { h, fixture, asyncSql, statement, processSign } = env;
try {
  await test('conclusão comum e resposta perdida ao navegador usam uma assinatura e um original', async () => {
    const f = await fixture();
    f.fault.beforeHsm = async () => {
      const attempt = f.attempts()[0];
      assert.equal(attempt.state, 'EXTERNAL_STARTED');
      assert.match(attempt.document_hash, /^[a-f0-9]{64}$/);
      assert.equal(f.doc().status, 'SIGNING');
      assert.equal(attempt.document_version, 1);
    };
    let first;
    try {
      first = await f.sign();
    } catch (e) {
      throw new Error(
        e.message +
          '; trace=' +
          f.trace.join(',') +
          '; state=' +
          f.attempts()[0]?.state,
      );
    }
    const again = await f.sign();
    assert.equal(first.signedPdfPath, again.signedPdfPath);
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.equal(f.signatures().length, 1);
    assert.equal(f.doc().status, 'SIGNED');
    assert.equal(f.attempts().length, 1);
    assert.equal(f.attempts()[0].state, 'COMPLETED');
    assert.equal(f.signatures()[0].verification_status, 'UNVERIFIED');
    assert.equal(f.signatures()[0].signing_attempt_id, f.attempts()[0].id);
  });
  await test('PDF recebido e Storage indisponível: retomada com os mesmos bytes sem novo HSM', async () => {
    const f = await fixture();
    f.fault.upload = true;
    await assert.rejects(() => f.sign());
    assert.equal(f.attempts()[0].state, 'ARTIFACT_RECEIVED');
    assert.equal(f.signatures().length, 0);
    assert.equal(f.calls(), 1);
    f.fault.upload = false;
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.equal(f.doc().status, 'SIGNED');
  });
  await test('falha da finalização não deixa metadados órfãos e retoma artefato persistido', async () => {
    const f = await fixture();
    f.fault.rpc = 'finish';
    await assert.rejects(() => f.sign());
    assert.equal(f.signatures().length, 0);
    assert.equal(f.doc().status, 'SIGNING');
    assert.equal(f.attempts()[0].state, 'ARTIFACT_STORED');
    const original = Buffer.from([...f.files.values()][0]);
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.deepEqual([...f.files.values()][0], original);
    assert.equal(f.signatures().length, 1);
  });
  for (const count of [2, 10])
    await test(`${count} solicitações simultâneas: uma tentativa, um HSM, um artefato, uma conclusão`, async () => {
      const f = await fixture(),
        results = await Promise.allSettled(
          Array.from({ length: count }, () => f.sign()),
        );
      assert.ok(
        results.some((r) => r.status === 'fulfilled'),
        JSON.stringify({
          states: f.attempts().map((a) => a.state),
          calls: f.calls(),
          uploads: f.uploads(),
          trace: f.trace,
          errors: results
            .filter((r) => r.status === 'rejected')
            .map((r) => ({
              status: r.reason.status,
              message: r.reason.message,
            })),
        }),
      );
      assert.equal(f.calls(), 1);
      assert.equal(f.uploads(), 1);
      assert.equal(f.attempts().length, 1);
      assert.equal(f.signatures().length, 1);
      assert.equal(f.doc().status, 'SIGNED');
    });
  await test('duas aquisições SQL em conexões independentes recebem uma única posse', async () => {
    const f = await fixture();
    const results = await Promise.all(
      [1, 2].map(() =>
        asyncSql(
          'begin;select pg_sleep(0.1);' +
            statement(f.args('acquire', randomUUID(), f.acquireData)) +
            'commit;',
        ),
      ),
    );
    assert.equal(
      results.map((r) => JSON.parse(r.trim())).filter((r) => r.claimed).length,
      1,
    );
    assert.equal(f.attempts().length, 1);
    assert.equal(f.calls(), 0);
    assert.equal(f.doc().status, 'SIGNING');
  });

  await test('falha antes da aquisição não cria tentativa nem chama HSM', async () => {
    const f = await fixture();
    f.fault.rpc = 'acquire';
    await assert.rejects(() => f.sign());
    assert.equal(f.attempts().length, 0);
    assert.equal(f.calls(), 0);
    assert.equal(f.doc().status, 'DRAFT');
  });
  await test('resposta perdida após criar tentativa permite retomada com fencing antes de HSM', async () => {
    const f = await fixture();
    f.fault.afterCommit = 'acquire';
    await assert.rejects(() => f.sign());
    assert.equal(f.attempts()[0].state, 'ACQUIRED');
    assert.equal(f.calls(), 0);
    h.sql(
      `update document_signing_attempts set lease_until=now()-interval '1s' where document_id='${f.documentId}';`,
    );
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.attempts().length, 1);
    assert.equal(f.doc().status, 'SIGNED');
  });
  await test('falha de preparação antes do gate pode retomar a mesma tentativa', async () => {
    const f = await fixture();
    f.fault.rpc = 'prepare';
    await assert.rejects(() => f.sign());
    assert.equal(f.attempts()[0].state, 'PREPARATION_FAILED');
    assert.equal(f.doc().status, 'SIGNATURE_FAILED');
    assert.equal(f.calls(), 0);
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.attempts().length, 1);
  });
  await test('resposta perdida do gate externo conserva incerteza e não inicia HSM', async () => {
    const f = await fixture();
    f.fault.afterCommit = 'external';
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 0);
    assert.equal(f.attempts()[0].state, 'UNCERTAIN');
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 0);
    assert.equal(f.doc().status, 'SIGNING');
  });
  await test('timeout do HSM conserva tentativa incerta e impede segunda assinatura', async () => {
    const f = await fixture();
    f.fault.hsm = async () => {
      throw Error('TOKEN_SECRET CPF_SECRET upstream timeout');
    };
    await assert.rejects(
      () => f.sign(),
      (e) => !e.message.includes('SECRET'),
    );
    assert.equal(f.attempts()[0].state, 'UNCERTAIN');
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 0);
    assert.equal(f.signatures().length, 0);
    assert.equal(f.doc().status, 'SIGNING');
  });
  await test('upload cuja resposta se perde usa o objeto original e confirma uma única conclusão', async () => {
    const f = await fixture();
    f.fault.lostUpload = true;
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.equal(f.signatures().length, 1);
  });
  await test('resposta perdida ao registrar recebimento retoma journal sem nova assinatura', async () => {
    const f = await fixture();
    f.fault.afterCommit = 'receive';
    await assert.rejects(() => f.sign());
    assert.equal(f.attempts()[0].state, 'ARTIFACT_RECEIVED');
    assert.equal(f.uploads(), 0);
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
  });
  await test('resposta perdida após Storage e antes de confirmá-lo reutiliza objeto existente', async () => {
    const f = await fixture();
    f.fault.rpc = 'stored';
    await assert.rejects(() => f.sign());
    assert.equal(f.attempts()[0].state, 'ARTIFACT_RECEIVED');
    const original = Buffer.from([...f.files.values()][0]);
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.deepEqual([...f.files.values()][0], original);
  });
  await test('rollback PostgreSQL após INSERT de metadados remove toda conclusão parcial', async () => {
    const f = await fixture();
    h.sql(
      `create function public.test_abort_finish() returns trigger language plpgsql as $$ begin if new.id='${f.documentId}' and new.status='SIGNED' then raise exception 'synthetic failure after metadata insertion';end if;return new;end $$;create trigger zz_test_abort_finish before update on clinical_documents for each row execute function public.test_abort_finish();`,
    );
    try {
      await assert.rejects(() => f.sign());
      assert.equal(f.signatures().length, 0);
      assert.equal(f.attempts()[0].state, 'ARTIFACT_STORED');
      assert.equal(f.doc().status, 'SIGNING');
    } finally {
      h.sql(
        'drop trigger zz_test_abort_finish on clinical_documents;drop function public.test_abort_finish();',
      );
    }
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.equal(f.signatures().length, 1);
  });
  await test('COMMIT final confirmado e resposta perdida não é rebaixado por timeout tardio', async () => {
    const f = await fixture();
    f.fault.afterCommit = 'finish';
    await assert.rejects(() => f.sign());
    assert.equal(f.attempts()[0].state, 'COMPLETED');
    assert.equal(f.signatures().length, 1);
    assert.equal(f.doc().status, 'SIGNED');
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
  });
  await test('chaves diferentes concorrentes para a mesma versão não iniciam dois HSMs', async () => {
    const f = await fixture();
    await Promise.allSettled([
      f.sign({ idempotencyKey: 'first-key-6e' }),
      f.sign({ idempotencyKey: 'second-key-6e' }),
    ]);
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.equal(f.attempts().length, 1);
    assert.equal(f.signatures().length, 1);
  });
  await test('mesma chave com outro documento, versão ou identidade é recusada no PostgreSQL', async () => {
    const f = await fixture(),
      owner = randomUUID();
    await assert.rejects(() =>
      asyncSql(
        statement(
          f.args('acquire', randomUUID(), {
            ...f.acquireData,
            fingerprint: '00'.repeat(32),
          }),
        ),
      ),
    );
    await asyncSql(statement(f.args('acquire', owner, f.acquireData)));
    const otherId = randomUUID();
    h.sql(
      `insert into clinical_documents select (jsonb_populate_record(null::clinical_documents,(select to_jsonb(d)||jsonb_build_object('id','${otherId}','status','DRAFT') from clinical_documents d where id='${f.documentId}'))).*;`,
    );
    await assert.rejects(() =>
      asyncSql(
        statement({
          ...f.args('acquire', randomUUID(), f.acquireData),
          p_document: otherId,
        }),
      ),
    );
    await assert.rejects(() =>
      asyncSql(
        statement({
          ...f.args('acquire', randomUUID(), f.acquireData),
          p_version: 2,
        }),
      ),
    );
    await assert.rejects(() =>
      asyncSql(
        statement(
          f.args('acquire', randomUUID(), {
            ...f.acquireData,
            fingerprint: '00'.repeat(32),
          }),
        ),
      ),
    );
    assert.equal(f.calls(), 0);
    assert.equal(f.attempts().length, 1);
  });
  await test('dez aquisições em conexões PostgreSQL independentes mantêm unicidade', async () => {
    const f = await fixture();
    const r = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        asyncSql(
          statement({
            ...f.args('acquire', randomUUID(), f.acquireData),
            p_key: `key-6e-${String(i).padStart(4, '0')}`,
          }),
        ),
      ),
    );
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(f.attempts().length, 1);
    assert.equal(f.doc().status, 'SIGNING');
    assert.equal(f.calls(), 0);
  });
  await test('lease vencido antes de HSM admite um novo dono e impede processo antigo', async () => {
    const f = await fixture(),
      old = randomUUID(),
      current = randomUUID();
    await asyncSql(statement(f.args('acquire', old, f.acquireData)));
    h.sql(
      `update document_signing_attempts set lease_until=now()-interval '1s' where document_id='${f.documentId}';`,
    );
    const a = JSON.parse(
      await asyncSql(statement(f.args('acquire', current, f.acquireData))),
    );
    assert.equal(a.claimed, true);
    await assert.rejects(() =>
      asyncSql(
        statement(
          f.args('prepare', old, {
            document_hash: 'a'.repeat(64),
            unsigned_pdf_hash: 'b'.repeat(64),
          }),
        ),
      ),
    );
    await asyncSql(
      statement(
        f.args('prepare', current, {
          document_hash: 'a'.repeat(64),
          unsigned_pdf_hash: 'b'.repeat(64),
        }),
      ),
    );
    await assert.rejects(() => asyncSql(statement(f.args('external', old))));
    await asyncSql(statement(f.args('external', current)));
    await assert.rejects(() =>
      asyncSql(statement(f.args('external', current))),
    );
    assert.equal(f.attempts().length, 1);
  });
  await test('tentativa antiga externa permanece incerta sem nova assinatura', async () => {
    const f = await fixture(),
      owner = randomUUID();
    await asyncSql(statement(f.args('acquire', owner, f.acquireData)));
    await asyncSql(
      statement(
        f.args('prepare', owner, {
          document_hash: 'a'.repeat(64),
          unsigned_pdf_hash: 'b'.repeat(64),
        }),
      ),
    );
    await asyncSql(statement(f.args('external', owner)));
    h.sql(
      `update document_signing_attempts set lease_until=now()-interval '1 day' where document_id='${f.documentId}';`,
    );
    await assert.rejects(() => f.sign());
    assert.equal(f.attempts()[0].state, 'UNCERTAIN');
    assert.equal(f.calls(), 0);
    assert.equal(f.doc().status, 'SIGNING');
  });
  await test('processo morre após persistir artefato e outro processo conclui sem novo HSM', async () => {
    const f = await fixture();
    const killed = await processSign(f, { killAfter: 'stored' });
    assert.equal(killed.killed, true);
    assert.equal(f.attempts()[0].state, 'ARTIFACT_STORED');
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    const result = await processSign(f);
    assert.equal(result.result.success, true);
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.equal(f.signatures().length, 1);
    assert.equal(f.doc().status, 'SIGNED');
  });
  await test('processo morre após HSM sem resposta: novo processo não assina novamente', async () => {
    const f = await fixture();
    await processSign(f, { killAfter: 'hsm' });
    assert.equal(f.calls(), 1);
    assert.equal(f.doc().status, 'SIGNING');
    h.sql(
      `update document_signing_attempts set lease_until=now()-interval '1 day' where document_id='${f.documentId}';`,
    );
    const result = await processSign(f);
    assert.equal(result.error.status, 409);
    assert.equal(f.attempts()[0].state, 'UNCERTAIN');
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 0);
    assert.equal(f.signatures().length, 0);
  });
  await test('edição concorrente perde para a aquisição ou invalida versão antes do HSM', async () => {
    const f = await fixture();
    const result = await Promise.allSettled([
      asyncSql(statement(f.args('acquire', randomUUID(), f.acquireData))),
      asyncSql(
        `update clinical_documents set text='Edicao sintetica concorrente',version=version+1 where id='${f.documentId}';`,
        'postgres',
      ),
    ]);
    assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(f.calls(), 0);
    const d = f.doc();
    assert.ok(
      (d.status === 'SIGNING' && d.version === 1) ||
        (d.status === 'DRAFT' && d.version === 2),
    );
  });
  await test('conteúdo, autor, clínica, versão, consulta, número e caminho não mudam durante assinatura', async () => {
    const f = await fixture();
    f.fault.upload = true;
    await assert.rejects(() => f.sign());
    for (const change of [
      "text='Alterado'",
      'version=2',
      `author_id='${randomUUID()}'`,
      `clinic_id='${randomUUID()}'`,
      `consultation_id='${randomUUID()}'`,
      "text=E'Modalidade: Receita simples\nSNCR: FORGED'",
      "signed_pdf_path='forged'",
      "status='DRAFT'",
    ])
      assert.throws(() =>
        h.sql(
          `update clinical_documents set ${change} where id='${f.documentId}';`,
        ),
      );
    assert.equal(f.doc().version, 1);
    assert.equal(f.doc().status, 'SIGNING');
    assert.equal(f.calls(), 1);
  });
  for (const scenario of ['missing', 'corrupt'])
    await test(`artefato definitivo ${scenario}: erro explícito sem upload, regeneração ou novo HSM`, async () => {
      const f = await fixture();
      const result = await f.sign();
      if (scenario === 'missing') f.files.delete(result.signedPdfPath);
      else f.files.set(result.signedPdfPath, Buffer.from('corrupt synthetic'));
      await assert.rejects(() => f.sign());
      assert.equal(f.calls(), 1);
      assert.equal(f.uploads(), 1);
      assert.equal(f.signatures().length, 1);
      assert.equal(f.doc().status, 'SIGNED');
    });
  await test('registro cifrado corrompido bloqueia retomada sem regeneração', async () => {
    const f = await fixture();
    f.fault.upload = true;
    await assert.rejects(() => f.sign());
    h.sql(
      `update document_signing_attempts set artifact_cipher='invalid' where document_id='${f.documentId}';`,
    );
    f.fault.upload = false;
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 0);
  });
  await test('objeto já existente com bytes incompatíveis nunca é sobrescrito', async () => {
    const f = await fixture();
    f.fault.rpc = 'stored';
    await assert.rejects(() => f.sign());
    const path = [...f.files.keys()][0];
    f.files.set(path, Buffer.from('tampered original'));
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.equal(f.files.get(path).toString(), 'tampered original');
    assert.equal(f.signatures().length, 0);
  });
  await test('metadados de Storage são imutáveis inclusive para service_role e não aceitam forja frontend', async () => {
    const f = await fixture();
    await f.sign();
    const path = [...f.files.keys()][0];
    for (const role of ['service_role', 'authenticated'])
      for (const sql of [
        `update storage.objects set metadata='{}' where name=${h.lit(path)};`,
        `delete from storage.objects where name=${h.lit(path)};`,
        `update storage.objects set name='renamed' where name=${h.lit(path)};`,
      ])
        if (role === 'service_role')
          assert.throws(() => h.sql(sql, { role, user: f.userId }));
        else {
          let denied = false,
            rows;
          try {
            rows = h.sql(sql.replace(';', ' returning id;'), {
              role,
              user: f.userId,
            });
          } catch {
            denied = true;
          }
          if (!denied) assert.equal(rows, '');
        }
    for (const role of ['anon', 'authenticated'])
      assert.throws(() =>
        h.sql(
          `insert into storage.objects(bucket_id,name,metadata,user_metadata) values('clinical-files','${f.clinicId}/signature-attempts/forged.pdf','{}','{}');`,
          { role, user: f.userId },
        ),
      );
    assert.equal(
      h.sql(`select count(*) from storage.objects where name=${h.lit(path)};`),
      '1',
    );
  });
  await test('RLS/ACL negam leitura e fabricação de tentativas, eventos, ciphertext e RPC ao frontend', async () => {
    const f = await fixture();
    for (const role of ['anon', 'authenticated'])
      for (const sql of [
        'select * from document_signing_attempts;',
        'select * from document_signing_events;',
        "update document_signing_attempts set state='ACQUIRED';",
        "insert into document_signing_events(to_state,reason) values('COMPLETED','forged');",
        statement(f.args('inspect')),
      ])
        assert.throws(() => h.sql(sql, { role, user: f.userId }));
    for (const sql of [
      "update document_signing_attempts set state='ACQUIRED';",
      'delete from document_signing_attempts;',
    ])
      assert.throws(() => h.sql(sql, { role: 'service_role' }));
    assert.equal(
      h.sql(
        "select has_table_privilege('service_role','public.digital_signatures','INSERT');",
      ),
      'f',
    );
    assert.equal(
      h.sql(
        "select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp'] from pg_proc where oid='public.document_signing_operation(text,uuid,uuid,uuid,integer,text,uuid,jsonb)'::regprocedure;",
      ),
      't',
    );
  });
  await test('retomadas concorrentes finalizam o mesmo artefato uma única vez', async () => {
    const f = await fixture();
    f.fault.upload = true;
    await assert.rejects(() => f.sign());
    f.fault.upload = false;
    const r = await Promise.allSettled([f.sign(), f.sign()]);
    assert.ok(r.some((x) => x.status === 'fulfilled'));
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.equal(f.signatures().length, 1);
    assert.equal(f.attempts().length, 1);
    assert.equal(f.doc().status, 'SIGNED');
  });
  await test('documento substituído preserva original e não pode ser reativado', async () => {
    const f = await fixture();
    const signed = await f.sign();
    h.sql(
      `update clinical_documents set status='SUPERSEDED' where id='${f.documentId}';`,
    );
    const result = await f.sign();
    assert.equal(result.signedPdfPath, signed.signedPdfPath);
    assert.equal(f.calls(), 1);
    assert.equal(f.uploads(), 1);
    assert.throws(() =>
      h.sql(
        `update clinical_documents set status='SIGNED' where id='${f.documentId}';`,
      ),
    );
  });
  await test('finalização sem objeto de Storage existente é recusada no PostgreSQL', async () => {
    const f = await fixture();
    f.fault.upload = true;
    await assert.rejects(() => f.sign());
    await assert.rejects(() => asyncSql(statement(f.args('stored'))));
    assert.equal(f.signatures().length, 0);
    assert.equal(f.doc().status, 'SIGNING');
  });
  await test('documento reservado ou controlado não pode adquirir pelo caminho comum SQL', async () => {
    const f = await fixture({
      kind: 'Receita',
      text: 'Modalidade: Controle especial\nMED001 - Sintetico',
    });
    await assert.rejects(() =>
      asyncSql(statement(f.args('acquire', randomUUID(), f.acquireData))),
    );
    assert.equal(f.attempts().length, 0);
    assert.equal(f.calls(), 0);
    assert.equal(f.doc().status, 'DRAFT');
  });
  await test('assinatura de receita simples preservada sem reserva SNCR', async () => {
    const f = await fixture({
      kind: 'Receita',
      text: 'Modalidade: Receita simples\nVia de administração: Uso oral\n\nMED001 - Sintetico',
    });
    await f.sign();
    assert.equal(f.doc().status, 'SIGNED');
    assert.equal(f.signatures()[0].verification_status, 'UNVERIFIED');
    assert.equal(
      h.sql(
        `select count(*) from sncr_reservations where document_id='${f.documentId}';`,
      ),
      '0',
    );
    assert.equal(f.calls(), 1);
  });
  await test('identidade alterada durante HSM não conclui nem libera outra assinatura', async () => {
    const f = await fixture();
    f.fault.beforeHsm = async () =>
      h.sql(
        `update document_profiles set cpf='11144477735' where clinic_id='${f.clinicId}' and user_id='${f.userId}';`,
      );
    await assert.rejects(() => f.sign());
    assert.equal(f.signatures().length, 0);
    assert.equal(f.doc().status, 'SIGNING');
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 1);
  });
  for (const [modality, label] of [
    ['notificacao_a', 'NRA'],
    ['notificacao_b', 'NRB'],
    ['notificacao_b2', 'NRB2'],
  ])
    await test(`${label}: concorrência preserva reserva e original com toda a migração 6E`, async () => {
      const keys = [
        'NODE_ENV',
        'NEXT_PUBLIC_SUPABASE_URL',
        'PSYWRITE_SNCR_MODE',
        'ANVISA_SNCR_ENV',
        'VERCEL',
        'VERCEL_ENV',
      ];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      Object.assign(process.env, {
        NODE_ENV: 'test',
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        PSYWRITE_SNCR_MODE: 'local-simulation',
        ANVISA_SNCR_ENV: 'hmg',
      });
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      // eslint-disable-next-line typescript/unbound-method -- Restaurado no protótipo; chamada abaixo usa call(this).
      const original = MockBirdIdProvider.prototype.signHash;
      let hsm = 0;
      MockBirdIdProvider.prototype.signHash = async function (args) {
        hsm++;
        return original.call(this, args);
      };
      try {
        const f = await fixture({
            kind: 'Receita',
            text: `Modalidade: Notificação de Receita ${label.slice(2)}\n${syntheticRceText}`,
          }),
          request = randomUUID();
        h.sql(
          `update document_profiles set letterhead_address='Rua Sintética, 200 - Cidade Teste - SP',letterhead_phone='(11) 0000-0000' where user_id='${f.userId}';insert into sncr_local_sandboxes values('${f.clinicId}','synthetic-local-only');insert into sncr_requests(id,clinic_id,prescriber_id,environment,modality,request_key,origin,state) values('${request}','${f.clinicId}','${f.userId}','hmg','${modality}',gen_random_uuid(),'synthetic','completed');insert into sncr_batches(request_id,clinic_id,prescriber_id,environment,modality,council,council_number,council_uf,registration_snapshot,number_prefix,suffix_width,first_suffix,last_suffix,next_suffix,origin,verification_state) values('${request}','${f.clinicId}','${f.userId}','hmg','${modality}','CRM','12345','SP','CRM 12345 SP','SIMULADO.6E.${label}.',7,1,2,1,'synthetic','verified');`,
        );
        const actor = { clinicId: f.clinicId, userId: f.userId };
        const reserved = await reserveDocument(f.db, actor, f.documentId);
        const results = await Promise.allSettled([f.sign(), f.sign()]);
        assert.ok(results.some((r) => r.status === 'fulfilled'));
        const ctx = await getNumberingContext(f.db, actor, f.documentId);
        assert.equal(ctx.reservation.id, reserved.reservation.id);
        assert.equal(ctx.reservation.number, reserved.reservation.number);
        assert.equal(ctx.reservation.state, 'signed');
        assert.equal(f.doc().status, 'SIGNED');
        assert.equal(hsm, 1);
        assert.equal(f.uploads(), 1);
        assert.equal(f.signatures().length, 1);
        assert.equal(f.attempts().length, 0);
        const originalBytes = Buffer.from([...f.files.values()][0]);
        await f.sign();
        assert.equal(hsm, 1);
        assert.equal(f.uploads(), 1);
        assert.deepEqual([...f.files.values()][0], originalBytes);
      } finally {
        MockBirdIdProvider.prototype.signHash = original;
        for (const [k, v] of Object.entries(saved))
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
      }
    });
  await test('metadados históricos órfãos impedem uma nova assinatura da versão', async () => {
    const f = await fixture();
    h.sql(
      `update clinical_documents set status='SIGNING' where id='${f.documentId}';insert into digital_signatures(clinic_id,document_id,document_version,signer_user_id,signer_doctor_id,certificate_subject,certificate_issuer,certificate_serial,certificate_fingerprint,cpf_from_certificate,document_hash,unsigned_pdf_hash,signed_pdf_hash,signed_pdf_storage_path,status,verification_status) values('${f.clinicId}','${f.documentId}',1,'${f.userId}','${f.userId}','Sintetico','Sintetico','legacy','fingerprint','52998224725','${'a'.repeat(64)}','${'b'.repeat(64)}','${'c'.repeat(64)}','${f.clinicId}/historical-signed.pdf','SIGNED','UNVERIFIED');update clinical_documents set status='SIGNATURE_FAILED' where id='${f.documentId}';`,
    );
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 0);
    assert.equal(f.uploads(), 0);
    assert.equal(f.attempts().length, 0);
    assert.equal(f.signatures().length, 1);
    assert.equal(f.doc().status, 'SIGNATURE_FAILED');
  });
  await test('auditoria histórica de resultado incerto impede inferir ausência de assinatura', async () => {
    const f = await fixture();
    h.sql(
      `update clinical_documents set status='SIGNATURE_FAILED' where id='${f.documentId}';insert into audit_events(clinic_id,actor_id,action,entity_type,entity_id,context) values('${f.clinicId}','${f.userId}','document.signature_pending','clinical_documents','${f.documentId.toUpperCase()}',${h.lit({ document_version: 1, reason: 'external_result_unconfirmed' })});`,
    );
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 0);
    assert.equal(f.attempts().length, 0);
    assert.equal(f.signatures().length, 0);
    assert.equal(f.doc().status, 'SIGNATURE_FAILED');
  });
  await test('documento histórico substituído conserva autoria, versão, consulta e original', async () => {
    const f = await fixture();
    h.sql(
      `update clinical_documents set status='SIGNED',signed_pdf_path='${f.clinicId}/historical-original.pdf' where id='${f.documentId}';update clinical_documents set status='SUPERSEDED' where id='${f.documentId}';`,
    );
    for (const change of [
      'version=2',
      `author_id='${randomUUID()}'`,
      `clinic_id='${randomUUID()}'`,
      `consultation_id='${randomUUID()}'`,
      "patient_name='Alterado'",
      "text='Alterado'",
      "signed_pdf_path='forged'",
      "status='SIGNED'",
    ])
      assert.throws(() =>
        h.sql(
          `update clinical_documents set ${change} where id='${f.documentId}';`,
        ),
      );
    assert.equal(f.doc().status, 'SUPERSEDED');
    assert.equal(f.doc().version, 1);
    assert.equal(f.doc().author_id, f.userId);
    assert.equal(f.attempts().length, 0);
    assert.equal(f.calls(), 0);
  });
  await test('falha histórica sem metadados ou auditoria também exige reconciliação', async () => {
    const f = await fixture();
    h.sql(
      `update clinical_documents set status='SIGNATURE_FAILED' where id='${f.documentId}';`,
    );
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 0);
    assert.equal(f.attempts().length, 0);
    assert.equal(f.uploads(), 0);
    assert.equal(f.doc().status, 'SIGNATURE_FAILED');
  });
  await test('edição após preparação pré-HSM pode assinar uma nova versão legítima', async () => {
    const f = await fixture();
    f.fault.rpc = 'prepare';
    await assert.rejects(() => f.sign());
    assert.equal(f.calls(), 0);
    assert.equal(f.attempts()[0].state, 'PREPARATION_FAILED');
    h.sql(
      `update clinical_documents set version=2,text='Nova versão sintética após falha de preparação' where id='${f.documentId}';`,
    );
    await f.sign();
    assert.equal(f.calls(), 1);
    assert.equal(f.attempts().length, 2);
    assert.equal(f.signatures().length, 1);
    assert.equal(f.signatures()[0].document_version, 2);
    assert.equal(f.doc().status, 'SIGNED');
  });
  await test('migração bloqueada no original, eventos duráveis e ausência de segredos na auditoria', async () => {
    const source = readFileSync(
      new URL('../supabase/migrations/' + attemptsMigration, import.meta.url),
      'utf8',
    );
    assert.equal(source.split(attemptsGuard).length, 2);
    assert.throws(() => h.sql('begin;' + source + 'commit;'));
    const logs = h.sql(
      "select coalesce(jsonb_agg(context),'[]') from audit_events where action like 'document.signature%';",
    );
    for (const secret of [
      'synthetic-token-only',
      'TOKEN_SECRET',
      'CPF_SECRET',
      '52998224725',
      '11144477735',
      'artifact_cipher',
      'Documento sintetico sem validade clinica.',
    ])
      assert.ok(!logs.includes(secret));
    assert.ok(
      Number(h.sql('select count(*) from document_signing_events;')) > 0,
    );
  });
} finally {
  env.cleanup();
}
