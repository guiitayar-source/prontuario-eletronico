import { test, expect } from '@playwright/test';
import { setup } from './fixtures';

test('salva e reabre a evolução com horário confirmado', async ({ page }) => {
  const state = await setup(page);
  await page
    .getByLabel('Evolução em texto livre')
    .fill('Texto revisado pelo médico sintético');
  await expect.poll(() => state.saves).toBe(1);
  await expect(page.getByText(/Último salvamento confirmado:/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Paciente Sintético/ }).click();
  await expect(page.getByLabel('Evolução em texto livre')).toHaveValue(
    'Texto revisado pelo médico sintético',
  );
  expect(state.signatures).toBe(0);
});

test('falha de salvamento preserva texto e impede assinatura', async ({
  page,
}) => {
  const state = await setup(page);
  state.failure = true;
  await page
    .getByLabel('Evolução em texto livre')
    .fill('Texto ainda não salvo');
  await page
    .getByRole('button', { name: 'Finalizar e assinar', exact: true })
    .click();
  await expect(
    page.getByText('Falha sintética de rede.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Evolução em texto livre')).toHaveValue(
    'Texto ainda não salvo',
  );
  await expect(
    page.getByRole('button', { name: 'Copiar evolução', exact: true }),
  ).toBeVisible();
  expect(state.signatures).toBe(0);
});

test('conflito compara versões e exige revisão antes de salvar', async ({
  page,
}) => {
  const state = await setup(page);
  state.conflict = true;
  await page
    .getByLabel('Evolução em texto livre')
    .fill('Minha versão revisada');
  await expect(
    page.getByRole('button', { name: 'Comparar versões' }),
  ).toBeVisible();
  state.consultation = {
    ...state.consultation,
    text: 'Versão remota sintética',
    version: 2,
  };
  await page.getByRole('button', { name: 'Comparar versões' }).click();
  await expect(page.getByLabel('Versão do servidor')).toHaveValue(
    'Versão remota sintética',
  );
  await expect(page.getByLabel('Sua versão atual')).toHaveValue(
    'Minha versão revisada',
  );
  state.conflict = false;
  await page
    .getByRole('button', { name: 'Salvar minha versão após revisão' })
    .click();
  await expect.poll(() => state.consultation.version).toBe(3);
  expect(state.consultation.text).toBe('Minha versão revisada');
});

test('secretária acessa cadastro sem editor clínico nem auditoria', async ({
  page,
}) => {
  const state = await setup(page, 'secretary');
  await expect(page.getByLabel('Evolução em texto livre')).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Consulta atual', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: 'Dados cadastrais' }),
  ).toBeVisible();
  expect(state.clinicalRequests).toEqual([]);
  await expect(
    page.getByRole('button', { name: 'Auditoria', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Finalizar e assinar', exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toBe(0);
  expect(state.signatures).toBe(0);
});

test('lista vazia exige confirmação explícita de ausência de medicamentos', async ({
  page,
}) => {
  await setup(page);
  await expect(
    page.getByText('Uso de medicamentos não revisado.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('button', { name: 'Medicamentos', exact: true }).click();
  await page
    .getByRole('button', { name: 'Confirmar: paciente nega uso', exact: true })
    .click();
  await page.getByRole('button', { name: 'Concluir', exact: true }).click();
  await expect(
    page.getByText('Paciente nega uso de medicamentos.'),
  ).toBeVisible();
  await expect(page.getByText(/Última revisão:/)).toBeVisible();
});

test('auditoria aplica filtros no servidor e carrega a próxima página', async ({
  page,
}) => {
  await setup(page);
  const queries: URLSearchParams[] = [];
  await page.route('**/api/audit?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const events = Array.from(
      { length: query.has('before') ? 1 : 100 },
      (_, i) => ({
        id: query.has('before') ? '200' : String(300 - i),
        actor_id: 'conta-sintética',
        action: 'update',
        entity_type: 'patients',
        entity_id: 'paciente-sintético',
        occurred_at: '2026-11-01T12:00:00Z',
      }),
    );
    await route.fulfill({
      json: { events, next: query.has('before') ? null : '201' },
    });
  });
  await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
  await page.getByLabel('Paciente (nome ou ID)').fill('Paciente Sintético');
  await page.getByLabel('De (UTC−03)').fill('2026-11-01');
  await page.getByRole('button', { name: 'Aplicar filtros' }).click();
  await expect
    .poll(() => queries.at(-1)?.get('patient'))
    .toBe('Paciente Sintético');
  await page.getByRole('button', { name: 'Carregar mais 100' }).click();
  await expect(page.getByText('101 eventos carregados')).toBeVisible();
  expect(queries.at(-1)?.get('before')).toBe('201');
  expect(queries.at(-1)?.get('from')).toBe('2026-11-01');
});

test('painel de backup não inventa verificação quando não há relatório', async ({
  page,
}) => {
  await setup(page);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Recuperação por backup' }),
  ).toBeVisible();
  await expect(
    page.getByText('Nenhum backup verificado foi comunicado ao painel.'),
  ).toBeVisible();
  await expect(
    page.getByText('Nenhuma cópia externa foi declarada.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Registrar declaração de cópia externa' }),
  ).toHaveCount(0);
});
