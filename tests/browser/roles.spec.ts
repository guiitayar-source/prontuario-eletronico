// Papéis nas telas: owner e doctor veem o que é clínico; secretary não. Um teste por ponto da tela
// que decide pelo papel: abas da lista de pacientes e painel de importação, prontuário, ajustes,
// auditoria na barra da conta e página do SNCR.
import { expect, test, type Page } from '@playwright/test';
import { mockApi, setup } from './fixtures';

/** Caminhos de /api pedidos pela página, para conferir que a secretária não chama rota clínica. */
function apiCalls(page: Page) {
  const paths: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) paths.push(url.pathname);
  });
  return paths;
}
const clinicalPaths = [
  '/api/consultations',
  '/api/clinical-context',
  '/api/documents',
  '/api/digital-signature/providers',
  '/api/digital-signature/session',
];

for (const role of ['owner', 'doctor', 'secretary']) {
  const clinical = role !== 'secretary';
  const shows = clinical ? 'aparece' : 'não aparece';

  test(`${role}: aba "Importar e exportar" ${shows} e o painel lista os lotes`, async ({
    page,
  }) => {
    await mockApi(page, role);
    const imports: string[] = [];
    await page.route('**/api/imports**', async (route) => {
      const request = route.request();
      imports.push(request.method() + ' ' + new URL(request.url()).search);
      await route.fulfill({ json: { batches: [] } });
    });
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: /Paciente Sintético/ }),
    ).toBeVisible();
    const tab = page.getByRole('button', { name: 'Importar e exportar' });
    if (!clinical) {
      await expect(tab).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Cadastros', exact: true }),
      ).toHaveCount(0);
      expect(imports).toEqual([]);
      return;
    }
    await tab.click();
    await expect.poll(() => imports.length).toBeGreaterThan(0);
    expect(new Set(imports)).toEqual(new Set(['GET ']));
  });

  test(`${role}: prontuário ${clinical ? 'abre na consulta' : 'abre só no cadastro'}`, async ({
    page,
  }) => {
    const calls = apiCalls(page);
    await setup(page, role);
    const consultation = page.getByRole('button', {
      name: 'Consulta atual',
      exact: true,
    });
    if (clinical) {
      await expect(page.getByLabel('Evolução em texto livre')).toBeVisible();
      await expect(consultation).toBeEnabled();
      await expect
        .poll(() => clinicalPaths.filter((path) => calls.includes(path)))
        .toEqual(clinicalPaths);
    } else {
      await expect(
        page.getByRole('heading', { name: 'Dados cadastrais' }),
      ).toBeVisible();
      await expect(consultation).toBeDisabled();
      // O editor fica na página, mas escondido (aba da consulta desativada).
      await expect(
        page.getByLabel('Evolução em texto livre'),
      ).not.toBeVisible();
      expect(calls.filter((path) => clinicalPaths.includes(path))).toEqual([]);
    }
  });

  test(`${role}: "Meus dados profissionais" ${shows} em Ajustes`, async ({
    page,
  }) => {
    await mockApi(page, role);
    await page.goto('/');
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Modo' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Meus dados profissionais' }),
    ).toHaveCount(clinical ? 1 : 0);
  });

  test(`${role}: "Auditoria" ${shows} na barra da conta`, async ({ page }) => {
    await mockApi(page, role);
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: /Paciente Sintético/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Auditoria', exact: true }),
    ).toHaveCount(clinical ? 1 : 0);
  });

  test(`${role}: página do SNCR ${clinical ? 'abre' : 'avisa que é só do prescritor'}`, async ({
    page,
  }) => {
    await mockApi(page, role);
    await page.goto('/sncr');
    const heading = page.getByRole('heading', { name: /^SNCR — numeração/ });
    const refused = page.getByText('Acesso exclusivo do prescritor.');
    if (clinical) {
      await expect(heading).toBeVisible();
      await expect(refused).toHaveCount(0);
    } else {
      await expect(refused).toBeVisible();
      await expect(heading).toHaveCount(0);
    }
  });
}
