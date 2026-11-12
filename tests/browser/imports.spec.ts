// Importação de prontuários de outro sistema (Pacientes → Importar e exportar) e o histórico
// importado dentro do prontuário. Tudo sintético: a API de importação é respondida aqui, sem
// banco nem rede; a prévia que o servidor montaria é preparada por cada teste.
import { readFileSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockApi, patient } from './fixtures';

type Fields = Record<string, string>;
type PreviewPatient = {
  source_id: string;
  fields: Fields;
  warnings: string[];
  errors: string[];
  candidates: {
    id: string;
    name: string;
    dob: string | null;
    cpf: string | null;
    version: number;
  }[];
  linked_id: string | null;
};
type PreviewRecord = {
  source_id: string;
  patient_source: string;
  kind: string;
  title: string;
  text: string;
  occurred_at: string | null;
  source_created_at: string | null;
  source_status: string;
  fingerprint: string;
  duplicate: boolean;
  conflict: boolean;
};
type Preview = {
  id: string;
  source: string;
  plan: {
    format: 'lgpd' | 'fhir-r4';
    patients: PreviewPatient[];
    records: PreviewRecord[];
    warnings: string[];
  };
};
type Result = {
  id: string;
  created: number;
  imported: number;
  skipped: number;
  patients: { id: string; name: string }[];
};
type Batch = {
  id: string;
  source: string;
  format: string;
  state: 'committed' | 'reverted';
  committed_at: string;
  result: Result;
};
type HistoryRecord = Omit<PreviewRecord, 'duplicate' | 'conflict'> & {
  id: string;
  source: string;
  imported_at: string;
};
type Failure = { status: number; json: Record<string, unknown> };
type Post = {
  action: string | null;
  guard: string | undefined;
  body: Record<string, unknown>;
};

const id = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
let previews = 0;

/** Um paciente da prévia: sem cadastro parecido, sem erro, sem vínculo, salvo o que vier em `extra`. */
const person = (
  source_id: string,
  name: string,
  extra: Partial<PreviewPatient> = {},
): PreviewPatient => ({
  source_id,
  fields: { name, dob: '1990-04-10', cpf: '' },
  warnings: [],
  errors: [],
  candidates: [],
  linked_id: null,
  ...extra,
});
const candidate = (n: number, name: string) => ({
  id: id('cccccccc', n),
  name,
  dob: '1990-04-10',
  cpf: '12345678909',
  version: 1,
});
const entry = (
  source_id: string,
  patient_source: string,
  extra: Partial<PreviewRecord> = {},
): PreviewRecord => ({
  source_id,
  patient_source,
  kind: 'consultation',
  title: 'Consulta inicial',
  text: 'Texto clínico sintético.',
  occurred_at: '2026-08-01T13:00:00Z',
  source_created_at: '2026-08-02',
  source_status: 'Finalizada',
  fingerprint: source_id,
  duplicate: false,
  conflict: false,
  ...extra,
});
const preview = (
  patients: PreviewPatient[],
  records: PreviewRecord[] = [],
  warnings: string[] = [],
  format: Preview['plan']['format'] = 'lgpd',
): Preview => ({
  id: id('77777777', ++previews),
  source: 'Prontuário anterior',
  plan: { format, patients, records, warnings },
});

/** Exportação LGPD sintética de um paciente, como viria de outro sistema. */
const lgpd = (n: number) =>
  JSON.stringify({
    schema_version: '1.0',
    patient: { id: `origem-${n}`, name: `Paciente Origem ${n}` },
    consultations: [],
  });
const jsonFile = (name: string, text: string) => ({
  name,
  mimeType: 'application/json',
  buffer: Buffer.from(text),
});

/** Responde à API de importação como o servidor responderia e guarda o que a tela enviou. */
async function mockImports(page: Page) {
  const api = await mockApi(page);
  const state = {
    api,
    batches: [] as Batch[],
    history: [] as HistoryRecord[],
    // Prévia que o servidor devolveria para o lote enviado.
    previewFor: (() => preview([person('p1', 'Paciente Sintético')])) as (
      file: string,
    ) => Preview,
    result: {
      id: id('88888888', 1),
      created: 1,
      imported: 1,
      skipped: 0,
      patients: [] as Result['patients'],
    } as Result,
    posts: [] as Post[],
    listed: 0,
    historyPages: [] as string[],
    failure: null as Failure | null,
    historyFailure: null as Failure | null,
    // Quando preenchido, a resposta só sai depois que o teste liberar.
    gate: null as Promise<void> | null,
  };
  await page.route(/\/api\/imports(\?|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      const patientId = url.searchParams.get('patientId');
      if (!patientId) {
        state.listed++;
        return route.fulfill({ json: { batches: state.batches } });
      }
      if (url.searchParams.get('count') === '1')
        return route.fulfill({ json: { total: state.history.length } });
      const pageNumber = Number(url.searchParams.get('page'));
      state.historyPages.push(url.searchParams.get('page') || '');
      if (state.gate) await state.gate;
      if (state.historyFailure) return route.fulfill(state.historyFailure);
      return route.fulfill({
        json: {
          records: state.history.slice(pageNumber * 30, pageNumber * 30 + 30),
          total: state.history.length,
        },
      });
    }
    const action = url.searchParams.get('action');
    const body = request.postDataJSON();
    state.posts.push({
      action,
      guard: request.headers()['x-import-action'],
      body,
    });
    if (state.gate) await state.gate;
    if (state.failure) return route.fulfill(state.failure);
    if (action === 'preview')
      return route.fulfill({ json: state.previewFor(body.file) });
    if (action === 'commit') {
      state.batches.unshift({
        id: body.id,
        source: 'Prontuário anterior',
        format: 'lgpd',
        state: 'committed',
        committed_at: '2026-11-10T17:00:00Z',
        result: state.result,
      });
      return route.fulfill({ json: { result: state.result } });
    }
    if (action === 'revert') {
      const batch = state.batches.find((b) => b.id === body.id);
      if (batch) batch.state = 'reverted';
    }
    return route.fulfill({ json: { ok: true } });
  });
  return state;
}

/** Segura as respostas da API de importação até a função devolvida ser chamada. */
function hold(state: { gate: Promise<void> | null }) {
  let release = () => {};
  state.gate = new Promise<void>((resolve) => (release = resolve));
  return () => {
    state.gate = null;
    release();
  };
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

const card = (page: Page, title: string) =>
  page
    .locator('.import-card')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const choose = (page: Page) => card(page, '1. Escolher a exportação');
const review = (page: Page) => card(page, '2. Revisar e escolher os pacientes');
const recent = (page: Page) => card(page, 'Importações recentes');
const resultCard = (page: Page) => card(page, 'Resultado');
// Aviso e mensagem do painel de importação (o painel de exportação tem os seus, dentro do cartão).
const alert = (page: Page) => page.locator('.imports-page > [role=alert]');
const notice = (page: Page) => page.locator('.imports-page > output');
const filesInput = (page: Page) => page.getByLabel('Arquivos (.json ou .zip)');
const generateButton = (page: Page) =>
  choose(page).getByRole('button', { name: /^Gerar prévia|^Analisando/ });
const patientCard = (page: Page, name: string) =>
  review(page)
    .locator('.import-patient')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
const destination = (page: Page, name: string) =>
  patientCard(page, name).getByLabel('Destino do paciente');
const pending = (page: Page) => review(page).locator(':scope > p.capture-error');
const confirmBox = (page: Page) => page.getByLabel(/Conferi os pacientes/);
const commitButton = (page: Page) =>
  review(page).getByRole('button', { name: /Confirmar importação|Processando/ });
const optionLabels = (select: Locator) =>
  select.locator('option').evaluateAll((options) =>
    options.map((o) => (o as HTMLOptionElement).label),
  );

async function openImports(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Importar e exportar' }).click();
  await expect(choose(page)).toBeVisible();
}

test('lista as importações recentes e desfaz um lote com confirmação', async ({
  page,
}) => {
  const state = await mockImports(page);
  const result = (imported: number): Result => ({
    id: id('88888888', imported),
    created: 0,
    imported,
    skipped: 0,
    patients: [],
  });
  state.batches = [
    {
      id: id('66666666', 1),
      source: 'Sistema Antigo',
      format: 'lgpd',
      state: 'committed',
      committed_at: '2026-11-01T13:00:00Z',
      result: result(5),
    },
    {
      id: id('66666666', 2),
      source: 'Outro Sistema',
      format: 'fhir-r4',
      state: 'reverted',
      committed_at: '2026-10-20T18:30:00Z',
      result: result(2),
    },
  ];
  await openImports(page);
  const batches = recent(page).locator('.import-batch');
  await expect(batches).toHaveCount(2);
  await expect(batches.nth(0)).toContainText(
    'Sistema Antigo01/11/2026, 10:00:00 · 5 registro(s) · Concluída',
  );
  await expect(batches.nth(1)).toContainText(
    'Outro Sistema20/10/2026, 15:30:00 · 2 registro(s) · Desfeita',
  );
  // Só lote concluído pode ser desfeito.
  await expect(batches.nth(1).getByRole('button')).toHaveCount(0);
  const undo = batches.nth(0).getByRole('button', { name: 'Desfazer lote' });

  let question = nextConfirm(page, false);
  await undo.click();
  expect(await question).toBe(
    'Desfazer esta importação? Os registros deste lote sairão do histórico ativo. Cadastros de pacientes, alterações locais e auditoria serão preservados.',
  );
  expect(state.posts).toEqual([]);

  // Em desenvolvimento o React monta a tela duas vezes (StrictMode), e a primeira carga da lista
  // pode sair em dobro; por isso conta só o que vem depois daqui.
  const listed = state.listed;
  question = nextConfirm(page, true);
  await undo.click();
  await question;
  await expect(notice(page)).toHaveText(
    'Importação desfeita. Cadastros de pacientes e auditoria preservados.',
  );
  await expect(batches.nth(0)).toContainText('· Desfeita');
  await expect(recent(page).getByRole('button')).toHaveCount(0);
  expect(state.posts).toEqual([
    { action: 'revert', guard: '1', body: { id: id('66666666', 1) } },
  ]);
  // A lista é recarregada depois de desfazer.
  expect(state.listed).toBe(listed + 1);
});

test('sem importações, avisa; gerar prévia exige arquivo e nome de origem', async ({
  page,
}) => {
  await mockImports(page);
  await openImports(page);
  await expect(recent(page)).toContainText('Nenhuma importação concluída.');
  const source = page.getByLabel('Sistema de origem');
  await expect(source).toHaveValue('Prontuário anterior');
  await expect(generateButton(page)).toHaveText('Gerar prévia');
  await expect(generateButton(page)).toBeDisabled();

  await filesInput(page).setInputFiles([jsonFile('a.json', lgpd(1))]);
  await expect(generateButton(page)).toBeEnabled();
  await filesInput(page).setInputFiles([
    jsonFile('a.json', lgpd(1)),
    jsonFile('b.json', lgpd(2)),
  ]);
  await expect(generateButton(page)).toHaveText('Gerar prévia (2 arquivos)');

  // Nome de origem com menos de 2 letras (sem contar espaços) não serve.
  await source.fill(' X ');
  await expect(generateButton(page)).toBeDisabled();
  await source.fill('Sistema Antigo');
  await expect(generateButton(page)).toBeEnabled();
});

test('prévia: destino de cada paciente, avisos, confirmação e resultado', async ({
  page,
}) => {
  const state = await mockImports(page);
  const plan = preview(
    [
      // Sem cadastro parecido: criar novo é o padrão.
      person('p1', 'Ana Sintética', {
        fields: { name: 'Ana Sintética', dob: '1990-04-10', cpf: '12345678909', phone: '11999990000' },
        warnings: ['Telefone sem DDD conferido.'],
      }),
      // Com cadastro parecido: o destino precisa ser escolhido.
      person('p2', 'Bruno Sintético', {
        candidates: [candidate(2, 'Bruno Cadastrado')],
      }),
      // Com erro: fica fora da importação e não oferece outro destino.
      person('p3', 'Carla Sintética', {
        errors: ['Data de nascimento inválida.'],
        candidates: [candidate(3, 'Carla Cadastrada')],
      }),
      // Já vinculado antes: o vínculo vem escolhido e só ele é oferecido.
      person('p4', '', {
        candidates: [candidate(4, 'Davi Cadastrado'), candidate(5, 'Davi Outro')],
        linked_id: id('cccccccc', 4),
      }),
    ],
    [
      entry('r1', 'p1'),
      entry('r2', 'p2', { kind: 'prescription', title: 'Receita antiga', duplicate: true, occurred_at: '2026-07-15', source_status: '', text: '' }),
    ],
    ['Aviso sintético do arquivo.'],
  );
  state.previewFor = () => plan;
  state.result = {
    id: id('88888888', 9),
    created: 1,
    imported: 1,
    skipped: 1,
    patients: [{ id: patient.id, name: 'Paciente Sintético' }],
  };
  await openImports(page);
  await page.getByLabel('Sistema de origem').fill('Sistema Antigo');
  await filesInput(page).setInputFiles([jsonFile('exportacao.json', lgpd(1))]);
  await generateButton(page).click();

  await expect(review(page)).toBeVisible();
  await expect(choose(page)).toHaveCount(0);
  expect(state.posts).toEqual([
    {
      action: 'preview',
      guard: '1',
      body: { source: 'Sistema Antigo', file: lgpd(1) },
    },
  ]);
  await expect(review(page).locator(':scope > p').first()).toHaveText(
    'Portabilidade LGPD · 4 paciente(s) · 2 registro(s). Prévia válida por uma hora.',
  );
  await expect(review(page).locator('details.import-entry').first()).toContainText(
    'Avisos da importação (1)Aviso sintético do arquivo.',
  );

  // Ana: dados conferíveis, aviso e registro.
  const ana = patientCard(page, 'Ana Sintética');
  await expect(ana.locator('p').first()).toHaveText(
    'Nascimento: 10/04/1990 · CPF: 12345678909 · Origem: p1',
  );
  await expect(ana.locator('p.capture-notice')).toHaveText([
    'Telefone sem DDD conferido.',
  ]);
  await expect(ana.locator('dl').first()).toContainText(
    'Nome completoAna SintéticaData de nascimento1990-04-10CPF12345678909Telefone principal11999990000',
  );
  const anaEntry = ana.locator('.import-entry');
  await expect(anaEntry.locator('summary')).toHaveText(
    'Consulta Consulta inicial · 01/08/2026, 10:00:00',
  );
  await expect(anaEntry.locator('dl')).toHaveText(
    'Data na origem01/08/2026, 10:00:00Registro criado na origem02/08/2026Situação na origemFinalizadaID na origemr1',
  );
  await expect(anaEntry.locator('pre')).toHaveText('Texto clínico sintético.');
  await expect(destination(page, 'Ana Sintética')).toHaveValue('new');
  expect(await optionLabels(destination(page, 'Ana Sintética'))).toEqual([
    'Selecione após conferir a identificação',
    'Criar novo cadastro',
    'Não importar este paciente',
  ]);

  // Bruno: precisa escolher; o registro repetido será ignorado.
  const bruno = patientCard(page, 'Bruno Sintético');
  await expect(destination(page, 'Bruno Sintético')).toHaveValue('');
  expect(await optionLabels(destination(page, 'Bruno Sintético'))).toEqual([
    'Selecione após conferir a identificação',
    'Vincular a Bruno Cadastrado · 10/04/1990 · CPF 12345678909',
    'Não importar este paciente',
  ]);
  await expect(bruno.locator('p.muted')).toHaveText(
    'O cadastro existente será preservado. A importação acrescenta apenas o histórico.',
  );
  await expect(bruno.locator('p.capture-notice')).toHaveText(
    'Já importado: será ignorado.',
  );
  await expect(bruno.locator('.import-entry summary')).toHaveText(
    'Receita Receita antiga · 15/07/2026',
  );
  await expect(bruno.locator('.import-entry dd').nth(2)).toHaveText('Não informada');
  await expect(bruno.locator('.import-entry pre')).toHaveText(
    'Sem texto clínico no arquivo.',
  );

  // Carla: com erro, fica de fora.
  const carla = patientCard(page, 'Carla Sintética');
  await expect(carla.locator('p.capture-error')).toHaveText([
    'Data de nascimento inválida.',
  ]);
  await expect(destination(page, 'Carla Sintética')).toHaveValue('skip');
  expect(await optionLabels(destination(page, 'Carla Sintética'))).toEqual([
    'Selecione após conferir a identificação',
    'Não importar este paciente',
  ]);

  // Sem nome na origem: aparece como "Paciente sem nome", já vinculado.
  const davi = patientCard(page, 'Paciente sem nome');
  await expect(davi.getByLabel('Destino do paciente')).toHaveValue(id('cccccccc', 4));
  expect(await optionLabels(davi.getByLabel('Destino do paciente'))).toEqual([
    'Selecione após conferir a identificação',
    'Vincular a Davi Cadastrado · 10/04/1990 · CPF 12345678909',
    'Não importar este paciente',
  ]);
  await expect(davi.locator('p.capture-notice')).toHaveText(
    'Este paciente da origem já possui vínculo. Confira o destino para continuar.',
  );

  // O que falta decidir aparece por escrito, e o botão espera a confirmação.
  await expect(pending(page)).toHaveText([
    'Escolha o destino (vincular ao cadastro existente ou não importar): Bruno Sintético.',
  ]);
  await expect(commitButton(page)).toBeDisabled();
  await confirmBox(page).check();
  await expect(commitButton(page)).toBeDisabled();
  await destination(page, 'Bruno Sintético').selectOption(id('cccccccc', 2));
  await expect(pending(page)).toHaveCount(0);
  // Mudar um destino desfaz a confirmação.
  await expect(confirmBox(page)).not.toBeChecked();
  await expect(commitButton(page)).toBeDisabled();
  await confirmBox(page).check();
  await expect(commitButton(page)).toBeEnabled();

  const listed = state.listed;
  const release = hold(state);
  await commitButton(page).click();
  await expect(commitButton(page)).toHaveText('Processando…');
  await expect(commitButton(page)).toBeDisabled();
  await expect(confirmBox(page)).toBeDisabled();
  await expect(destination(page, 'Ana Sintética')).toBeDisabled();
  await expect(review(page).getByRole('button', { name: 'Cancelar prévia' })).toBeDisabled();
  release();

  await expect(notice(page)).toHaveText('Importação concluída.');
  await expect(review(page)).toHaveCount(0);
  await expect(resultCard(page).locator('p')).toHaveText(
    '1 cadastro(s) criado(s), 1 registro(s) importado(s), 1 repetido(s) ignorado(s).',
  );
  expect(state.posts[1]).toEqual({
    action: 'commit',
    guard: '1',
    body: {
      id: plan.id,
      confirmed: true,
      choices: [
        { source_id: 'p1', target: 'new' },
        { source_id: 'p2', target: id('cccccccc', 2) },
        { source_id: 'p3', target: 'skip' },
        { source_id: 'p4', target: id('cccccccc', 4) },
      ],
    },
  });
  // Volta ao passo 1 sem arquivos escolhidos, e a lista de importações é recarregada.
  await expect(filesInput(page)).toHaveValue('');
  await expect(generateButton(page)).toBeDisabled();
  await expect(recent(page).locator('.import-batch')).toHaveCount(1);
  expect(state.listed).toBe(listed + 1);

  // "Abrir" leva ao prontuário do paciente importado.
  await resultCard(page)
    .getByRole('button', { name: 'Abrir Paciente Sintético' })
    .click();
  await expect(page.getByLabel('Evolução em texto livre')).toHaveValue(
    state.api.consultation.text,
  );
});

test('nome ou CPF repetido no lote e registro em conflito impedem a confirmação', async ({
  page,
}) => {
  const state = await mockImports(page);
  state.previewFor = () =>
    preview(
      [
        person('p1', 'José da Silva'),
        person('p2', ' jose  DA silva '),
        person('p3', 'Maria Souza', { fields: { name: 'Maria Souza', dob: '', cpf: '11122233344' } }),
        person('p4', 'Marta Lima', { fields: { name: 'Marta Lima', dob: '', cpf: '11122233344' } }),
        person('p5', 'Rui Conflito'),
      ],
      [entry('r5', 'p5', { conflict: true })],
      [],
      'fhir-r4',
    );
  await openImports(page);
  await filesInput(page).setInputFiles([jsonFile('bundle.json', '{}')]);
  await generateButton(page).click();
  await expect(review(page).locator(':scope > p').first()).toHaveText(
    'FHIR R4 · 5 paciente(s) · 1 registro(s). Prévia válida por uma hora.',
  );
  await expect(patientCard(page, 'Rui Conflito').locator('p.capture-error')).toHaveText(
    'ID já importado com conteúdo diferente. Revise a origem ou ignore este paciente.',
  );
  await expect(pending(page)).toHaveText([
    'Mesmo nome ou CPF mais de uma vez neste lote: José da Silva,  jose  DA silva , Maria Souza, Marta Lima. Importe só um agora ("Não importar este paciente" no outro) e, depois, selecione o .zip do outro sozinho e vincule-o ao cadastro criado.',
    'Registros já importados com conteúdo diferente; marque "Não importar este paciente": Rui Conflito.',
  ]);
  await confirmBox(page).check();
  await expect(commitButton(page)).toBeDisabled();

  await destination(page, ' jose  DA silva ').selectOption('skip');
  await destination(page, 'Marta Lima').selectOption('skip');
  await expect(pending(page)).toHaveText([
    'Registros já importados com conteúdo diferente; marque "Não importar este paciente": Rui Conflito.',
  ]);
  await confirmBox(page).check();
  await expect(commitButton(page)).toBeDisabled();

  await destination(page, 'Rui Conflito').selectOption('skip');
  await expect(pending(page)).toHaveCount(0);
  await confirmBox(page).check();
  await expect(commitButton(page)).toBeEnabled();

  // Ninguém para importar também é dito por escrito.
  for (const name of ['José da Silva', 'Maria Souza'])
    await destination(page, name).selectOption('skip');
  await expect(pending(page)).toHaveText([
    'Nenhum paciente selecionado para importar.',
  ]);
  await confirmBox(page).check();
  await expect(commitButton(page)).toBeDisabled();

  // Cancelar a prévia de um lote só não deixa mensagem e volta ao passo 1.
  await review(page).getByRole('button', { name: 'Cancelar prévia' }).click();
  await expect(choose(page)).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  expect(state.posts.at(-1)).toEqual({
    action: 'cancel',
    guard: '1',
    body: { id: id('77777777', previews) },
  });
});

test('vários arquivos viram lotes, e cada lote tem a sua prévia', async ({
  page,
}) => {
  const state = await mockImports(page);
  // A prévia de cada lote traz os pacientes que estavam nele.
  state.previewFor = (file) => {
    const lot = JSON.parse(file).lote as { patient: { id: string; name: string } }[];
    return preview(lot.map((root) => person(root.patient.id, root.patient.name)));
  };
  await openImports(page);
  const files = Array.from({ length: 31 }, (_, i) =>
    jsonFile(`paciente-${i + 1}.json`, lgpd(i + 1)),
  );
  await filesInput(page).setInputFiles(files);
  await generateButton(page).click();

  // 31 exportações: um lote de 30 e outro de 1.
  await expect(review(page).locator(':scope > p').first()).toHaveText(
    'Portabilidade LGPD · 30 paciente(s) · 0 registro(s). Prévia válida por uma hora. Lote 1 de 2.',
  );
  await expect(review(page).locator('.import-patient')).toHaveCount(30);
  await confirmBox(page).check();
  await commitButton(page).click();

  await expect(notice(page)).toHaveText(
    'Lote 1 de 2 importado. Confira o próximo.',
  );
  await expect(review(page).locator(':scope > p').first()).toHaveText(
    'Portabilidade LGPD · 1 paciente(s) · 0 registro(s). Prévia válida por uma hora. Lote 2 de 2.',
  );
  await expect(patientCard(page, 'Paciente Origem 31')).toBeVisible();
  // A nova prévia precisa de nova confirmação.
  await expect(confirmBox(page)).not.toBeChecked();
  await confirmBox(page).check();
  await commitButton(page).click();
  await expect(notice(page)).toHaveText('Importação concluída.');
  await expect(choose(page)).toBeVisible();

  const sent = state.posts.filter((p) => p.action === 'preview');
  expect(sent.map((p) => JSON.parse(p.body.file as string).lote.length)).toEqual([30, 1]);
  expect(state.posts.map((p) => p.action)).toEqual([
    'preview',
    'commit',
    'preview',
    'commit',
  ]);
});

test('cancelar no meio dos lotes interrompe os restantes', async ({ page }) => {
  const state = await mockImports(page);
  await openImports(page);
  await filesInput(page).setInputFiles(
    Array.from({ length: 31 }, (_, i) => jsonFile(`p${i}.json`, lgpd(i))),
  );
  await generateButton(page).click();
  await expect(review(page)).toContainText('Lote 1 de 2.');
  await review(page).getByRole('button', { name: 'Cancelar prévia' }).click();
  await expect(notice(page)).toHaveText(
    'Importação interrompida. Os lotes restantes não foram enviados.',
  );
  await expect(choose(page)).toBeVisible();
  // Os arquivos continuam escolhidos para tentar de novo.
  await expect(generateButton(page)).toHaveText('Gerar prévia (31 arquivos)');
  expect(state.posts.map((p) => p.action)).toEqual(['preview', 'cancel']);
});

test('erros de arquivo e do servidor aparecem como aviso, sem perder a prévia', async ({
  page,
}) => {
  const state = await mockImports(page);
  await openImports(page);

  // Arquivo maior que 2 MB nem chega ao servidor.
  await filesInput(page).setInputFiles([
    jsonFile('grande.json', 'x'.repeat(2_000_001)),
  ]);
  await generateButton(page).click();
  await expect(alert(page)).toHaveText('Escolha arquivos JSON de até 2 MB.');

  // Escolher outros arquivos limpa o aviso.
  await filesInput(page).setInputFiles([
    jsonFile('a.json', lgpd(1)),
    jsonFile('b.json', '{ quebrado'),
  ]);
  await expect(alert(page)).toHaveCount(0);
  await generateButton(page).click();
  await expect(alert(page)).toHaveText(
    'Um dos arquivos contém JSON inválido. Nada foi importado.',
  );
  expect(state.posts).toEqual([]);

  // Recusa do servidor ao gerar a prévia.
  await filesInput(page).setInputFiles([jsonFile('a.json', lgpd(1))]);
  state.failure = {
    status: 422,
    json: { error: 'O arquivo contém JSON incompleto ou inválido.' },
  };
  await generateButton(page).click();
  await expect(alert(page)).toHaveText(
    'O arquivo contém JSON incompleto ou inválido.',
  );
  await expect(choose(page)).toBeVisible();

  // Falha ao confirmar: a prévia continua na tela para tentar de novo.
  state.failure = null;
  await generateButton(page).click();
  await expect(alert(page)).toHaveCount(0);
  await confirmBox(page).check();
  state.failure = { status: 500, json: {} };
  await commitButton(page).click();
  await expect(alert(page)).toHaveText('Não foi possível concluir a importação.');
  await expect(review(page)).toBeVisible();
  await expect(confirmBox(page)).toBeChecked();

  state.failure = null;
  await commitButton(page).click();
  await expect(notice(page)).toHaveText('Importação concluída.');
  await expect(alert(page)).toHaveCount(0);
});

test('o exemplo fictício gera a prévia sem escolher arquivo', async ({
  page,
}) => {
  const state = await mockImports(page);
  await openImports(page);
  await choose(page)
    .getByRole('button', { name: 'Testar exemplo fictício' })
    .click();
  await expect(review(page)).toBeVisible();
  expect(state.posts).toEqual([
    {
      action: 'preview',
      guard: '1',
      body: {
        source: 'Prontuário anterior',
        file: readFileSync('public/examples/import-lgpd.json', 'utf8'),
      },
    },
  ]);
});

test('enquanto analisa, a navegação fica travada', async ({ page }) => {
  const state = await mockImports(page);
  await openImports(page);
  await filesInput(page).setInputFiles([jsonFile('a.json', lgpd(1))]);
  const release = hold(state);
  await generateButton(page).click();
  await expect(generateButton(page)).toHaveText('Analisando…');
  await expect(generateButton(page)).toBeDisabled();
  await expect(page.getByLabel('Sistema de origem')).toBeDisabled();
  await expect(filesInput(page)).toBeDisabled();
  await expect(
    choose(page).getByRole('button', { name: 'Testar exemplo fictício' }),
  ).toBeDisabled();
  // O painel avisa a tela de pacientes, que trava as abas e o menu lateral.
  await expect(page.getByRole('button', { name: 'Cadastros' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Arquivados' })).toBeDisabled();
  await expect(
    page
      .getByRole('navigation', { name: 'Navegação principal' })
      .getByRole('button', { name: 'Agenda' }),
  ).toBeDisabled();
  release();
  await expect(review(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cadastros' })).toBeEnabled();
});

/** Registros já importados de um paciente, como o servidor devolveria. */
const history = (count: number): HistoryRecord[] =>
  Array.from({ length: count }, (_, i) => {
    const { duplicate: _d, conflict: _c, ...record } = entry(`h${i + 1}`, 'origem-1', {
      title: `Registro ${i + 1}`,
    });
    return {
      ...record,
      id: id('55555555', i + 1),
      source: 'Sistema Antigo',
      imported_at: '2026-11-01T13:00:00Z',
    };
  });

async function openHistory(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Paciente Sintético/ }).click();
  await expect(page.getByLabel('Evolução em texto livre')).toBeVisible();
  await page.getByRole('button', { name: 'Histórico importado' }).click();
}
const historyCard = (page: Page) => card(page, 'Histórico importado');

test('histórico importado no prontuário: registros, detalhes e páginas', async ({
  page,
}) => {
  const state = await mockImports(page);
  state.history = history(31);
  const release = hold(state);
  await openHistory(page);
  await expect(historyCard(page)).toContainText('Carregando histórico…');
  release();
  const items = historyCard(page).locator('article');
  await expect(items).toHaveCount(30);
  await expect(historyCard(page)).not.toContainText('Carregando histórico…');
  await expect(items.first().locator('p.muted')).toHaveText(
    'Sistema Antigo · Importado em 01/11/2026, 10:00:00',
  );
  await expect(items.first().locator('summary')).toHaveText(
    'Consulta Registro 1 · 01/08/2026, 10:00:00',
  );
  await items.first().locator('summary').click();
  await expect(items.first().locator('pre')).toBeVisible();
  await expect(items.first().locator('pre')).toHaveText('Texto clínico sintético.');

  // A primeira página pode ser pedida duas vezes em desenvolvimento (StrictMode monta duas vezes).
  expect(new Set(state.historyPages)).toEqual(new Set(['0']));
  const requested = state.historyPages.length;
  const previous = historyCard(page).getByRole('button', { name: 'Anterior' });
  const next = historyCard(page).getByRole('button', { name: 'Próxima' });
  await expect(historyCard(page).locator('.import-actions span')).toHaveText(
    'Página 1 de 2',
  );
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(items).toHaveCount(1);
  await expect(items.first().locator('summary')).toHaveText(
    'Consulta Registro 31 · 01/08/2026, 10:00:00',
  );
  await expect(historyCard(page).locator('.import-actions span')).toHaveText(
    'Página 2 de 2',
  );
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(items).toHaveCount(30);
  expect(state.historyPages.slice(requested)).toEqual(['1', '0']);
});

test('histórico importado: aviso de erro e lista vazia', async ({ page }) => {
  const state = await mockImports(page);
  state.history = history(1);
  state.historyFailure = {
    status: 500,
    json: { error: 'Falha sintética no histórico.' },
  };
  await openHistory(page);
  await expect(historyCard(page).getByRole('alert')).toHaveText(
    'Falha sintética no histórico.',
  );
  // Com a falha, nada carregado: a lista aparece vazia.
  await expect(historyCard(page)).toContainText(
    'Nenhum registro importado para este paciente.',
  );
  await expect(historyCard(page).locator('.import-actions')).toHaveCount(0);
});

test('sem registros importados, o prontuário não mostra a aba', async ({
  page,
}) => {
  await mockImports(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Paciente Sintético/ }).click();
  await expect(page.getByLabel('Evolução em texto livre')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Cadastro', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Histórico importado' }),
  ).toHaveCount(0);
});
