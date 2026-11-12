import { expect, type Page } from '@playwright/test';
const clinic = 'aaaaaaaa-0000-4000-8000-000000000001';
const uid = 'bbbbbbbb-0000-4000-8000-000000000001';
export const patient = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  name: 'Paciente Sintético',
  social_name: '',
  dob: '1990-01-01',
  cpf: '',
  phone: '',
  email: '',
  sex: '',
  version: 1,
  created_at: 0,
  updated_at: 0,
  draft_key: 'synthetic',
};
// Sessão sintética: o app se comporta como se a pessoa já tivesse entrado. Tudo o que iria para
// o Supabase (auth, vínculo com a clínica, Storage) é respondido aqui, sem rede de verdade.
export async function signIn(page: Page, role = 'owner') {
  const user = {
    id: uid,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'synthetic@example.invalid',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    factors: [],
  };
  const claims = Buffer.from(
    JSON.stringify({
      sub: uid,
      role: 'authenticated',
      aal: 'aal2',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  const session = {
    access_token: `e30.${claims}.c3ludGhldGlj`,
    refresh_token: 'synthetic',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  };
  await page.addInitScript(
    (value) => localStorage.setItem('sb-127-auth-token', JSON.stringify(value)),
    session,
  );
  await page.route('http://127.0.0.1:54329/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path.includes('/auth/v1/user')
      ? user
      : path.endsWith('/clinic_members')
        ? [{ clinic_id: clinic, role, clinics: { name: 'Clínica Sintética' } }]
        : path.endsWith('/clinics')
          ? { require_mfa: false }
          : path.endsWith('/clinic_features')
            ? { features: [] }
            : [];
    await route.fulfill({ json: data });
  });
}
// Sessão e API sintéticas do consultório, sem abrir nenhuma tela. Devolve o estado que os testes
// consultam e alteram.
export async function mockApi(page: Page, role = 'owner') {
  await signIn(page, role);
  const state = {
    clinicalRequests: [] as string[],
    medicationState: {
      state: 'unknown',
      version: 0,
      available: true,
      reviewed_at: null as string | null,
    },
    failure: false,
    conflict: false,
    signatures: 0,
    saves: 0,
    unhandled: [] as string[],
    consultation: {
      id: 'dddddddd-0000-4000-8000-000000000001',
      patient_id: patient.id,
      text: 'Texto inicial sintético',
      version: 1,
      created_at: '2026-11-01T12:00:00Z',
      updated_at: '2026-11-01T12:00:00Z',
      finalized_at: null as string | null,
      author_id: uid,
      finalized_by: null,
      status: 'DRAFT',
      consultation_addenda: [],
    },
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    let data: unknown;
    if (
      [
        '/api/consultations',
        '/api/clinical-context',
        '/api/documents',
      ].includes(path)
    )
      state.clinicalRequests.push(path);
    if (path === '/api/patients')
      data = url.searchParams.has('id')
        ? { patient }
        : { patients: [patient], total: 1 };
    else if (path === '/api/consultations') {
      if (role === 'secretary')
        return route.fulfill({
          status: 403,
          json: { error: 'Acesso restrito.' },
        });
      if (request.method() === 'POST') {
        state.saves++;
        if (state.failure)
          return route.fulfill({
            status: 503,
            json: { error: 'Falha sintética de rede.' },
          });
        if (state.conflict)
          return route.fulfill({
            status: 409,
            json: { error: 'Registro alterado em outra janela.' },
          });
        const payload = request.postDataJSON();
        if (payload.version !== state.consultation.version)
          return route.fulfill({
            status: 409,
            json: { error: 'Conflito de versão.' },
          });
        state.consultation = {
          ...state.consultation,
          text: payload.text,
          version: state.consultation.version + 1,
          updated_at: new Date().toISOString(),
        };
        data = { consultation: state.consultation };
      } else data = { consultations: [state.consultation] };
    } else if (path === '/api/clinical-context') {
      if (request.method() === 'POST') {
        state.medicationState = {
          ...state.medicationState,
          state: request.postDataJSON().state,
          version: state.medicationState.version + 1,
          reviewed_at: new Date().toISOString(),
        };
        data = { record: state.medicationState };
      } else
        data = {
          conditions: [],
          medications: [],
          allergies: [],
          allergyState: { state: 'unknown', version: 0 },
          medicationState: state.medicationState,
          consultationDiagnoses: [],
        };
    } else if (path === '/api/capture')
      data = { attachments: [], request: null, connected: false };
    else if (path === '/api/exams') data = { definitions: [], results: [] };
    else if (path === '/api/documents') data = { documents: [] };
    else if (path === '/api/imports') data = { total: 0, records: [] };
    else if (path === '/api/digital-signature/providers')
      data = { providers: ['birdid'] };
    else if (path === '/api/digital-signature/session')
      data = {
        active: true,
        session: {
          provider: 'birdid',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      };
    else if (path === '/api/digital-signature/sign-evolution') {
      state.signatures++;
      data = { success: true };
    } else if (path === '/api/professional-profile') data = { profile: null };
    else if (path === '/api/prescription-templates') data = { templates: [] };
    else if (path === '/api/platform') data = { enabled: false, clinics: [] };
    else if (path === '/api/backup-status')
      data = { available: true, verified: null, external: null };
    else {
      state.unhandled.push(path);
      data = {};
    }
    await route.fulfill({ json: data });
  });
  return state;
}
/** Abre o prontuário do paciente sintético, como a maioria dos testes precisa. */
export async function setup(page: Page, role = 'owner') {
  const state = await mockApi(page, role);
  await page.goto('/');
  await page.getByRole('button', { name: /Paciente Sintético/ }).click();
  if (role !== 'secretary')
    await expect(page.getByLabel('Evolução em texto livre')).toHaveValue(
      state.consultation.text,
    );
  return state;
}
