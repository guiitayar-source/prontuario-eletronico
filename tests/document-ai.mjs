import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { documentAi } from '../lib/supabase/document-ai.ts';

const raw = execFileSync(
  'node_modules/.bin/supabase',
  ['status', '-o', 'json'],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  },
);
const status = JSON.parse(raw.slice(raw.indexOf('{')));
assert.match(status.API_URL, /^http:\/\/127\.0\.0\.1:/);
process.env.NEXT_PUBLIC_SUPABASE_URL = status.API_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = status.PUBLISHABLE_KEY;
process.env.OPENAI_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = 'test-key';

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
};
const admin = createClient(status.API_URL, status.SECRET_KEY, clientOptions);
const users = [];
let clinic;

async function createUser() {
  const email = `document-ai-${crypto.randomUUID()}@example.invalid`;
  const password = 'Local_Test_123456789';
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  users.push(created.data.user.id);
  const db = createClient(
    status.API_URL,
    status.PUBLISHABLE_KEY,
    clientOptions,
  );
  const login = await db.auth.signInWithPassword({ email, password });
  assert.ifError(login.error);
  return {
    db,
    id: created.data.user.id,
    token: login.data.session.access_token,
  };
}

async function call(account, data) {
  const response = await documentAi(
    new Request('http://test.local/api/document-ai', {
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${account.token}`,
        'X-Clinic-Id': clinic,
        'X-Document-AI-Action': '1',
        Origin: 'http://test.local',
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    }),
  );
  return response;
}

const originalFetch = globalThis.fetch;
let openAiRequest;
let geminiRequest;

try {
  const doctor = await createUser();
  const secretary = await createUser();
  const createdClinic = await doctor.db.rpc('create_clinic', {
    clinic_name: 'IA de documentos teste',
  });
  assert.ifError(createdClinic.error);
  clinic = createdClinic.data;
  assert.ifError(
    (
      await admin.from('clinic_members').insert({
        clinic_id: clinic,
        user_id: secretary.id,
        role: 'secretary',
      })
    ).error,
  );
  assert.ifError(
    (
      await admin.from('patients').insert({
        clinic_id: clinic,
        id: 'synthetic-ai-doc',
        name: 'Paciente Sintético',
      })
    ).error,
  );
  const consultationId = crypto.randomUUID();
  const createdConsultation = await doctor.db.rpc('consultation_write', {
    c: clinic,
    action: 'create',
    d: { id: consultationId, patient_id: 'synthetic-ai-doc' },
  });
  assert.ifError(createdConsultation.error);
  const savedConsultation = await doctor.db.rpc('consultation_write', {
    c: clinic,
    action: 'save',
    d: {
      id: consultationId,
      version: 1,
      text: 'Paciente apresenta melhora do sono. Manter acompanhamento.',
    },
  });
  assert.ifError(savedConsultation.error);

  assert.equal((await call(secretary)).status, 403);
  let response = await call(doctor);
  assert.equal(response.status, 200);
  let payload = await response.json();
  assert.equal(payload.templates.length, 0);
  assert.ok(payload.models.some((item) => item.id === 'openai-luna'));

  const templateId = crypto.randomUUID();
  response = await call(doctor, {
    action: 'save-template',
    id: templateId,
    kind: 'Relatório',
    name: 'Continuidade do tratamento',
    instructions:
      'Produza um relatório conciso para continuidade do tratamento.',
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.template.name, 'Continuidade do tratamento');
  assert.equal((await (await call(doctor)).json()).templates.length, 1);

  assert.ifError(
    (
      await doctor.db
        .from('patients')
        .select('name,social_name')
        .eq('clinic_id', clinic)
        .eq('id', 'synthetic-ai-doc')
        .maybeSingle()
    ).error,
  );
  assert.ifError(
    (
      await doctor.db
        .from('consultations')
        .select('text,created_at,consultation_addenda(text,created_at)')
        .eq('clinic_id', clinic)
        .eq('patient_id', 'synthetic-ai-doc')
        .eq('id', consultationId)
        .maybeSingle()
    ).error,
  );
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.openai.com/v1/responses') {
      openAiRequest = JSON.parse(init.body);
      return Response.json({
        status: 'completed',
        output_text: 'Relatório clínico sintético para revisão médica.',
        usage: { input_tokens: 320, output_tokens: 40, total_tokens: 360 },
      });
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiRequest = JSON.parse(init.body);
      return Response.json({
        candidates: [
          {
            content: {
              parts: [{ text: 'Rascunho sintético do Gemini.' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 280,
          candidatesTokenCount: 35,
          totalTokenCount: 315,
        },
      });
    }
    return originalFetch(input, init);
  };

  response = await call(doctor, {
    action: 'generate',
    patientId: 'synthetic-ai-doc',
    consultationId,
    kind: 'Relatório',
    documentDate: '2026-09-20',
    modelId: 'openai-mini',
    instructions: 'Seja objetivo.',
    includeConsultation: true,
    includeClinicalContext: false,
    currentText: '',
  });
  payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  assert.equal(
    payload.draft,
    'Relatório clínico sintético para revisão médica.',
  );
  assert.equal(payload.usage.totalTokens, 360);
  assert.equal(openAiRequest.store, false);
  assert.match(openAiRequest.input, /melhora do sono/);
  assert.match(
    openAiRequest.instructions,
    /exclusivamente os fatos fornecidos/,
  );

  response = await call(doctor, {
    action: 'generate',
    patientId: 'synthetic-ai-doc',
    consultationId: null,
    kind: 'Atestado',
    documentDate: '2026-09-20',
    modelId: 'openai-luna',
    instructions: 'Use apenas fatos explícitos.',
    includeConsultation: false,
    includeClinicalContext: false,
    currentText: '',
  });
  payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  assert.deepEqual(openAiRequest.reasoning, { effort: 'low' });

  response = await call(doctor, {
    action: 'generate',
    patientId: 'synthetic-ai-doc',
    consultationId: null,
    kind: 'Relatório',
    documentDate: '2026-09-20',
    modelId: 'gemini-flash',
    instructions: 'Use linguagem concisa.',
    includeConsultation: false,
    includeClinicalContext: false,
    currentText: '',
  });
  payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  assert.equal(payload.draft, 'Rascunho sintético do Gemini.');
  assert.equal(payload.usage.totalTokens, 315);
  assert.match(
    geminiRequest.systemInstruction.parts[0].text,
    /revisão de um médico/,
  );
  assert.equal(
    (
      await admin
        .from('audit_events')
        .select('id')
        .eq('clinic_id', clinic)
        .eq('action', 'ai_document_request')
    ).data.length,
    3,
  );

  response = await call(doctor, { action: 'delete-template', id: templateId });
  assert.equal(response.status, 200);
  assert.equal((await (await call(doctor)).json()).templates.length, 0);
  console.log(
    'PASS: modelos pessoais, bloqueio de secretaria, contexto selecionado, geração sem retenção e auditoria.',
  );
} finally {
  globalThis.fetch = originalFetch;
  if (clinic) {
    for (const table of [
      'document_ai_templates',
      'consultation_addenda',
      'consultations',
      'audit_events',
      'patients',
      'clinic_members',
      'clinics',
    ]) {
      const column = table === 'clinics' ? 'id' : 'clinic_id';
      assert.ifError(
        (await admin.from(table).delete().eq(column, clinic)).error,
      );
    }
  }
  for (const id of users)
    assert.ifError((await admin.auth.admin.deleteUser(id)).error);
}
