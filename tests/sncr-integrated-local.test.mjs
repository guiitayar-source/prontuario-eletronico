// Integração real com PostgreSQL. Apenas o provedor de certificado é simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createSncrDb } from './helpers/sncr-local-db.mjs';
import {
  reserveDocument,
  getNumberingContext,
  localSimulationEnabled,
  actorArgs,
  sncrRpc,
  abandonReservation,
} from '../lib/sncr/numbering.ts';
import {
  signReservedSimulation,
  recoverSimulation,
  simulationPdf,
  sha256,
} from '../lib/sncr/signing.ts';
import { stripSncrNumbers } from '../lib/document-fields.ts';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { register } from 'node:module';
const moduleRoot = new URL('../', import.meta.url).href;
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,next){if(s.startsWith('@/'))return next(new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?'':'.ts'),${JSON.stringify(moduleRoot)}).href,c);return next(s,c);}`,
    ),
  import.meta.url,
);
const { DocumentSigningService } =
  await import('../lib/signature/document-signing-service.ts');
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { documentPdf } from '../lib/document-pdf.ts';

const keys = [
  'NODE_ENV',
  'PSYWRITE_SNCR_MODE',
  'NEXT_PUBLIC_SUPABASE_URL',
  'VERCEL',
  'VERCEL_ENV',
  'ANVISA_SNCR_ENV',
];
const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
Object.assign(process.env, {
  NODE_ENV: 'test',
  PSYWRITE_SNCR_MODE: 'local-simulation',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  ANVISA_SNCR_ENV: 'hmg',
});
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
const h = createSncrDb(),
  root = await mkdtemp(join(tmpdir(), 'psywrite-sncr-3b-'));
const store = {
  put: async (path, bytes) => {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: 'wx' });
  },
  get: async (path) => new Uint8Array(await readFile(join(root, path))),
};
const uuid = () => randomUUID();
function fixture({
  last = 100,
  modality = 'controle_especial',
  origin = 'synthetic',
  sandbox = true,
} = {}) {
  const actor = { clinicId: uuid(), userId: uuid() },
    request = uuid();
  const prefix =
    origin === 'synthetic'
      ? `SIMULADO.${request.slice(0, 8)}.`
      : `OFFICIAL.${request.slice(0, 8)}.`;
  h.sql(`insert into auth.users values ('${actor.userId}');insert into clinics values ('${actor.clinicId}');insert into clinic_members values ('${actor.clinicId}','${actor.userId}','doctor');insert into document_profiles values ('${actor.clinicId}','${actor.userId}','CRM 12345 SP');${sandbox ? `insert into sncr_local_sandboxes values ('${actor.clinicId}','synthetic-local-only');` : ''}
 insert into sncr_requests(id,clinic_id,prescriber_id,environment,modality,request_key,origin,state) values ('${request}','${actor.clinicId}','${actor.userId}','hmg','${modality}','${uuid()}','${origin}','completed');
 insert into sncr_batches(request_id,clinic_id,prescriber_id,environment,modality,council,council_number,council_uf,registration_snapshot,number_prefix,suffix_width,first_suffix,last_suffix,next_suffix,origin,verification_state) values ('${request}','${actor.clinicId}','${actor.userId}','hmg','${modality}','CRM','12345','SP','CRM 12345 SP','${prefix}',7,1,${last},1,'${origin}','verified');`);
  const document = (overrides = {}) => {
    const d = {
      id: uuid(),
      clinic_id: actor.clinicId,
      author_id: actor.userId,
      patient_id: 'synthetic-patient',
      kind: 'Receita',
      status: 'DRAFT',
      physician_registration: 'CRM 12345 SP',
      version: 1,
      text: 'Via de administração: Uso oral\n\nMED001 - Instrução sintética',
      document_date: '2026-10-27',
      patient_name: 'Paciente Sintético',
      physician_name: 'Médico Sintético',
      ...overrides,
    };
    h.sql(
      `insert into clinical_documents select (jsonb_populate_record(null::clinical_documents,${h.lit(d)}::jsonb)).*;`,
    );
    return d;
  };
  return {
    actor,
    document,
    request,
    count: () =>
      h.sql(
        `select next_suffix-first_suffix from sncr_batches where request_id='${request}';`,
      ),
  };
}
const f = fixture();
let calls = 0;
const mock = new MockBirdIdProvider({ doctorName: 'SIMULACAO LOCAL' });
const provider = {
  signHash: async (p) => {
    calls++;
    return mock.signHash(p);
  },
};
const reserve = (d) => reserveDocument(h.db, f.actor, d.id);
const sign = (d, opts = {}, storage = store) =>
  signReservedSimulation(h.db, f.actor, d.id, storage, { provider, ...opts });
async function textOf(bytes) {
  const path = join(root, `${uuid()}.pdf`);
  await writeFile(path, bytes);
  const output = path + '.txt';
  execFileSync('pdftotext', [path, output]);
  return readFile(output, 'utf8');
}
try {
  await test('reserva exclusiva incorpora número no PDF efetivamente gerado', async () => {
    const d = f.document(),
      ctx = await reserve(d);
    assert.ok(ctx.reservation.number.startsWith('SIMULADO.'));
    const text = await textOf(
      await simulationPdf({
        ...ctx.document,
        sncr_number: ctx.reservation.number,
      }),
    );
    assert.ok(text.includes(ctx.reservation.number));
    assert.match(text, /SIMULACAO LOCAL/);
    assert.match(text, /MED001/);
  });
  await test('fluxo completo: PAdES simulado, estado final e recuperação dos mesmos bytes', async () => {
    const d = f.document();
    await reserve(d);
    const result = await sign(d);
    assert.equal(result.simulation, true);
    assert.equal(result.verification.isValid, true);
    const ctx = await getNumberingContext(h.db, f.actor, d.id);
    assert.equal(ctx.reservation.state, 'signed');
    assert.equal(ctx.document.status, 'SIGNED');
    const original = await store.get(result.signedPdfPath),
      recovered = await recoverSimulation(store, ctx);
    assert.deepEqual(original, recovered.bytes);
    assert.equal(
      sha256(original),
      ctx.reservation.artifact_metadata.signed_pdf_hash,
    );
    const text = await textOf(recovered.bytes);
    assert.ok(text.includes(ctx.reservation.number));
    assert.match(text, /MED001/);
    const consumed = f.count(),
      before = calls;
    await sign(d);
    assert.equal(f.count(), consumed);
    assert.equal(calls, before);
    assert.equal(
      h.sql(
        `select count(*) from digital_signatures where document_id='${d.id}';`,
      ),
      '1',
    );
    assert.equal(
      h.sql(
        `select verification_status from digital_signatures where document_id='${d.id}';`,
      ),
      'UNVERIFIED',
    );
  });
  await test('editor salva a versão antes de reservar e envia somente documentId ao backend', async () => {
    const d = f.document();
    const events = [],
      state = {};
    const source = ts.createSourceFile(
      'use-documents.ts',
      readFileSync(
        new URL('../components/documents/use-documents.ts', import.meta.url),
        'utf8',
      ),
      ts.ScriptTarget.Latest,
      true,
    );
    const hook = source.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'useDocuments',
    );
    const fn = hook.body.statements.find(
      (n) =>
        ts.isFunctionDeclaration(n) && n.name?.text === 'requestSncrNumber',
    );
    const code = ts.transpileModule(fn.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const invoke = runInNewContext(code + '\nrequestSncrNumber;', {
      draft: { ...d, text: 'MED002 - Texto editado' },
      dirty: true,
      sncrGeneration: { current: 0 },
      save: async () => {
        events.push('save');
        h.sql(
          `update clinical_documents set text='MED002 - Texto editado',version=version+1 where id='${d.id}';`,
        );
        return (await getNumberingContext(h.db, f.actor, d.id)).document;
      },
      apiFetch: async (_url, request) => {
        events.push('reserve');
        const body = JSON.parse(request.body);
        assert.deepEqual(Object.keys(body).sort(), ['action', 'documentId']);
        return Response.json(
          await reserveDocument(h.db, f.actor, body.documentId),
        );
      },
      setBusy: (v) => (state.busy = v),
      setError: (v) => (state.error = v),
      setNumbering: (v) => (state.numbering = v),
      setDraft: (v) => (state.draft = v),
      setSaved: (v) => (state.saved = v),
      clearPreview: () => {},
      setSignatureNotice: () => {},
    });
    await invoke();
    assert.deepEqual(events, ['save', 'reserve']);
    assert.equal(state.numbering.reservation.document_version, 2);
    assert.equal(state.draft.text, 'MED002 - Texto editado');
    assert.equal(state.busy, false);
  });
  await test('entrada real DocumentSigningService usa contexto persistido e armazenamento local', async () => {
    const d = f.document();
    await reserve(d);
    const application = {
      ...h.applicationDb,
      storage: {
        from: () => ({
          upload: async (path, bytes, opts) => {
            assert.equal(opts.upsert, false);
            await store.put(path, bytes);
            return { error: null };
          },
          download: async (path) => ({
            data: new Blob([await store.get(path)]),
            error: null,
          }),
        }),
      },
    };
    const service = new DocumentSigningService(() => application);
    const result = await service.signClinicalDocument({
      db: application,
      ...f.actor,
      documentId: d.id,
    });
    assert.equal(result.simulation, true);
    assert.equal(result.document.status, 'SIGNED');
    const again = await service.signClinicalDocument({
      db: application,
      ...f.actor,
      documentId: d.id,
    });
    assert.equal(again.signedPdfPath, result.signedPdfPath);
  });
  await test('repetir reserva mantém a mesma chave e não consome outro número', async () => {
    const d = f.document();
    const a = await reserve(d),
      b = await reserve(d);
    assert.equal(a.reservation.id, b.reservation.id);
    assert.equal(a.reservation.number, b.reservation.number);
  });
  await test('número manual/histórico não vira reserva oficial nem autoriza assinatura', async () => {
    const d = f.document({ text: 'SNCR: 2602.6-53.0000001\n\nMED001' });
    await assert.rejects(reserve(d), /manual|histórico/i);
    await assert.rejects(sign(d), /reserva/i);
  });
  await test('outro médico não consulta, reserva ou assina o documento', async () => {
    const d = f.document(),
      stranger = fixture();
    await reserve(d);
    for (const action of [
      () => reserveDocument(h.db, stranger.actor, d.id),
      () => getNumberingContext(h.db, stranger.actor, d.id),
      () => signReservedSimulation(h.db, stranger.actor, d.id, store),
    ])
      await assert.rejects(action(), /pertence|autorizado/i);
  });
  await test('modalidade incompatível não encontra estoque e não recebe assinatura', async () => {
    const d = f.document({
      text: 'Modalidade: Notificação de Receita B\n\nMED001',
    });
    await assert.rejects(reserve(d), /lote|modalidade/i);
    await assert.rejects(sign(d), /reserva/i);
  });
  await test('homologação não é promovida a produção por flag nem admite origem oficial no simulador', async () => {
    const d = f.document();
    await reserve(d);
    process.env.ANVISA_SNCR_ENV = 'prd';
    try {
      await assert.rejects(sign(d), /bloqueada/i);
    } finally {
      process.env.ANVISA_SNCR_ENV = 'hmg';
    }
    const official = fixture({ origin: 'anvisa_api' }),
      od = official.document();
    await assert.rejects(reserveDocument(h.db, official.actor, od.id), /lote/i);
  });
  await test('versão reservada não pode ser editada ou reatribuída silenciosamente', async () => {
    const d = f.document();
    await reserve(d);
    assert.throws(
      () =>
        h.sql(
          `update clinical_documents set text='alterado',version=version+1 where id='${d.id}';`,
        ),
      /23514/,
    );
    assert.throws(
      () =>
        h.sql(
          `update clinical_documents set author_id='${fixture().actor.userId}' where id='${d.id}';`,
        ),
      /23514/,
    );
  });
  await test('modelo reutilizável remove numeração antiga inclusive fora do cabeçalho', () => {
    assert.equal(
      stripSncrNumbers(
        'Modalidade: Controle especial\nSNCR: OLD.001\n\nMED001\nNº SNCR: OLD.002',
      ),
      'Modalidade: Controle especial\n\nMED001',
    );
  });
  await test('duas solicitações simultâneas para o mesmo documento recebem a mesma reserva', async () => {
    const d = f.document();
    const a = await Promise.all([reserve(d), reserve(d)]);
    assert.equal(a[0].reservation.id, a[1].reservation.id);
  });
  await test('duas assinaturas simultâneas iniciam somente uma chamada ao provedor', async () => {
    const d = f.document();
    await reserve(d);
    const before = calls;
    const r = await Promise.allSettled([sign(d), sign(d)]);
    assert.ok(r.some((x) => x.status === 'fulfilled'));
    assert.equal(calls, before + 1);
    assert.equal(
      h.sql(
        `select count(*) from digital_signatures where document_id='${d.id}';`,
      ),
      '1',
    );
  });
  await test('usuário sem papel médico e frontend direto não executam transições', async () => {
    const d = f.document();
    await reserve(d);
    const secretary = uuid();
    h.sql(
      `insert into auth.users values ('${secretary}');insert into clinic_members values ('${f.actor.clinicId}','${secretary}','secretary');`,
    );
    await assert.rejects(
      getNumberingContext(
        h.db,
        { clinicId: f.actor.clinicId, userId: secretary },
        d.id,
      ),
      /autorizado/i,
    );
    assert.throws(
      () =>
        h.sql(
          h.statement('sncr_begin_signing', actorArgs(f.actor, d.id)),
          'authenticated',
        ),
      /42501/,
    );
  });
  await test('falha de PDF depois da reserva preserva número e bloqueia nova assinatura', async () => {
    const d = f.document({ patient_name: 'W'.repeat(180) });
    await reserve(d);
    const before = calls;
    await assert.rejects(sign(d));
    const ctx = await getNumberingContext(h.db, f.actor, d.id);
    assert.equal(ctx.reservation.state, 'uncertain');
    assert.equal(ctx.reservation.artifact_metadata, null);
    assert.equal(calls, before);
    await assert.rejects(sign(d));
    assert.equal(calls, before);
  });
  await test('recusa do provedor conserva estado incerto sem devolver número', async () => {
    const d = f.document();
    await reserve(d);
    await assert.rejects(
      sign(d, { provider: new MockBirdIdProvider({ shouldFailSign: true }) }),
    );
    const ctx = await getNumberingContext(h.db, f.actor, d.id);
    assert.equal(ctx.reservation.state, 'uncertain');
    await assert.rejects(sign(d));
  });
  await test('timeout REAL na conclusão reverte transação; replay recupera artefato sem assinar novamente', async () => {
    const d = f.document();
    await reserve(d);
    h.timeoutFinish();
    await assert.rejects(sign(d));
    let ctx = await getNumberingContext(h.db, f.actor, d.id);
    assert.equal(ctx.reservation.state, 'uncertain');
    assert.notEqual(ctx.document.status, 'SIGNED');
    const before = calls;
    await sign(d);
    ctx = await getNumberingContext(h.db, f.actor, d.id);
    assert.equal(ctx.reservation.state, 'signed');
    assert.equal(calls, before);
  });
  await test('reinicialização entre reserva e assinatura preserva vínculo', async () => {
    const d = f.document();
    const before = await reserve(d);
    execFileSync('docker', ['restart', h.container], { stdio: 'pipe' });
    for (let i = 0; i < 30; i++) {
      try {
        h.sql('select 1;');
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    await sign(d);
    const after = await getNumberingContext(h.db, f.actor, d.id);
    assert.equal(after.reservation.id, before.reservation.id);
    assert.equal(after.reservation.state, 'signed');
  });
  await test('falha após upload conserva artefato original e reconcilia sem segunda assinatura', async () => {
    const d = f.document();
    await reserve(d);
    await assert.rejects(
      sign(
        d,
        {},
        {
          ...store,
          put: async (p, b) => {
            await store.put(p, b);
            throw Error('interrupção sintética após upload');
          },
        },
      ),
    );
    const ctx = await getNumberingContext(h.db, f.actor, d.id);
    assert.equal(ctx.reservation.state, 'uncertain');
    const before = calls;
    await sign(d);
    assert.equal(calls, before);
  });
  await test('arquivo ausente ou adulterado não é regenerado', async () => {
    const d = f.document();
    await reserve(d);
    const result = await sign(d),
      before = calls;
    await writeFile(join(root, result.signedPdfPath), 'corrompido');
    await assert.rejects(sign(d), /inconsistente/i);
    await rm(join(root, result.signedPdfPath));
    await assert.rejects(sign(d), /recuperado/i);
    assert.equal(calls, before);
  });
  for (const competitors of [2, 10])
    await test(`${competitors} conexões disputam o último número: somente uma reserva e estoque zero`, async () => {
      const one = fixture({ last: 1 }),
        docs = Array.from({ length: competitors }, () => one.document());
      const r = await Promise.allSettled(
        docs.map((d) => reserveDocument(h.db, one.actor, d.id)),
      );
      assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(one.count(), '1');
      assert.equal(
        h.sql(
          `select last_suffix-next_suffix+1 from sncr_batches where request_id='${one.request}';`,
        ),
        '0',
      );
      assert.equal(
        h.sql(
          `select count(*) from sncr_reservations where clinic_id='${one.actor.clinicId}';`,
        ),
        '1',
      );
    });
  await test('configuração padrão, Vercel, Supabase remoto e ausência de sandbox mantêm bloqueio', async () => {
    const d = f.document();
    for (const [k, v] of [
      ['PSYWRITE_SNCR_MODE', ''],
      ['NODE_ENV', 'production'],
      ['VERCEL', '1'],
      ['NEXT_PUBLIC_SUPABASE_URL', 'https://remote.example'],
    ]) {
      const prev = process.env[k];
      process.env[k] = v;
      try {
        assert.equal(localSimulationEnabled(), false);
        await assert.rejects(reserve(d), /bloqueada/i);
      } finally {
        if (prev === undefined) delete process.env[k];
        else process.env[k] = prev;
      }
    }
    const no = fixture({ sandbox: false });
    await assert.rejects(
      reserveDocument(h.db, no.actor, no.document().id),
      /bloqueada/i,
    );
  });
  await test('abandono autorizado é idempotente, terminal e não devolve o número', async () => {
    const d = f.document();
    await reserve(d);
    const before = f.count();
    const a = await abandonReservation(
      h.db,
      f.actor,
      d.id,
      'document_abandoned',
    );
    const b = await abandonReservation(
      h.db,
      f.actor,
      d.id,
      'document_abandoned',
    );
    assert.equal(a.reservation.id, b.reservation.id);
    assert.equal(b.reservation.state, 'abandoned');
    assert.equal(f.count(), before);
    await assert.rejects(sign(d));
  });
  await test('conclusão já confirmada não é rebaixada por relato tardio de timeout', async () => {
    const d = f.document();
    await reserve(d);
    await sign(d);
    const ctx = await getNumberingContext(h.db, f.actor, d.id);
    const again = await sncrRpc(h.db, 'sncr_mark_uncertain', {
      ...actorArgs(f.actor, d.id),
      p_attempt: ctx.reservation.attempt_id,
    });
    assert.equal(again.reservation.state, 'signed');
    assert.equal(again.document.status, 'SIGNED');
  });
  await test('notificação B usa seu próprio lote e modalidade no fluxo local', async () => {
    const b = fixture({ modality: 'notificacao_b' }),
      d = b.document({
        text: 'Modalidade: Notificação de Receita B\n\nMED001',
      });
    await reserveDocument(h.db, b.actor, d.id);
    const result = await signReservedSimulation(h.db, b.actor, d.id, store, {
      provider,
    });
    assert.equal(result.simulation, true);
    const ctx = await getNumberingContext(h.db, b.actor, d.id);
    assert.equal(ctx.reservation.modality, 'notificacao_b');
    assert.equal(ctx.reservation.state, 'signed');
  });
  await test('receita simples continua gerando PDF sem numeração nem reserva', async () => {
    const d = f.document({
      text: 'Modalidade: Receita simples\n\nMED001 - Uso sintético',
    });
    const text = await textOf(await documentPdf(d, { isDraft: true }));
    assert.match(text, /MED001/);
    assert.ok(!text.includes('SIMULADO.'));
    await assert.rejects(reserve(d));
    const inconsistent=f.document({text:'Modalidade: Receita simples\nSNCR: MANUAL.001\n\nMED001'});
    const entry=new DocumentSigningService(()=>h.applicationDb);
    await assert.rejects(entry.signClinicalDocument({db:h.applicationDb,...f.actor,documentId:inconsistent.id}),/manual incompatível/i);
  });
} finally {
  h.cleanup();
  await rm(root, { recursive: true, force: true });
  for (const k of keys)
    old[k] === undefined ? delete process.env[k] : (process.env[k] = old[k]);
}
