// Agenda: lista do dia, troca de dia, ações de cada horário e o formulário de horário.
// Tudo sintético: a API de horários é respondida aqui, sem banco nem rede. O relógio do navegador
// fica parado num instante fixo (no passado, para a sessão sintética nunca parecer vencida), de
// modo que "hoje" e "já passou do horário" não dependem do dia em que o teste roda.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockApi, patient } from './fixtures';

test.use({ timezoneId: 'America/Sao_Paulo' });

const today = '2026-11-10';
const yesterday = '2026-11-09';
const at = (day: string, time: string) =>
  Date.parse(`${day}T${time}:00-03:00`);
const now = at(today, '14:30');
// São Paulo fica em UTC-3 o ano todo.
const dayOf = (timestamp: number) =>
  new Date(timestamp - 3 * 3_600_000).toISOString().slice(0, 10);

type Appointment = {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_social_name: string | null;
  starts_at: number;
  ends_at: number;
  modality: string;
  status: string;
  arrived_at: number | null;
  admin_notes: string | null;
  version: number;
};
type Failure = { status: number; json: Record<string, unknown> };
type Write = {
  action: string | null;
  guard: string | undefined;
  body: Record<string, unknown>;
};

/** Um horário sintético do dia `day`, chamado "Paciente <letra>". */
const slot = (
  letter: string,
  start: string,
  end: string,
  extra: Partial<Appointment> = {},
  day = today,
): Appointment => ({
  id: `99999999-0000-4000-8000-0000000000${letter.charCodeAt(0)}`,
  patient_id: patient.id,
  patient_name: `Paciente ${letter}`,
  patient_social_name: null,
  starts_at: at(day, start),
  ends_at: at(day, end),
  modality: 'presencial',
  status: 'scheduled',
  arrived_at: null,
  admin_notes: null,
  version: 1,
  ...extra,
});

/** Responde à API de horários como o servidor responderia e guarda o que a tela pediu. */
async function mockAgenda(page: Page, list: Appointment[] = []) {
  await page.clock.setFixedTime(now);
  const api = await mockApi(page);
  const state = {
    api,
    appointments: list,
    loaded: [] as string[],
    writes: [] as Write[],
    searches: [] as string[],
    matches: [patient],
    loadFailure: null as Failure | null,
    writeFailure: null as Failure | null,
    // Quando preenchido, a resposta só sai depois que o teste liberar.
    gate: null as Promise<void> | null,
  };
  await page.route(/\/api\/appointments\?/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      const day = url.searchParams.get('day') || '';
      state.loaded.push(day);
      if (state.gate) await state.gate;
      if (state.loadFailure) return route.fulfill(state.loadFailure);
      return route.fulfill({
        json: {
          appointments: state.appointments
            .filter((item) => dayOf(item.starts_at) === day)
            .sort((a, b) => a.starts_at - b.starts_at),
        },
      });
    }
    const action = url.searchParams.get('action');
    const body = request.postDataJSON();
    state.writes.push({
      action,
      guard: request.headers()['x-appointment-action'],
      body,
    });
    if (state.gate) await state.gate;
    if (state.writeFailure) return route.fulfill(state.writeFailure);
    // O que o servidor faria com o horário.
    const item = state.appointments.find((entry) => entry.id === body.id);
    const fields = {
      patient_id: body.patient_id,
      starts_at: body.starts_at,
      ends_at: body.ends_at,
      modality: body.modality,
      admin_notes: String(body.admin_notes ?? '').trim() || null,
    };
    if (action === 'create')
      state.appointments.push({
        ...slot('Z', '00:00', '00:00'),
        ...fields,
        id: body.id,
        patient_name: patient.name,
      });
    else if (item) {
      if (action === 'arrive') item.arrived_at = now;
      else if (action === 'no_show')
        Object.assign(item, { status: 'no_show', arrived_at: null });
      else if (action === 'reset')
        Object.assign(item, { status: 'scheduled', arrived_at: null });
      else if (action === 'cancel') item.status = 'cancelled';
      else if (action === 'update') Object.assign(item, fields);
      item.version += 1;
    }
    return route.fulfill({ json: { ok: true } });
  });
  // Busca de paciente do formulário (a da lista de pacientes leva também "&page=").
  await page.route(/\/api\/patients\?q=[^&]*$/, async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') || '';
    state.searches.push(query);
    await route.fulfill({
      json: { patients: state.matches, total: state.matches.length },
    });
  });
  return state;
}

/** Segura as respostas da API de horários até a função devolvida ser chamada. */
function hold(state: { gate: Promise<void> | null }) {
  let release = () => {};
  state.gate = new Promise<void>((resolve) => (release = resolve));
  return () => {
    state.gate = null;
    release();
  };
}

const heading = (page: Page) => page.locator('.agenda-heading h1');
const summary = (page: Page) => page.locator('.agenda-summary');
// O Next também tem um elemento com role=alert (anúncio de rota); este é o aviso da agenda.
const alert = (page: Page) => page.locator('.main-shell [role=alert]');
const rail = (page: Page) =>
  page.getByRole('navigation', { name: 'Navegação principal' });
const card = (page: Page, name: string) =>
  page
    .locator('.appointment-card')
    .filter({ has: page.getByText(name, { exact: true }) });
const newButton = (page: Page) =>
  page.locator('.agenda-actions').getByRole('button', { name: 'Novo horário' });
const field = (form: Locator, name: string) =>
  form.locator(`#appointment-${name}`);
const saveButton = (form: Locator) =>
  form.getByRole('button', { name: 'Salvar horário' });

async function openAgenda(page: Page) {
  await page.goto('/');
  await rail(page).getByRole('button', { name: 'Agenda' }).click();
  await expect(heading(page)).toBeVisible();
}

/** Confere um cartão: horários, linha de detalhe, situação e os botões, na ordem. */
async function expectCard(
  page: Page,
  name: string,
  expected: {
    start: string;
    end: string;
    detail: string;
    status: string;
    buttons: string[];
  },
) {
  const item = card(page, name);
  await expect(item.locator('time strong')).toHaveText(expected.start);
  await expect(item.locator('time span')).toHaveText(expected.end);
  await expect(item.locator('.appointment-card-main span')).toHaveText(
    expected.detail,
  );
  await expect(item.locator('.appointment-status')).toHaveText(
    expected.status,
  );
  await expect(item.getByRole('button')).toHaveText(expected.buttons);
}

/** Responde à próxima pergunta de confirmação do navegador e devolve o texto dela. */
function nextConfirm(page: Page, accept: boolean) {
  return new Promise<string>((resolve) =>
    page.once('dialog', async (dialog) => {
      const message = dialog.message();
      await (accept ? dialog.accept() : dialog.dismiss());
      resolve(message);
    }),
  );
}

/** Abre o formulário de novo horário e escolhe o paciente sintético na busca. */
async function newAppointment(page: Page) {
  await newButton(page).click();
  const form = page.getByRole('dialog', { name: 'Novo horário' });
  await field(form, 'patient').fill('Pac');
  await form
    .locator('.patient-matches')
    .getByRole('button', { name: /Paciente Sintético/ })
    .click();
  await expect(form.locator('.selected-patient')).toHaveText(
    'Paciente selecionado: Paciente Sintético',
  );
  return form;
}

test('abre no dia de hoje, avisa que está carregando e mostra o dia vazio', async ({
  page,
}) => {
  const state = await mockAgenda(page);
  const release = hold(state);
  await openAgenda(page);
  await expect(heading(page)).toHaveText('terça-feira, 10 de novembro de 2026');
  await expect(page.getByText('Carregando agenda…')).toBeVisible();
  await expect(
    rail(page).getByRole('button', { name: 'Agenda' }),
  ).toHaveAttribute('aria-current', 'page');
  release();
  await expect(
    page.getByRole('heading', { name: 'Sem horários neste dia' }),
  ).toBeVisible();
  await expect(page.getByText('Carregando agenda…')).toHaveCount(0);
  await expect(summary(page)).toHaveCount(0);
  await expect(page.locator('.appointment-card')).toHaveCount(0);
  expect(state.loaded).toEqual([today]);

  // O botão do dia vazio abre o mesmo formulário do botão do topo.
  await page
    .locator('.agenda-empty')
    .getByRole('button', { name: 'Novo horário' })
    .click();
  const form = page.getByRole('dialog', { name: 'Novo horário' });
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'Fechar' }).click();
  await expect(form).toHaveCount(0);

  await rail(page).getByRole('button', { name: 'Pacientes' }).click();
  await expect(heading(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Paciente Sintético/ }),
  ).toBeVisible();
});

test('lista os horários do dia com a situação e as ações de cada um', async ({
  page,
}) => {
  await mockAgenda(page, [
    slot('A', '09:00', '09:50', { admin_notes: 'Primeira consulta' }),
    slot('B', '10:00', '11:30', {
      patient_name: 'Nome de Registro',
      patient_social_name: 'Paciente B',
      modality: 'teleconsulta',
      arrived_at: at(today, '09:55'),
    }),
    slot('C', '11:30', '12:20', { status: 'in_progress' }),
    slot('D', '12:30', '13:20', { status: 'completed' }),
    slot('E', '13:30', '14:20', { status: 'no_show' }),
    slot('F', '14:00', '14:50', { status: 'cancelled' }),
    slot('G', '16:00', '16:50'),
  ]);
  await openAgenda(page);

  // Cancelado não aparece nem entra na conta.
  await expect(page.locator('.appointment-card')).toHaveCount(6);
  await expect(card(page, 'Paciente F')).toHaveCount(0);
  await expect(summary(page)).toHaveText('6 horários · 1 atendido · 1 falta');
  await expect(
    page.locator('.appointment-card-main strong'),
  ).toHaveText([
    'Paciente A',
    'Paciente B',
    'Paciente C',
    'Paciente D',
    'Paciente E',
    'Paciente G',
  ]);

  // Já passou das 9h e a pessoa não chegou: dá para registrar chegada ou falta.
  await expectCard(page, 'Paciente A', {
    start: '09:00',
    end: '09:50',
    detail: 'Presencial · Primeira consulta',
    status: 'Agendado',
    buttons: [
      'Registrar chegada',
      'Iniciar consulta',
      'Editar',
      'Faltou',
      'Cancelar',
    ],
  });
  // Com chegada registrada vira "Aguardando"; aparece o nome social, não o de registro.
  await expectCard(page, 'Paciente B', {
    start: '10:00',
    end: '11:30',
    detail: 'Teleconsulta · chegou às 09:55',
    status: 'Aguardando',
    buttons: ['Iniciar consulta', 'Editar', 'Desfazer chegada', 'Cancelar'],
  });
  await expect(card(page, 'Paciente B').locator('.avatar')).toHaveText('PB');
  await expectCard(page, 'Paciente C', {
    start: '11:30',
    end: '12:20',
    detail: 'Presencial',
    status: 'Em atendimento',
    buttons: ['Continuar consulta'],
  });
  await expectCard(page, 'Paciente D', {
    start: '12:30',
    end: '13:20',
    detail: 'Presencial',
    status: 'Finalizado',
    buttons: ['Abrir consulta'],
  });
  await expectCard(page, 'Paciente E', {
    start: '13:30',
    end: '14:20',
    detail: 'Presencial',
    status: 'Faltou',
    buttons: ['Desfazer falta'],
  });
  // Horário que ainda não começou: não dá para marcar falta.
  await expectCard(page, 'Paciente G', {
    start: '16:00',
    end: '16:50',
    detail: 'Presencial',
    status: 'Agendado',
    buttons: ['Registrar chegada', 'Iniciar consulta', 'Editar', 'Cancelar'],
  });
});

test('troca de dia pelas setas, pelo botão Hoje e pelo campo de data', async ({
  page,
}) => {
  const state = await mockAgenda(page, [
    slot('A', '09:00', '09:50'),
    slot('B', '09:00', '09:50', {}, '2026-12-25'),
  ]);
  await openAgenda(page);
  await expect(card(page, 'Paciente A')).toBeVisible();

  await page.getByRole('button', { name: 'Dia anterior' }).click();
  await expect(heading(page)).toHaveText(
    'segunda-feira, 09 de novembro de 2026',
  );
  await expect(page.locator('.appointment-card')).toHaveCount(0);

  await page.getByRole('button', { name: 'Próximo dia' }).click();
  await page.getByRole('button', { name: 'Próximo dia' }).click();
  await expect(heading(page)).toHaveText(
    'quarta-feira, 11 de novembro de 2026',
  );

  await page.getByRole('button', { name: 'Hoje' }).click();
  await expect(heading(page)).toHaveText('terça-feira, 10 de novembro de 2026');
  await expect(card(page, 'Paciente A')).toBeVisible();

  const date = page.getByLabel('Escolher data');
  await expect(date).toHaveValue(today);
  await date.fill('2026-12-25');
  await expect(heading(page)).toHaveText(
    'sexta-feira, 25 de dezembro de 2026',
  );
  await expect(card(page, 'Paciente B')).toBeVisible();
  await expect(card(page, 'Paciente A')).toHaveCount(0);

  // Apagar a data não muda o dia.
  await date.fill('');
  await expect(heading(page)).toHaveText(
    'sexta-feira, 25 de dezembro de 2026',
  );
  await expect(date).toHaveValue('2026-12-25');
  expect(state.loaded).toEqual([
    today,
    yesterday,
    today,
    '2026-11-11',
    today,
    '2026-12-25',
  ]);
});

test('em dia passado, agendado sem chegada fica "Sem registro" e não aceita chegada', async ({
  page,
}) => {
  await mockAgenda(page, [
    slot('A', '09:00', '09:50', {}, yesterday),
    slot('B', '10:00', '10:50', { arrived_at: at(yesterday, '10:05') }, yesterday),
    slot('C', '11:00', '11:50', { status: 'completed' }, yesterday),
    slot('D', '12:00', '12:50', { status: 'completed' }, yesterday),
    slot('E', '13:00', '13:50', { status: 'no_show' }, yesterday),
    slot('F', '14:00', '14:50', { status: 'no_show' }, yesterday),
  ]);
  await openAgenda(page);
  await page.getByRole('button', { name: 'Dia anterior' }).click();

  await expect(summary(page)).toHaveText(
    '6 horários · 2 atendidos · 2 faltas',
  );
  await expectCard(page, 'Paciente A', {
    start: '09:00',
    end: '09:50',
    detail: 'Presencial',
    status: 'Sem registro',
    buttons: ['Iniciar consulta', 'Editar', 'Faltou', 'Cancelar'],
  });
  await expect(card(page, 'Paciente A')).toHaveClass(
    'appointment-card unrecorded',
  );
  await expectCard(page, 'Paciente B', {
    start: '10:00',
    end: '10:50',
    detail: 'Presencial · chegou às 10:05',
    status: 'Aguardando',
    buttons: ['Iniciar consulta', 'Editar', 'Desfazer chegada', 'Cancelar'],
  });
});

test('um horário só é contado no singular', async ({ page }) => {
  await mockAgenda(page, [slot('A', '16:00', '16:50')]);
  await openAgenda(page);
  await expect(summary(page)).toHaveText('1 horário');
});

test('registra chegada e falta, e desfaz as duas', async ({ page }) => {
  const item = slot('A', '09:00', '09:50');
  const state = await mockAgenda(page, [item]);
  await openAgenda(page);
  const row = card(page, 'Paciente A');
  const status = row.locator('.appointment-status');

  await row.getByRole('button', { name: 'Registrar chegada' }).click();
  await expect(status).toHaveText('Aguardando');
  await expect(row.locator('.appointment-card-main span')).toHaveText(
    'Presencial · chegou às 14:30',
  );

  await row.getByRole('button', { name: 'Desfazer chegada' }).click();
  await expect(status).toHaveText('Agendado');

  // Falta pede confirmação; recusar não envia nada.
  let question = nextConfirm(page, false);
  await row.getByRole('button', { name: 'Faltou' }).click();
  expect(await question).toBe('Registrar que Paciente A faltou?');
  await expect(status).toHaveText('Agendado');
  expect(state.writes).toHaveLength(2);

  question = nextConfirm(page, true);
  await row.getByRole('button', { name: 'Faltou' }).click();
  await question;
  await expect(status).toHaveText('Faltou');
  await expect(row.getByRole('button')).toHaveText(['Desfazer falta']);
  await expect(summary(page)).toHaveText('1 horário · 1 falta');

  await row.getByRole('button', { name: 'Desfazer falta' }).click();
  await expect(status).toHaveText('Agendado');

  // Cada ação manda o identificador e a versão que a tela tinha, e recarrega a lista.
  expect(state.writes).toEqual([
    { action: 'arrive', guard: '1', body: { id: item.id, version: 1 } },
    { action: 'reset', guard: '1', body: { id: item.id, version: 2 } },
    { action: 'no_show', guard: '1', body: { id: item.id, version: 3 } },
    { action: 'reset', guard: '1', body: { id: item.id, version: 4 } },
  ]);
  expect(state.loaded).toEqual([today, today, today, today, today]);
});

test('cancelar pede confirmação e tira o horário da lista', async ({ page }) => {
  const item = slot('A', '16:00', '16:50', {
    patient_name: 'Nome de Registro',
    patient_social_name: 'Paciente A',
  });
  const state = await mockAgenda(page, [item, slot('B', '17:00', '17:50')]);
  await openAgenda(page);
  const row = card(page, 'Paciente A');

  let question = nextConfirm(page, false);
  await row.getByRole('button', { name: 'Cancelar' }).click();
  expect(await question).toBe('Cancelar o horário de Paciente A?');
  await expect(row).toBeVisible();
  expect(state.writes).toEqual([]);

  question = nextConfirm(page, true);
  await row.getByRole('button', { name: 'Cancelar' }).click();
  await question;
  await expect(row).toHaveCount(0);
  await expect(card(page, 'Paciente B')).toBeVisible();
  await expect(summary(page)).toHaveText('1 horário');
  expect(state.writes).toEqual([
    { action: 'cancel', guard: '1', body: { id: item.id, version: 1 } },
  ]);
});

test('falha ao carregar ou ao agir aparece como aviso e some quando dá certo', async ({
  page,
}) => {
  const state = await mockAgenda(page, [slot('A', '09:00', '09:50')]);
  state.loadFailure = {
    status: 500,
    json: { error: 'Falha sintética ao carregar.' },
  };
  await openAgenda(page);
  await expect(alert(page)).toHaveText('Falha sintética ao carregar.');
  await expect(
    page.getByRole('heading', { name: 'Sem horários neste dia' }),
  ).toBeVisible();

  // Resposta de erro sem texto: vale a mensagem padrão.
  state.loadFailure = { status: 500, json: {} };
  await page.getByRole('button', { name: 'Próximo dia' }).click();
  await expect(alert(page)).toHaveText('Não foi possível carregar a agenda.');

  state.loadFailure = null;
  await page.getByRole('button', { name: 'Hoje' }).click();
  const row = card(page, 'Paciente A');
  await expect(row).toBeVisible();
  await expect(alert(page)).toHaveCount(0);

  const arrive = row.getByRole('button', { name: 'Registrar chegada' });
  state.writeFailure = {
    status: 409,
    json: {
      error: 'Horário alterado em outra janela. Atualize a agenda.',
      conflict: true,
    },
  };
  await arrive.click();
  await expect(alert(page)).toHaveText(
    'Horário alterado em outra janela. Atualize a agenda.',
  );
  await expect(row.locator('.appointment-status')).toHaveText('Agendado');

  state.writeFailure = { status: 500, json: {} };
  await arrive.click();
  await expect(alert(page)).toHaveText('Não foi possível atualizar o horário.');
  // Ação recusada não recarrega a lista.
  expect(state.loaded).toEqual([today, '2026-11-11', today]);

  state.writeFailure = null;
  await arrive.click();
  await expect(row.locator('.appointment-status')).toHaveText('Aguardando');
  await expect(alert(page)).toHaveCount(0);
});

test('abrir a consulta pela agenda leva ao prontuário, na consulta daquele horário', async ({
  page,
}) => {
  const item = slot('C', '14:00', '14:50', { status: 'in_progress' });
  const state = await mockAgenda(page, [item]);
  // A consulta sintética pertence a este horário; sem o vínculo, o prontuário abriria sem ela.
  Object.assign(state.api.consultation, { appointment_id: item.id });
  await openAgenda(page);
  await card(page, 'Paciente C')
    .getByRole('button', { name: 'Continuar consulta' })
    .click();
  await expect(page.getByLabel('Evolução em texto livre')).toHaveValue(
    state.api.consultation.text,
  );
  await expect(heading(page)).toHaveCount(0);
});

test('novo horário: busca o paciente, escolhe na lista e salva', async ({
  page,
}) => {
  const state = await mockAgenda(page);
  await openAgenda(page);
  await newButton(page).click();
  const form = page.getByRole('dialog', { name: 'Novo horário' });

  // Começa às 9h do dia aberto, com a duração padrão de 50 minutos.
  await expect(field(form, 'start')).toHaveValue(`${today}T09:00`);
  await expect(field(form, 'end')).toHaveValue('09:50');
  await expect(field(form, 'duration')).toHaveValue('50');
  await expect(field(form, 'modality')).toHaveValue('presencial');
  await expect(field(form, 'notes')).toHaveValue('');

  await field(form, 'patient').fill('Pac');
  const matches = form.locator('.patient-matches').getByRole('button');
  await expect(matches).toHaveText(['PSPaciente Sintético']);
  await matches.first().click();
  await expect(form.locator('.selected-patient')).toHaveText(
    'Paciente selecionado: Paciente Sintético',
  );
  await expect(field(form, 'patient')).toHaveValue('Paciente Sintético');

  await field(form, 'modality').selectOption('teleconsulta');
  await field(form, 'notes').fill('  Primeira consulta  ');

  // Enquanto salva, o formulário fica travado.
  const release = hold(state);
  await saveButton(form).click();
  await expect(form.getByRole('button', { name: 'Salvando…' })).toBeDisabled();
  await expect(field(form, 'notes')).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
  release();

  await expect(form).toHaveCount(0);
  expect(state.searches[0]).toBe('Pac');
  expect(state.writes).toEqual([
    {
      action: 'create',
      guard: '1',
      body: {
        id: expect.stringMatching(/^[a-f0-9-]{36}$/),
        patient_id: patient.id,
        starts_at: at(today, '09:00'),
        ends_at: at(today, '09:50'),
        modality: 'teleconsulta',
        admin_notes: '  Primeira consulta  ',
      },
    },
  ]);
  // A lista recarrega e mostra o horário novo.
  await expectCard(page, 'Paciente Sintético', {
    start: '09:00',
    end: '09:50',
    detail: 'Teleconsulta · Primeira consulta',
    status: 'Agendado',
    buttons: [
      'Registrar chegada',
      'Iniciar consulta',
      'Editar',
      'Faltou',
      'Cancelar',
    ],
  });
  expect(state.loaded).toEqual([today, today]);
});

test('novo horário: o paciente precisa ser escolhido na lista', async ({
  page,
}) => {
  const other = { ...patient, id: 'cccccccc-0000-4000-8000-000000000002', name: 'Paciente Segundo' };
  const state = await mockAgenda(page);
  state.matches = [patient, other];
  await openAgenda(page);
  await newButton(page).click();
  const form = page.getByRole('dialog', { name: 'Novo horário' });
  const input = field(form, 'patient');
  const matches = form.locator('.patient-matches').getByRole('button');
  const dialogAlert = form.getByRole('alert');

  // Uma letra só não busca.
  await input.fill('P');
  await saveButton(form).click();
  await expect(dialogAlert).toHaveText(
    'Clique no nome do paciente na lista para selecioná-lo.',
  );
  expect(state.searches).toEqual([]);

  // Com dois resultados, Enter não escolhe ninguém: tenta salvar e o aviso continua.
  await input.fill('Pac');
  await expect(matches).toHaveCount(2);
  await input.press('Enter');
  await expect(form.locator('.selected-patient')).toHaveCount(0);
  await expect(dialogAlert).toBeVisible();

  // Com um resultado só, Enter escolhe esse paciente em vez de salvar.
  state.matches = [other];
  await input.fill('Paciente Se');
  await expect(matches).toHaveText(['PSPaciente Segundo']);
  await input.press('Enter');
  await expect(form.locator('.selected-patient')).toHaveText(
    'Paciente selecionado: Paciente Segundo',
  );
  await expect(input).toHaveValue('Paciente Segundo');

  // Mexer no nome desfaz a escolha.
  await input.fill('Paciente Seg');
  await expect(form.locator('.selected-patient')).toHaveCount(0);

  // Menos de duas letras esvazia a lista.
  await expect(matches).toHaveCount(1);
  await input.fill('P');
  await expect(matches).toHaveCount(0);
  expect(state.writes).toEqual([]);
  await expect(form).toBeVisible();
});

test('duração padrão calcula o término e fica guardada no navegador', async ({
  page,
}) => {
  const state = await mockAgenda(page);
  await openAgenda(page);
  let form = await newAppointment(page);
  const duration = field(form, 'duration');
  const end = field(form, 'end');
  const stored = () =>
    page.evaluate(() => localStorage.getItem('psywrite-appointment-duration'));

  await duration.fill('30');
  await expect(end).toHaveValue('09:30');
  expect(await stored()).toBe('30');

  // Fora de 10 a 480 minutos: o término não muda e o campo volta ao valor em vigor ao sair.
  await duration.fill('5');
  await expect(end).toHaveValue('09:30');
  await duration.blur();
  await expect(duration).toHaveValue('30');
  await duration.fill('');
  await duration.blur();
  await expect(duration).toHaveValue('30');
  expect(await stored()).toBe('30');

  // Mudar o início recalcula o término com a duração padrão.
  await field(form, 'start').fill(`${today}T14:00`);
  await expect(end).toHaveValue('14:30');

  // O término pode ser ajustado à mão e é o que vai para o servidor.
  await end.fill('15:15');
  await saveButton(form).click();
  await expect(form).toHaveCount(0);
  expect(state.writes[0].body).toMatchObject({
    starts_at: at(today, '14:00'),
    ends_at: at(today, '15:15'),
  });

  // Um formulário novo já abre com a duração guardada.
  await newButton(page).click();
  form = page.getByRole('dialog', { name: 'Novo horário' });
  await expect(field(form, 'duration')).toHaveValue('30');
  await expect(field(form, 'end')).toHaveValue('09:30');
});

test('recusa término antes do início e data vazia', async ({ page }) => {
  const state = await mockAgenda(page);
  await openAgenda(page);
  const form = await newAppointment(page);
  const dialogAlert = form.getByRole('alert');

  // 23h40 mais 50 minutos cairia no dia seguinte; o término é sempre no dia do início.
  await field(form, 'start').fill(`${today}T23:40`);
  await expect(field(form, 'end')).toHaveValue('00:30');
  await saveButton(form).click();
  await expect(dialogAlert).toHaveText(
    'O término deve ser depois do início, no mesmo dia.',
  );

  await field(form, 'start').fill('');
  await saveButton(form).click();
  await expect(dialogAlert).toHaveText('Informe data e horários válidos.');
  expect(state.writes).toEqual([]);

  await form.getByRole('button', { name: 'Cancelar' }).click();
  await expect(form).toHaveCount(0);
});

test('editar horário: paciente fixo, mantém a duração ao remarcar e envia a versão', async ({
  page,
}) => {
  const item = slot('B', '10:00', '11:30', {
    patient_name: 'Nome de Registro',
    patient_social_name: 'Paciente B',
    modality: 'teleconsulta',
    admin_notes: 'Retorno',
    version: 3,
  });
  const state = await mockAgenda(page, [item]);
  await openAgenda(page);
  await card(page, 'Paciente B').getByRole('button', { name: 'Editar' }).click();
  const form = page.getByRole('dialog', { name: 'Editar horário' });

  await expect(field(form, 'patient')).toBeDisabled();
  await expect(field(form, 'patient')).toHaveValue('Paciente B');
  await expect(field(form, 'start')).toHaveValue(`${today}T10:00`);
  await expect(field(form, 'end')).toHaveValue('11:30');
  await expect(field(form, 'modality')).toHaveValue('teleconsulta');
  await expect(field(form, 'notes')).toHaveValue('Retorno');
  await expect(form.locator('.patient-matches')).toHaveCount(0);

  // Ao remarcar vale a duração do horário (1h30), não a padrão.
  await field(form, 'start').fill(`${today}T15:00`);
  await expect(field(form, 'end')).toHaveValue('16:30');
  await field(form, 'modality').selectOption('presencial');
  await field(form, 'notes').fill('Remarcado');
  await saveButton(form).click();
  await expect(form).toHaveCount(0);

  expect(state.writes).toEqual([
    {
      action: 'update',
      guard: '1',
      body: {
        id: item.id,
        version: 3,
        patient_id: patient.id,
        starts_at: at(today, '15:00'),
        ends_at: at(today, '16:30'),
        modality: 'presencial',
        admin_notes: 'Remarcado',
      },
    },
  ]);
  await expectCard(page, 'Paciente B', {
    start: '15:00',
    end: '16:30',
    detail: 'Presencial · Remarcado',
    status: 'Agendado',
    buttons: ['Registrar chegada', 'Iniciar consulta', 'Editar', 'Cancelar'],
  });
  // Na edição o paciente não é buscado.
  expect(state.searches).toEqual([]);
});

test('erro ao salvar mantém o formulário aberto e o reenvio usa o mesmo identificador', async ({
  page,
}) => {
  const state = await mockAgenda(page);
  await openAgenda(page);
  const form = await newAppointment(page);
  const dialogAlert = form.getByRole('alert');
  await field(form, 'notes').fill('Retorno');

  state.writeFailure = {
    status: 422,
    json: {
      error:
        'O atendimento deve durar entre 10 minutos e 8 horas, com datas válidas.',
    },
  };
  await saveButton(form).click();
  await expect(dialogAlert).toHaveText(
    'O atendimento deve durar entre 10 minutos e 8 horas, com datas válidas.',
  );
  await expect(saveButton(form)).toBeEnabled();
  await expect(field(form, 'notes')).toHaveValue('Retorno');

  // Resposta de erro sem texto: vale a mensagem padrão.
  state.writeFailure = { status: 500, json: {} };
  await saveButton(form).click();
  await expect(dialogAlert).toHaveText('Não foi possível salvar o horário.');

  state.writeFailure = null;
  await saveButton(form).click();
  await expect(form).toHaveCount(0);
  await expect(card(page, 'Paciente Sintético')).toBeVisible();

  // As três tentativas levam o mesmo identificador: repetir não cria horário em dobro.
  expect(state.writes).toHaveLength(3);
  const ids = state.writes.map((write) => write.body.id);
  expect(new Set(ids).size).toBe(1);
  // Só a tentativa que deu certo recarrega a lista.
  expect(state.loaded).toEqual([today, today]);
});
