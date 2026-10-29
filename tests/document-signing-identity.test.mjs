// Apenas dados sintéticos, banco em memória e assinaturas CMS simuladas. Sem rede.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { encryptToken } from '../lib/signature/crypto-utils.ts';
import { documentKinds } from '../lib/document-fields.ts';

const moduleRoot = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,next){if(s.startsWith('@/'))return next(new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?'':'.ts'),${JSON.stringify(moduleRoot)}).href,c);return next(s,c);}`), import.meta.url);
const { DocumentSigningService } = await import('../lib/signature/document-signing-service.ts');
const { setCustomSignatureProvider } = await import('../lib/signature/provider-factory.ts');
const oldFetch = globalThis.fetch;
const oldKey = process.env.SIGNATURE_ENCRYPTION_KEY;
process.env.SIGNATURE_ENCRYPTION_KEY = 'synthetic-identity-test-key';
globalThis.fetch = async () => { throw Error('Rede proibida neste teste.'); };
after(() => { globalThis.fetch = oldFetch; setCustomSignatureProvider(null); if (oldKey === undefined) delete process.env.SIGNATURE_ENCRYPTION_KEY; else process.env.SIGNATURE_ENCRYPTION_KEY = oldKey; });
const cpf = '52998224725', otherCpf = '11144477735';
const matching = new MockBirdIdProvider({ mockCpf: cpf, doctorName: 'TITULAR SINTETICO' });
const different = new MockBirdIdProvider({ mockCpf: otherCpf, doctorName: 'OUTRO TITULAR SINTETICO' });
const authorizedCertificate = (await matching.getCertificates('synthetic'))[0];

function fixture({ kind = 'Receita', document = {}, session = {}, profile = {}, provider = matching, lockError = false, onSign } = {}) {
  const actor = { clinicId: 'synthetic-clinic', userId: 'synthetic-author' };
  const doc = { id: 'synthetic-document', clinic_id: actor.clinicId, author_id: actor.userId, kind, status: 'DRAFT', patient_id: 'synthetic-patient', consultation_id: null, patient_name: 'Paciente sintetico', physician_name: 'Titular sintetico', physician_registration: 'CRM 12345 SP', version: 1, document_date: '2026-10-28', text: kind === 'Receita' ? 'Modalidade: Receita simples\nVia de administração: Uso oral\n\nMED001 - prescricao sintetica' : 'Documento sintetico sem validade clinica.', ...document };
  const active = { id: 'synthetic-session', clinic_id: actor.clinicId, user_id: actor.userId, provider: 'birdid', cpf, certificate_raw: authorizedCertificate.rawPem, certificate_alias: 'synthetic-certificate', certificate_subject: 'CN=TITULAR SINTETICO', certificate_issuer: 'synthetic', access_token_encrypted: encryptToken('synthetic-local-only'), expires_at: '2099-01-01T00:00:00Z', revoked: false, ...session };
  const registered = { clinic_id: actor.clinicId, user_id: actor.userId, cpf, physician_registration: doc.physician_registration, ...profile };
  const audits = [], signatures = [], files = new Map();
  let calls = 0;
  const db = {
    from(table) {
      let op = 'select', value;
      const filters = [];
      const row = () => table === 'clinical_documents' ? doc : table === 'signature_sessions' ? active : table === 'document_profiles' ? registered : null;
      const matches = r => !!r && filters.every(([k, fn]) => fn(r[k]));
      let result;
      const execute = () => {
        if (result) return result;
        if (op === 'insert') {
          if (table === 'audit_events') audits.push(structuredClone(value));
          if (table === 'digital_signatures') signatures.push(structuredClone(value));
          return result = { data: { id: 'synthetic-signature', ...value }, error: null };
        }
        const r = row();
        if (!matches(r)) return result = { data: null, error: null };
        if (op === 'update') {
          if (lockError && value.status === 'SIGNING') return result = { data: null, error: { message: 'synthetic lock error' } };
          Object.assign(r, value);
        }
        return result = { data: structuredClone(r), error: null };
      };
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { filters.push([k, x => x === v]); return q; },
        gt(k, v) { filters.push([k, x => x > v]); return q; },
        in(k, values) { filters.push([k, x => values.includes(x)]); return q; },
        update(v) { op = 'update'; value = v; return q; },
        insert(v) { op = 'insert'; value = v; return q; },
        async maybeSingle() { return execute(); }, async single() { return execute(); },
        // eslint-disable-next-line unicorn/no-thenable -- Contrato awaitable do QueryBuilder Supabase.
        then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
      };
      return q;
    },
    storage: { from: () => ({ upload: async (path, bytes) => { files.set(path, bytes); return { error: null }; } }) },
  };
  setCustomSignatureProvider({ signHash: async p => { calls++; await onSign?.(doc); return provider.signHash(p); } });
  return { actor, doc, session: active, profile: registered, audits, signatures, files, calls: () => calls, sign: () => new DocumentSigningService(() => db).signClinicalDocument({ db, ...actor, documentId: doc.id }) };
}

for (const kind of documentKinds) {
  test(`${kind}: autor correto e certificado correspondente`, async () => {
    const f = fixture({ kind });
    assert.equal((await f.sign()).success, true);
    assert.equal(f.doc.status, 'SIGNED');
    assert.equal(f.signatures[0].cpf_from_certificate, cpf);
    assert.equal(f.signatures[0].document_version, 1);
    assert.equal(f.signatures[0].verification_status, 'UNVERIFIED');
  });
  test(`${kind}: outro medico da mesma clinica nao tem delegacao implicita`, async () => {
    const f = fixture({ kind, document: { author_id: 'other-synthetic-doctor' } });
    await assert.rejects(f.sign(), { status: 403 });
    assert.equal(f.calls(), 0);
    assert.equal(f.doc.status, 'DRAFT');
    assert.equal(f.signatures.length, 0);
  });
}
test('VIDaaS usa a mesma politica de identidade', async () => {
  const f = fixture({ session: { provider: 'vidaas' } });
  assert.equal((await f.sign()).success, true);
  assert.equal(f.signatures[0].provider, 'vidaas');
});
test('documento de outra clinica nao e encontrado', async () => {
  const f = fixture({ document: { clinic_id: 'other-clinic' } });
  await assert.rejects(f.sign(), { status: 404 });
  assert.equal(f.calls(), 0);
});
for (const profile of [{ cpf: otherCpf }, { cpf: '' }]) {
  test(`perfil e sessao sem identidade correspondente bloqueiam antes do provedor (${profile.cpf ? 'divergencia' : 'ausencia'})`, async () => {
    const f = fixture({ profile });
    await assert.rejects(f.sign(), { status: 403 });
    assert.equal(f.calls(), 0);
    assert.equal(f.signatures.length, 0);
  });
}
test('CPF do certificado divergente bloqueia conclusao e repeticao automatica', async () => {
  const f = fixture({ provider: different });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.signatures.length, 0);
  assert.equal(f.doc.status, 'SIGNING');
  assert.equal(f.files.size, 0);
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.calls(), 1);
  const logs = JSON.stringify(f.audits);
  assert.ok(f.audits.some(a => a.context?.reason === 'certificate_identity_mismatch'));
  for (const sensitive of [cpf, otherCpf, 'synthetic-local-only', f.doc.text]) assert.ok(!logs.includes(sensitive));
});
test('CPF ausente no certificado nao recebe fallback da sessao', async () => {
  const f = fixture({ provider: new MockBirdIdProvider({ mockCpf: 'SEMCPF', doctorName: 'SINTETICO' }) });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.doc.status, 'SIGNING');
  assert.equal(f.signatures.length, 0);
});
test('mesmo CPF com certificado e chave diferentes exige nova autorizacao', async () => {
  const f = fixture({ provider: new MockBirdIdProvider({ mockCpf: cpf, doctorName: 'OUTRA CHAVE SINTETICA' }) });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.signatures.length, 0);
  assert.equal(f.doc.status, 'SIGNING');
});
test('sessao antiga sem certificado autorizado exige reconexao', async () => {
  const f = fixture({ session: { certificate_raw: null } });
  await assert.rejects(f.sign(), { status: 403 });
  assert.equal(f.calls(), 0);
});
test('erro de aquisicao do documento impede chamada externa', async () => {
  const f = fixture({ lockError: true });
  await assert.rejects(f.sign());
  assert.equal(f.calls(), 0);
});
test('versao em assinatura nao pode iniciar outra tentativa', async () => {
  const f = fixture({ document: { status: 'SIGNING' } });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.calls(), 0);
});
test('mudanca de versao durante o provedor nao assina o documento atual', async () => {
  const f = fixture({ onSign: doc => { doc.version++; } });
  await assert.rejects(f.sign(), { status: 409 });
  assert.notEqual(f.doc.status, 'SIGNED');
});
test('revogacao da sessao durante a chamada externa deixa pendencia', async () => {
  const f = fixture({ onSign: () => { f.session.revoked = true; } });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.signatures.length, 0);
  assert.equal(f.doc.status, 'SIGNING');
});
test('identidade alterada: CPF do perfil muda durante a chamada externa', async () => {
  const f = fixture({ onSign: () => { f.profile.cpf = otherCpf; } });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.signatures.length, 0);
  assert.equal(f.doc.status, 'SIGNING');
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.calls(), 1);
});
test('identidade alterada: certificado autorizado muda durante a chamada externa', async () => {
  const replacement = (await new MockBirdIdProvider({ mockCpf: cpf, doctorName: 'OUTRA CHAVE SINTETICA' }).getCertificates('synthetic'))[0];
  const f = fixture({ onSign: () => { f.session.certificate_raw = replacement.rawPem; } });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.signatures.length, 0);
  assert.equal(f.doc.status, 'SIGNING');
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.calls(), 1);
});
test('erro externo conserva tentativa e nao vaza mensagens do provedor', async () => {
  const f = fixture({ provider: { signHash: async () => { throw Error(`synthetic-local-only ${cpf} ${otherCpf}`); } } });
  await assert.rejects(f.sign(), { status: 409 });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.calls(), 1);
  assert.equal(f.doc.status, 'SIGNING');
  assert.equal(f.signatures.length, 0);
  const started = f.audits.find(a => a.action === 'document.signature_started');
  const pending = f.audits.find(a => a.action === 'document.signature_pending');
  assert.equal(started.context.attempt_id, pending.context.attempt_id);
  assert.match(pending.context.document_hash, /^[a-f0-9]{64}$/);
  for (const secret of [cpf, otherCpf, 'synthetic-local-only']) assert.ok(!JSON.stringify(f.audits).includes(secret));
});
test('CMS para outro resumo nao autoriza o documento', async () => {
  const f = fixture({ provider: { signHash: p => matching.signHash({ ...p, hashHex: '00'.repeat(32) }) } });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.signatures.length, 0);
  assert.equal(f.doc.status, 'SIGNING');
});
test('identidade vem do certificado verificado, nao do primeiro com mesmo serial', async () => {
  const decoy = await matching.getCertificates('synthetic');
  const provider = { signHash: async p => {
    const signed = await different.signHash(p);
    const raw = Buffer.from(signed.cmsSignatureBase64, 'base64');
    const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(raw).result });
    const data = new pkijs.SignedData({ schema: info.content });
    const der = Buffer.from(decoy[0].rawPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
    data.certificates.unshift(new pkijs.Certificate({ schema: asn1js.fromBER(der).result }));
    info.content = data.toSchema();
    return { ...signed, cmsSignatureBase64: Buffer.from(info.toSchema().toBER()).toString('base64') };
  } };
  const f = fixture({ provider });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.signatures.length, 0);
});
test('certificado ausente no CMS falha sem conclusao', async () => {
  const f = fixture({ provider: { signHash: async p => {
    const signed = await matching.signHash(p);
    const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(Buffer.from(signed.cmsSignatureBase64, 'base64')).result });
    const data = new pkijs.SignedData({ schema: info.content });
    data.certificates = [];
    info.content = data.toSchema();
    return { ...signed, cmsSignatureBase64: Buffer.from(info.toSchema().toBER()).toString('base64') };
  } } });
  await assert.rejects(f.sign());
  assert.equal(f.signatures.length, 0);
  assert.notEqual(f.doc.status, 'SIGNED');
});

test('CMS com valor de assinatura corrompido nao conclui nem admite retry', async () => {
  const f = fixture({ provider: { signHash: async p => {
    const signed = await matching.signHash(p);
    const info = new pkijs.ContentInfo({ schema: asn1js.fromBER(Buffer.from(signed.cmsSignatureBase64, 'base64')).result });
    const data = new pkijs.SignedData({ schema: info.content });
    data.signerInfos[0].signature.valueBlock.valueHexView[0] ^= 1;
    info.content = data.toSchema();
    return { ...signed, cmsSignatureBase64: Buffer.from(info.toSchema().toBER()).toString('base64') };
  } } });
  await assert.rejects(f.sign(), { status: 409 });
  await assert.rejects(f.sign(), { status: 409 });
  assert.equal(f.calls(), 1);
  assert.equal(f.signatures.length, 0);
  assert.equal(f.doc.status, 'SIGNING');
});

function oauthFixture(profileCpf = cpf) {
  const sessions = [], audits = [];
  const actor = { clinicId: 'synthetic-clinic', userId: 'synthetic-author' };
  const state = { id: 'synthetic-state', clinic_id: actor.clinicId, user_id: actor.userId, provider: 'birdid', code_verifier_encrypted: encryptToken('synthetic-verifier'), redirect_uri: 'https://synthetic.invalid/callback' };
  const db = { from(table) {
    let value;
    const q = { select: () => q, eq: () => q, gt: () => q, delete: () => q, update: () => q,
      insert(v) { value = v; if (table === 'signature_sessions') sessions.push(v); if (table === 'audit_events') audits.push(v); return q; },
      async maybeSingle() { return { data: table === 'signature_oauth_states' ? state : { cpf: profileCpf, physician_name: 'Titular sintetico' }, error: null }; },
      async single() { return { data: { id: 'synthetic-session', ...value }, error: null }; },
      // eslint-disable-next-line unicorn/no-thenable -- Contrato awaitable do QueryBuilder Supabase.
      then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject); },
    }; return q;
  } };
  return { sessions, audits, complete: () => new DocumentSigningService(() => db).handleOAuthCallback({ db, ...actor, code: 'synthetic-code', state: 'synthetic-state' }) };
}
test('autorizacao OAuth conserva o certificado X509 para confronto posterior', async () => {
  setCustomSignatureProvider(matching);
  const f = oauthFixture();
  await f.complete();
  assert.equal(f.sessions[0].certificate_raw, authorizedCertificate.rawPem);
  assert.equal(f.sessions[0].cpf, cpf);
  assert.ok(!JSON.stringify(f.audits).includes(cpf));
});
test('CPF declarado no OAuth nao substitui CPF ausente no certificado', async () => {
  const noCpf = new MockBirdIdProvider({ mockCpf: 'SEMCPF', doctorName: 'SINTETICO' });
  setCustomSignatureProvider({
    exchangeAuthorizationCode: async () => ({ accessToken: 'synthetic', expiresIn: 3600, cpf }),
    getCertificates: async () => (await noCpf.getCertificates('synthetic')).map(c => ({ ...c, cpf })),
  });
  const f = oauthFixture();
  await assert.rejects(f.complete(), { status: 422 });
  assert.equal(f.sessions.length, 0);
});
test('divergencia na autorizacao OAuth e auditavel sem CPF em mensagem ou log', async () => {
  setCustomSignatureProvider(matching);
  const f = oauthFixture(otherCpf);
  await assert.rejects(f.complete(), error => error.status === 403 && !error.message.includes(cpf) && !error.message.includes(otherCpf));
  assert.equal(f.sessions.length, 0);
  assert.equal(f.audits[0].context.reason, 'certificate_profile_identity_mismatch');
  for (const sensitive of [cpf, otherCpf]) assert.ok(!JSON.stringify(f.audits).includes(sensitive));
});
