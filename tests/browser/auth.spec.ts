// Tela de entrada: login, senha esquecida, primeiro acesso e recuperação de senha, links de convite
// e de ativação, conta sem clínica e saída. O Supabase (Auth e o vínculo com a clínica) é
// sintético: nada sai do navegador.
import { test, expect, type Page, type Route } from '@playwright/test';
import { mockApi, syntheticSession } from './fixtures';

const supabase = 'http://127.0.0.1:54329';
const origin = 'http://127.0.0.1:3107';
const email = 'synthetic@example.invalid';
const clinicA = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const clinicB = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const goodPassword = 'sintetica-12'; // exatamente 12 caracteres, o mínimo

type Call = {
  method: string;
  path: string;
  search: URLSearchParams;
  body: Record<string, unknown> | null;
};
type Failure = 'password' | 'recover' | 'user' | 'verify' | 'pkce' | 'logout' | 'members';

/** Supabase sintético que guarda o que a tela pediu. `signedIn` começa com a sessão guardada. */
async function mockAuth(
  page: Page,
  {
    signedIn = false,
    metadata = {},
  }: { signedIn?: boolean; metadata?: Record<string, unknown> } = {},
) {
  const api = await mockApi(page, 'owner', false);
  const session = syntheticSession(metadata);
  if (signedIn)
    await page.addInitScript(
      (value) => localStorage.setItem('sb-127-auth-token', JSON.stringify(value)),
      session,
    );
  const state = {
    api,
    session,
    calls: [] as Call[],
    members: [
      { clinic_id: clinicA, role: 'owner', clinics: { name: 'Clínica Sintética' } },
    ],
    fail: new Set<Failure>(),
    // Quando preenchido, a resposta do Auth só sai depois que o teste liberar.
    gate: null as Promise<void> | null,
  };
  const refuse = (route: Route, status: number, msg: string, code = 'synthetic') =>
    route.fulfill({ status, json: { code, msg } });
  await page.route(`${supabase}/**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    let body: Record<string, unknown> | null = null;
    try {
      body = request.postDataJSON();
    } catch {}
    state.calls.push({ method: request.method(), path, search: url.searchParams, body });
    if (path.startsWith('/auth/') && state.gate) await state.gate;
    if (path === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password' && state.fail.has('password'))
        return route.fulfill({
          status: 400,
          json: { error: 'invalid_grant', error_description: 'Invalid login credentials' },
        });
      if (grant === 'pkce' && state.fail.has('pkce'))
        return refuse(route, 404, 'invalid flow state, no valid flow state found', 'flow_state_not_found');
      return route.fulfill({ json: state.session });
    }
    if (path === '/auth/v1/recover')
      return state.fail.has('recover')
        ? refuse(route, 500, 'Falha sintética no envio.')
        : route.fulfill({ json: {} });
    if (path === '/auth/v1/verify')
      return state.fail.has('verify')
        ? refuse(route, 403, 'Token has expired or is invalid', 'otp_expired')
        : route.fulfill({ json: state.session });
    if (path === '/auth/v1/logout')
      return state.fail.has('logout')
        ? refuse(route, 500, 'Falha sintética ao sair.')
        : route.fulfill({ status: 204, body: '' });
    if (path === '/auth/v1/user') {
      if (request.method() === 'PUT') {
        if (state.fail.has('user'))
          return refuse(route, 422, 'Falha sintética ao salvar a senha.');
        state.session.user.user_metadata = {
          ...state.session.user.user_metadata,
          ...(body?.data as Record<string, unknown>),
        };
      }
      return route.fulfill({ json: state.session.user });
    }
    if (path.endsWith('/clinic_members'))
      return state.fail.has('members')
        ? route.fulfill({ status: 500, json: { message: 'Falha sintética.' } })
        : route.fulfill({ json: state.members });
    if (path.endsWith('/clinics')) return route.fulfill({ json: { require_mfa: false } });
    if (path.endsWith('/clinic_features')) return route.fulfill({ json: { features: [] } });
    return route.fulfill({ json: [] });
  });
  return state;
}

/** Segura as respostas do Auth até a função devolvida ser chamada. */
function hold(state: { gate: Promise<void> | null }) {
  let release = () => {};
  state.gate = new Promise<void>((resolve) => (release = resolve));
  return () => {
    state.gate = null;
    release();
  };
}

const calls = (state: { calls: Call[] }, path: string, method?: string) =>
  state.calls.filter((x) => x.path === path && (!method || x.method === method));
const card = (page: Page) => page.locator('.auth-card');
const heading = (page: Page) => card(page).locator('h1');
const eyebrow = (page: Page) => card(page).locator('.eyebrow');
const cardAlert = (page: Page) => card(page).getByRole('alert');
const cardStatus = (page: Page) => card(page).getByRole('status');
const emailField = (page: Page) => page.getByLabel('E-mail', { exact: true });
const passwordField = (page: Page) => page.getByLabel('Senha', { exact: true });
const newPassword = (page: Page) => page.getByLabel('Nova senha', { exact: true });
const repeatPassword = (page: Page) =>
  page.getByLabel('Repetir nova senha', { exact: true });
const button = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true });
const checklist = (page: Page) => card(page).locator('.auth-checklist-item');
/** O prontuário abriu: lista de pacientes e barra da conta. */
async function expectApp(page: Page, clinicName = 'Clínica Sintética') {
  await expect(page.getByRole('button', { name: /Paciente Sintético/ })).toBeVisible();
  await expect(page.locator('.clinic-name')).toHaveText(clinicName);
  await expect(page.locator('.user-email')).toHaveText(email);
  await expect(card(page)).toHaveCount(0);
}
/** Responde à próxima confirmação do navegador e devolve a mensagem dela. */
function nextConfirm(page: Page, accept: boolean) {
  return new Promise<string>((resolve) =>
    page.once('dialog', (dialog) => {
      resolve(dialog.message());
      void (accept ? dialog.accept() : dialog.dismiss());
    }),
  );
}
const signOutQuestion =
  'Sair da conta? Conclua os envios e salve os cadastros antes de sair.';

test('entrar: senha errada avisa; senha certa abre o prontuário; sair volta à entrada', async ({
  page,
}) => {
  const state = await mockAuth(page);
  await page.goto('/');
  await expect(eyebrow(page)).toHaveText('PSYWRITE');
  await expect(heading(page)).toHaveText('Entrar no prontuário');
  await expect(card(page).locator('p').first()).toHaveText(
    'Use sua conta individual do prontuário.',
  );
  await expect(cardAlert(page)).toHaveCount(0);

  await emailField(page).fill(email);
  await passwordField(page).fill('senha-errada');
  state.fail.add('password');
  const release = hold(state);
  await button(page, 'Entrar').click();
  await expect(button(page, 'Aguarde…')).toBeDisabled();
  await expect(button(page, 'Esqueci minha senha')).toBeDisabled();
  release();
  await expect(cardAlert(page)).toHaveText(
    'E-mail ou senha incorretos, ou convite ainda não aceito.',
  );
  // A senha digitada continua no campo para corrigir.
  await expect(passwordField(page)).toHaveValue('senha-errada');
  expect(calls(state, '/auth/v1/token').at(-1)).toMatchObject({
    method: 'POST',
    body: { email, password: 'senha-errada' },
  });
  expect(calls(state, '/auth/v1/token').at(-1)!.search.get('grant_type')).toBe(
    'password',
  );
  expect(calls(state, '/rest/v1/clinic_members')).toHaveLength(0);

  state.fail.delete('password');
  await passwordField(page).fill(goodPassword);
  await button(page, 'Entrar').click();
  await expectApp(page);
  await expect(page.locator('p.capture-error')).toHaveCount(0);
  expect(calls(state, '/auth/v1/token').at(-1)!.body).toMatchObject({
    email,
    password: goodPassword,
  });
  expect(calls(state, '/rest/v1/clinic_members').at(-1)!.search.get('user_id')).toBe(
    `eq.${state.session.user.id}`,
  );

  // Sair pergunta antes; desistir não faz nada.
  await page.evaluate(() => {
    sessionStorage.setItem('capture-desktop', '{}');
    sessionStorage.setItem('capture-mobile', '{}');
  });
  let question = nextConfirm(page, false);
  await button(page, 'Sair').click();
  expect(await question).toBe(signOutQuestion);
  await expect(page.getByRole('button', { name: /Paciente Sintético/ })).toBeVisible();
  expect(calls(state, '/auth/v1/logout')).toHaveLength(0);

  question = nextConfirm(page, true);
  await button(page, 'Sair').click();
  expect(await question).toBe(signOutQuestion);
  await expect(heading(page)).toHaveText('Entrar no prontuário');
  expect(calls(state, '/auth/v1/logout')).toHaveLength(1);
  // O e-mail fica; a senha é apagada; o pareamento de captura é esquecido.
  await expect(emailField(page)).toHaveValue(email);
  await expect(passwordField(page)).toHaveValue('');
  await expect(cardAlert(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => [
      sessionStorage.getItem('capture-desktop'),
      sessionStorage.getItem('capture-mobile'),
    ]),
  ).toEqual([null, null]);
});

test('esqueci minha senha: pede o e-mail, envia o link de primeiro acesso e avisa falha', async ({
  page,
}) => {
  const state = await mockAuth(page);
  await page.goto('/');
  await button(page, 'Esqueci minha senha').click();
  await expect(cardAlert(page)).toHaveText(
    'Informe seu e-mail para receber as instruções de acesso.',
  );
  expect(calls(state, '/auth/v1/recover')).toHaveLength(0);

  await emailField(page).fill(email);
  const release = hold(state);
  await button(page, 'Esqueci minha senha').click();
  await expect(button(page, 'Esqueci minha senha')).toBeDisabled();
  await expect(button(page, 'Aguarde…')).toBeDisabled();
  release();
  await expect(cardStatus(page)).toHaveText(
    'Se o e-mail estiver cadastrado, você receberá as instruções para definir a senha.',
  );
  await expect(cardAlert(page)).toHaveCount(0);
  const sent = calls(state, '/auth/v1/recover');
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ email });
  expect(sent[0].search.get('redirect_to')).toBe(`${origin}/?first_access=true`);

  state.fail.add('recover');
  await button(page, 'Esqueci minha senha').click();
  await expect(cardAlert(page)).toHaveText(
    'Não foi possível enviar as instruções. Tente novamente.',
  );
  // A mensagem do envio anterior continua na tela.
  await expect(cardStatus(page)).toHaveCount(1);
  await expect(button(page, 'Esqueci minha senha')).toBeEnabled();
});

test('primeiro acesso: confere a senha enquanto digita, salva e abre o prontuário', async ({
  page,
}) => {
  const state = await mockAuth(page, { signedIn: true });
  await page.goto('/?first_access=true');
  await expect(eyebrow(page)).toHaveText('PRIMEIRO ACESSO · EQUIPE');
  await expect(heading(page)).toHaveText('Defina sua senha de acesso');
  await expect(card(page).locator('h1 + p')).toHaveText(
    'Seja bem-vindo(a) à clínica! Cadastre sua senha individual para acessar o prontuário.',
  );
  await expect(card(page).locator('.auth-account-badge')).toHaveText(`Conta: ${email}`);
  // Enquanto a senha não é definida, o vínculo com a clínica nem é consultado.
  expect(calls(state, '/rest/v1/clinic_members')).toHaveLength(0);

  const save = button(page, 'Salvar senha e entrar');
  await expect(checklist(page)).toHaveText([
    'Mínimo de 12 caracteres (0/12)',
    'Senhas coincidem',
  ]);
  await expect(checklist(page).nth(0)).toHaveClass('auth-checklist-item ');
  await expect(checklist(page).nth(1)).toHaveClass('auth-checklist-item ');
  await expect(save).toBeDisabled();

  await newPassword(page).fill(goodPassword.slice(0, 11));
  await expect(checklist(page).nth(0)).toHaveText('Mínimo de 12 caracteres (11/12)');
  await expect(checklist(page).nth(0)).toHaveClass('auth-checklist-item ');
  await newPassword(page).fill(goodPassword);
  await expect(checklist(page).nth(0)).toHaveText('Mínimo de 12 caracteres (12/12)');
  await expect(checklist(page).nth(0)).toHaveClass('auth-checklist-item valid');
  await expect(save).toBeDisabled();

  await repeatPassword(page).fill(`${goodPassword}x`);
  await expect(checklist(page).nth(1)).toHaveText('As senhas não coincidem');
  await expect(checklist(page).nth(1)).toHaveClass('auth-checklist-item invalid');
  await expect(save).toBeDisabled();
  await repeatPassword(page).fill(goodPassword);
  await expect(checklist(page).nth(1)).toHaveText('Senhas coincidem');
  await expect(checklist(page).nth(1)).toHaveClass('auth-checklist-item valid');
  await expect(save).toBeEnabled();

  const release = hold(state);
  await save.click();
  await expect(button(page, 'Salvando senha…')).toBeDisabled();
  await expect(button(page, 'Sair ou entrar com outra conta')).toBeDisabled();
  release();
  await expectApp(page);
  const update = calls(state, '/auth/v1/user', 'PUT');
  expect(update).toHaveLength(1);
  expect(update[0].body).toMatchObject({
    password: goodPassword,
    data: { must_set_password: false, password_set: true },
  });
  expect(calls(state, '/rest/v1/clinic_members').length).toBeGreaterThan(0);
});

test('erro ao salvar a senha mostra o aviso do servidor e o formulário continua', async ({
  page,
}) => {
  const state = await mockAuth(page, { signedIn: true });
  await page.goto('/?first_access=true');
  await newPassword(page).fill(goodPassword);
  await repeatPassword(page).fill(goodPassword);
  state.fail.add('user');
  await button(page, 'Salvar senha e entrar').click();
  await expect(cardAlert(page)).toHaveText('Falha sintética ao salvar a senha.');
  await expect(heading(page)).toHaveText('Defina sua senha de acesso');
  await expect(newPassword(page)).toHaveValue(goodPassword);
  await expect(repeatPassword(page)).toHaveValue(goodPassword);
  await expect(button(page, 'Salvar senha e entrar')).toBeEnabled();

  state.fail.delete('user');
  await button(page, 'Salvar senha e entrar').click();
  await expectApp(page);
  expect(calls(state, '/auth/v1/user', 'PUT')).toHaveLength(2);
});

const firstAccess = {
  eyebrow: 'PRIMEIRO ACESSO · EQUIPE',
  heading: 'Defina sua senha de acesso',
};
const recovery = {
  eyebrow: 'RECUPERAÇÃO DE ACESSO',
  heading: 'Definir nova senha',
  text: 'Cadastre sua nova senha de acesso individual.',
};
for (const [name, address, metadata, screen] of [
  ['convite no endereço (?type=invite)', '/?type=invite', {}, firstAccess],
  ['convite no fragmento (#type=invite)', '/#type=invite', {}, firstAccess],
  ['recuperação no endereço (?type=recovery)', '/?type=recovery', {}, recovery],
  ['recuperação no fragmento (#type=recovery)', '/#type=recovery', {}, recovery],
  ['conta marcada para definir a senha', '/', { must_set_password: true }, firstAccess],
] as const)
  test(`${name} abre a tela de definir senha`, async ({ page }) => {
    const state = await mockAuth(page, { signedIn: true, metadata });
    await page.goto(address);
    await expect(eyebrow(page)).toHaveText(screen.eyebrow);
    await expect(heading(page)).toHaveText(screen.heading);
    if ('text' in screen)
      await expect(card(page).locator('h1 + p')).toHaveText(screen.text);
    await expect(card(page).locator('.auth-account-badge')).toHaveText(`Conta: ${email}`);
    expect(calls(state, '/rest/v1/clinic_members')).toHaveLength(0);
  });

test('definir senha: sair ou entrar com outra conta pede confirmação e volta à entrada', async ({
  page,
}) => {
  const state = await mockAuth(page, { signedIn: true });
  await page.goto('/?type=recovery');
  await expect(heading(page)).toHaveText('Definir nova senha');

  let question = nextConfirm(page, false);
  await button(page, 'Sair ou entrar com outra conta').click();
  expect(await question).toBe(signOutQuestion);
  await expect(heading(page)).toHaveText('Definir nova senha');
  expect(calls(state, '/auth/v1/logout')).toHaveLength(0);

  question = nextConfirm(page, true);
  await button(page, 'Sair ou entrar com outra conta').click();
  expect(await question).toBe(signOutQuestion);
  await expect(heading(page)).toHaveText('Entrar no prontuário');
  expect(calls(state, '/auth/v1/logout')).toHaveLength(1);
  await expect(passwordField(page)).toHaveValue('');
});

test('link vencido ou com erro mostra o aviso na entrada e limpa o endereço', async ({
  page,
}) => {
  await mockAuth(page);
  await page.goto(
    '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
  );
  await expect(cardAlert(page)).toHaveText(
    'O link de convite ou recuperação expirou ou já foi utilizado. Solicite um novo acesso.',
  );
  await expect(heading(page)).toHaveText('Entrar no prontuário');
  expect(page.url()).toBe(`${origin}/`);

  await page.goto('/?error_description=Falha+sint%C3%A9tica+no+link');
  await expect(cardAlert(page)).toHaveText('Falha sintética no link');
  expect(page.url()).toBe(`${origin}/`);
});

test('link de ativação abre a tela de nova senha da conta e limpa o endereço', async ({
  page,
}) => {
  const state = await mockAuth(page);
  await page.goto('/?activation=token-sintetico');
  await expect(eyebrow(page)).toHaveText(recovery.eyebrow);
  await expect(card(page).locator('.auth-account-badge')).toHaveText(`Conta: ${email}`);
  expect(page.url()).toBe(`${origin}/`);
  const verify = calls(state, '/auth/v1/verify');
  expect(verify).toHaveLength(1);
  expect(verify[0].body).toMatchObject({ token_hash: 'token-sintetico', type: 'recovery' });
});

test('código de acesso no endereço é trocado por sessão e o endereço é limpo', async ({
  page,
}) => {
  const state = await mockAuth(page);
  await page.goto('/?code=codigo-sintetico');
  await expectApp(page);
  expect(page.url()).toBe(`${origin}/`);
  const exchange = calls(state, '/auth/v1/token').filter(
    (x) => x.search.get('grant_type') === 'pkce',
  );
  expect(exchange).toHaveLength(1);
  expect(exchange[0].body).toMatchObject({ auth_code: 'codigo-sintetico' });
});

test('pareamento do celular no endereço fica guardado e o endereço é limpo', async ({
  page,
}) => {
  await mockAuth(page, { signedIn: true });
  const id = 'eeeeeeee-0000-4000-8000-000000000001';
  const token = 'ab'.repeat(32);
  await page.goto(`/#${id}.${token}`);
  await expectApp(page);
  expect(page.url()).toBe(`${origin}/`);
  expect(
    JSON.parse((await page.evaluate(() => sessionStorage.getItem('capture-mobile')))!),
  ).toEqual({ id, token, expires_at: 0 });
});

test('conta sem clínica: aviso, verificar de novo e sair', async ({ page }) => {
  const state = await mockAuth(page, { signedIn: true });
  state.members = [];
  await page.goto('/');
  await expect(heading(page)).toHaveText('Acesso à clínica');
  await expect(card(page).locator('p')).toHaveText(
    'Sua conta precisa ser vinculada à clínica pelo administrador.',
  );
  await expect(cardAlert(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Paciente Sintético/ })).toHaveCount(0);

  // "Verificar acesso" recarrega a página e consulta o vínculo de novo.
  state.members = [
    { clinic_id: clinicA, role: 'owner', clinics: { name: 'Clínica Sintética' } },
  ];
  await Promise.all([page.waitForEvent('load'), button(page, 'Verificar acesso').click()]);
  await expectApp(page);

  state.members = [];
  await page.reload();
  await expect(heading(page)).toHaveText('Acesso à clínica');
  const question = nextConfirm(page, true);
  await button(page, 'Sair').click();
  expect(await question).toBe(signOutQuestion);
  await expect(heading(page)).toHaveText('Entrar no prontuário');
  expect(calls(state, '/auth/v1/logout')).toHaveLength(1);
});

test('falha ao carregar as permissões aparece na tela de acesso à clínica', async ({
  page,
}) => {
  const state = await mockAuth(page, { signedIn: true });
  state.fail.add('members');
  await page.goto('/');
  await expect(heading(page)).toHaveText('Acesso à clínica');
  await expect(cardAlert(page)).toHaveText(
    'Não foi possível carregar suas permissões. Recarregue a página.',
  );
});

test('o primeiro vínculo escolhe a clínica e o papel', async ({ page }) => {
  const state = await mockAuth(page, { signedIn: true });
  state.members = [
    { clinic_id: clinicA, role: 'secretary', clinics: { name: 'Clínica Sintética A' } },
    { clinic_id: clinicB, role: 'owner', clinics: { name: 'Clínica Sintética B' } },
  ];
  const patients = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/patients',
  );
  await page.goto('/');
  await expectApp(page, 'Clínica Sintética A');
  expect((await patients).headers()['x-clinic-id']).toBe(clinicA);
  // Secretária: sem auditoria na barra da conta.
  await expect(button(page, 'Auditoria')).toHaveCount(0);

  state.members.reverse();
  await page.reload();
  await expectApp(page, 'Clínica Sintética B');
  await expect(button(page, 'Auditoria')).toBeVisible();
});

test('falha do servidor ao sair: o navegador sai mesmo assim e a entrada mostra o aviso', async ({
  page,
}) => {
  const state = await mockAuth(page, { signedIn: true });
  await page.goto('/');
  await expectApp(page);
  await page.evaluate(() => sessionStorage.setItem('capture-desktop', '{}'));
  state.fail.add('logout');
  const question = nextConfirm(page, true);
  await button(page, 'Sair').click();
  expect(await question).toBe(signOutQuestion);
  // A biblioteca do Supabase apaga a sessão do navegador mesmo quando o servidor falha.
  await expect(heading(page)).toHaveText('Entrar no prontuário');
  await expect(cardAlert(page)).toHaveText('Não foi possível sair. Tente novamente.');
  expect(calls(state, '/auth/v1/logout')).toHaveLength(1);
  // Comportamento atual (anotado em docs/REFATORACAO.md): o pareamento de captura não é apagado.
  expect(await page.evaluate(() => sessionStorage.getItem('capture-desktop'))).toBe('{}');
});
