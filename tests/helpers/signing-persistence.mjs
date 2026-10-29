// Somente fixtures locais: PostgreSQL/PostgREST reais; bytes da Storage/PSC simulados.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, fork } from 'node:child_process';
import { register } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { createSignatureTrustDb } from './signature-trust-db.mjs';
import { startSignatureTrustRest } from './signature-trust-rest.mjs';
import { containerEngine } from './sncr-container.mjs';
import { MockBirdIdProvider } from '../../lib/signature/mock-birdid-provider.ts';
import { encryptToken } from '../../lib/signature/crypto-utils.ts';
const root = new URL('../../', import.meta.url).href;
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,next){if(s.startsWith('@/'))return next(new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?'':'.ts'),${JSON.stringify(root)}).href,c);return next(s,c);}`,
    ),
  import.meta.url,
);
const { DocumentSigningService } =
  await import('../../lib/signature/document-signing-service.ts');
const { setCustomSignatureProvider } =
  await import('../../lib/signature/provider-factory.ts');
export async function signingHarness() {
  const h = createSignatureTrustDb({ oauth: true, attempts: true }),
    rest = await startSignatureTrustRest(h);
  const originalFetch = globalThis.fetch,
    oldKey = process.env.SIGNATURE_ENCRYPTION_KEY;
  process.env.SIGNATURE_ENCRYPTION_KEY = 'synthetic-6e-encryption-key';
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    assert.equal(
      u.origin,
      'http://signature.synthetic',
      'Rede externa bloqueada.',
    );
    return rest.fetch(req);
  };
  const backend = createClient(
    'http://signature.synthetic',
    rest.jwt('service_role'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const provider = new MockBirdIdProvider({
    mockCpf: '52998224725',
    doctorName: 'TITULAR SINTETICO 6E',
  });
  const cert = (await provider.getCertificates('synthetic'))[0];
  function asyncSql(statement, role = 'service_role') {
    return new Promise((resolve, reject) => {
      const p = spawn(containerEngine, [
        'exec',
        '-i',
        h.container,
        'psql',
        '-X',
        '-U',
        'supabase_admin',
        '-d',
        h.database,
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=verbose',
        '-qAt',
      ]);
      let out = '',
        err = '';
      const timer = setTimeout(() => {
        p.kill();
        reject(Error('Timeout no ensaio SQL.'));
      }, 45000);
      p.stdout.on('data', (b) => (out += b));
      p.stderr.on('data', (b) => (err += b));
      p.on('error', reject);
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code) reject(Object.assign(Error(err), { stderr: err }));
        else resolve(out.trim());
      });
      p.stdin.end(
        `set role ${role};set statement_timeout='15s';set request.jwt.claims=${h.lit({ role, aal: 'aal2' })};${statement}`,
      );
    });
  }
  const statement = (args) =>
    `select public.document_signing_operation(${Object.entries(args)
      .map(([k, v]) => {
        assert.match(k, /^p_[a-z_]+$/);
        return `${k}=>${h.lit(v)}`;
      })
      .join(',')});`;
  async function fixture({
    kind = 'Atestado',
    text = 'Documento sintetico sem validade clinica.',
  } = {}) {
    const actor = { clinicId: randomUUID(), userId: randomUUID() },
      documentId = randomUUID(),
      sessionId = randomUUID();
    h.sql(`insert into auth.users values('${actor.userId}');insert into clinics(id,name) values('${actor.clinicId}','Clínica sintética 6E');insert into clinic_members(clinic_id,user_id,role) values('${actor.clinicId}','${actor.userId}','doctor');
  insert into patients(clinic_id,id,name,cpf,street,address_number,city,state) values('${actor.clinicId}','synthetic','Paciente sintético','52998224725','Rua Sintética','100','Cidade Teste','SP');
  insert into document_profiles(clinic_id,user_id,physician_name,physician_registration,cpf) values('${actor.clinicId}','${actor.userId}','Titular sintético','CRM 12345 SP','52998224725');
  insert into clinical_documents(id,clinic_id,author_id,patient_id,kind,text,physician_name,physician_registration,patient_name,document_date,version) values('${documentId}','${actor.clinicId}','${actor.userId}','synthetic',${h.lit(kind)},${h.lit(text)},'Titular sintético','CRM 12345 SP','Paciente sintético','2026-10-29',1);
  insert into signature_sessions(id,clinic_id,user_id,provider,cpf,certificate_alias,certificate_subject,certificate_issuer,certificate_valid_from,certificate_valid_to,certificate_raw,access_token_encrypted,expires_at) values('${sessionId}','${actor.clinicId}','${actor.userId}','birdid','52998224725',${h.lit(cert.alias)},${h.lit(cert.subject)},${h.lit(cert.issuer)},now()-interval '1 day',now()+interval '1 day',${h.lit(cert.rawPem)},${h.lit(encryptToken('synthetic-token-only'))},now()+interval '1 day');`);
    const files = new Map(),
      fault = {
        upload: false,
        lostUpload: false,
        download: false,
        rpc: null,
        afterCommit: null,
        beforeHsm: null,
        hsm: null,
      };
    let calls = 0,
      uploads = 0;
    const trace = [];
    const rpc = async (name, args) => {
      trace.push(args.p_action);
      if (name !== 'document_signing_operation') return backend.rpc(name, args);
      if (fault.rpc === args.p_action) {
        fault.rpc = null;
        return {
          data: null,
          error: { code: '08006', message: 'synthetic database failure' },
        };
      }
      try {
        const data = JSON.parse(await asyncSql(statement(args)));
        if (fault.afterCommit === args.p_action) {
          fault.afterCommit = null;
          throw Error('synthetic lost response after COMMIT');
        }
        return { data, error: null };
      } catch (e) {
        const code = e.message.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1] || '08006';
        trace.push('error:' + args.p_action + ':' + code);
        return {
          data: null,
          error: { code, message: 'synthetic database failure' },
        };
      }
    };
    const storage = {
      from: () => ({
        upload: async (path, bytes, options) => {
          assert.equal(options.upsert, false);
          if (fault.upload)
            return { error: { message: 'synthetic storage offline' } };
          if (files.has(path))
            return { error: { message: 'synthetic conflict' } };
          // Sonda real da Storage API: INSERT de permissão com contentLength, revertido.
          h.sql(
            `begin;insert into storage.objects(bucket_id,name,metadata,user_metadata) values('clinical-files',${h.lit(path)},${h.lit({ mimetype: 'application/pdf', contentLength: bytes.length })},${h.lit(options.metadata || {})});rollback;`,
            { role: 'service_role' },
          );
          // Mesmo objeto/metadados que a Storage API publica ao confirmar upload.
          h.sql(
            `insert into storage.objects(bucket_id,name,metadata,user_metadata) values('clinical-files',${h.lit(path)},${h.lit({ size: bytes.length })},${h.lit(options.metadata || {})});`,
            { role: 'service_role' },
          );
          files.set(path, Buffer.from(bytes));
          uploads++;
          return {
            error: fault.lostUpload
              ? { message: 'synthetic lost upload response' }
              : null,
          };
        },
        download: async (path) => ({
          data:
            !fault.download && files.has(path)
              ? new Blob([files.get(path)])
              : null,
          error:
            fault.download || !files.has(path)
              ? { message: 'synthetic unavailable' }
              : null,
        }),
      }),
    };
    const db = { from: backend.from.bind(backend), rpc, storage };
    const hsm = async (p) => {
      calls++;
      await fault.beforeHsm?.();
      if (fault.hsm) return fault.hsm(p);
      return provider.signHash(p);
    };
    setCustomSignatureProvider({ signHash: hsm });
    const key = `document:${documentId}:v1`;
    const params = { db, ...actor, documentId };
    const sign = (overrides = {}) =>
      new DocumentSigningService(() => db).signClinicalDocument({
        ...params,
        ...overrides,
      });
    const args = (action, owner = randomUUID(), data = {}) => ({
      p_action: action,
      p_clinic: actor.clinicId,
      p_user: actor.userId,
      p_document: documentId,
      p_version: 1,
      p_key: key,
      p_owner: owner,
      p_data: data,
    });
    const acquireData = {
      session_id: sessionId,
      cpf: '52998224725',
      fingerprint: cert.fingerprint256,
      certificate_raw: cert.rawPem,
    };
    const attempts = () =>
      JSON.parse(
        h.sql(
          `select coalesce(jsonb_agg(to_jsonb(a)-'artifact_cipher'-'document_snapshot'-'certificate_raw'-'owner_token'),'[]') from document_signing_attempts a where document_id='${documentId}';`,
        ),
      );
    const doc = () =>
      JSON.parse(
        h.sql(
          `select to_jsonb(d) from clinical_documents d where id='${documentId}';`,
        ),
      );
    const signatures = () =>
      JSON.parse(
        h.sql(
          `select coalesce(jsonb_agg(to_jsonb(s)),'[]') from digital_signatures s where document_id='${documentId}';`,
        ),
      );
    return {
      ...actor,
      documentId,
      sessionId,
      key,
      params,
      db,
      files,
      fault,
      trace,
      hsm,
      sign,
      args,
      acquireData,
      attempts,
      doc,
      signatures,
      calls: () => calls,
      uploads: () => uploads,
    };
  }
  async function processSign(f, { killAfter } = {}) {
    return new Promise((resolve, reject) => {
      const child = fork(
        new URL('./signing-process.mjs', import.meta.url),
        [],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      let result;
      let errorText = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('Processo de assinatura excedeu prazo.'));
      }, 90000);
      child.stderr.on('data', (b) => (errorText += b));
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (signal === 'SIGKILL' && killAfter) return resolve({ killed: true });
        if (code) return reject(Error(errorText));
        resolve(result);
      });
      child.on('message', async (message) => {
        if (message.done) {
          result = message;
          return;
        }
        try {
          let r;
          const args = message.args;
          if (message.kind === 'query') {
            let q = f.db.from(args.table);
            for (const [method, values] of args.steps) q = q[method](...values);
            r = await q;
          } else if (message.kind === 'rpc')
            r = await f.db.rpc(args.name, args.args);
          else if (message.kind === 'upload')
            r = await f.db.storage
              .from(args.bucket)
              .upload(args.path, Buffer.from(args.pdf, 'base64'), args.options);
          else if (message.kind === 'download') {
            const v = await f.db.storage.from(args.bucket).download(args.path);
            r = {
              error: v.error,
              pdf: v.data
                ? Buffer.from(await v.data.arrayBuffer()).toString('base64')
                : null,
            };
          } else if (message.kind === 'hsm') r = await f.hsm(args);
          else throw Error('Mensagem de teste desconhecida.');
          if (
            killAfter === message.kind ||
            (message.kind === 'rpc' && killAfter === args.args.p_action)
          ) {
            child.kill('SIGKILL');
            return;
          }
          if (child.connected) child.send({ id: message.id, result: r });
        } catch (error) {
          if (child.connected)
            child.send({ id: message.id, error: error.message });
        }
      });
      child.send({
        start: {
          clinicId: f.clinicId,
          userId: f.userId,
          documentId: f.documentId,
        },
      });
    });
  }
  return {
    h,
    backend,
    provider,
    cert,
    asyncSql,
    statement,
    fixture,
    processSign,
    hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
    cleanup() {
      setCustomSignatureProvider(null);
      globalThis.fetch = originalFetch;
      if (oldKey === undefined) delete process.env.SIGNATURE_ENCRYPTION_KEY;
      else process.env.SIGNATURE_ENCRYPTION_KEY = oldKey;
      rest.cleanup();
      h.cleanup();
    },
  };
}
