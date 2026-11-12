// Tela do celular (/celular): anexar fotos e PDFs ao prontuário a partir do QR code.
// Tudo sintético: a API de captura e o Storage são respondidos aqui, sem banco nem rede.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './fixtures';

const pairingId = 'eeeeeeee-0000-4000-8000-000000000001';
const deviceToken = 'ab'.repeat(32);
const pairingUrl = `/celular#${pairingId}.${deviceToken}`;

type Upload = {
  requestId: string;
  uploadId: string;
  name: string;
  mime: string;
  size: number;
};
const requestFor = (id: string, patientName: string) => ({
  id,
  patient_name: patientName,
  patient_id: 'cccccccc-0000-4000-8000-000000000001',
  category: 'pending',
  expires_at: Date.now() + 10 * 60_000,
  state: 'pending',
});
const firstRequest = 'ffffffff-0000-4000-8000-000000000001';
const secondRequest = 'ffffffff-0000-4000-8000-000000000002';

/** Responde à API de captura como o servidor responderia e guarda o que o celular enviou. */
async function mockCapture(page: Page) {
  await signIn(page);
  const state = {
    request: requestFor(firstRequest, 'Paciente Sintético') as ReturnType<
      typeof requestFor
    > | null,
    deviceExpiresAt: Date.now() + 10 * 60_000,
    pollError: '',
    failCommitOnce: '',
    prepared: [] as Upload[],
    committed: [] as Upload[],
    completed: [] as string[],
    disconnected: [] as string[],
  };
  await page.route('**/api/capture**', async (route) => {
    const request = route.request();
    const action = new URL(request.url()).searchParams.get('action');
    if (action === 'mobile') {
      if (state.pollError)
        return route.fulfill({ status: 503, json: { error: state.pollError } });
      if (request.headers()['x-device-token'] !== deviceToken)
        return route.fulfill({ status: 401, json: { error: 'Sem token.' } });
      return route.fulfill({
        json: {
          request: state.request,
          expires_at: state.deviceExpiresAt,
          connected: true,
        },
      });
    }
    const body = request.postDataJSON();
    if (action === 'prepare') {
      state.prepared.push(body);
      return route.fulfill({ json: { path: `sintetico/${body.uploadId}` } });
    }
    if (action === 'commit') {
      if (state.failCommitOnce === body.name) {
        state.failCommitOnce = '';
        return route.fulfill({
          status: 500,
          json: { error: 'Falha sintética no envio.' },
        });
      }
      state.committed.push(body);
    } else if (action === 'complete') {
      state.completed.push(body.id);
      const current = state.request;
      if (current && current.id === body.id)
        state.request = { ...current, state: 'complete' };
    } else if (action === 'disconnect') state.disconnected.push(body.id);
    return route.fulfill({ json: { ok: true } });
  });
  return state;
}

const pdf = (name: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n% arquivo sintético\n'),
});
/** Uma imagem PNG de verdade (o editor de tarja precisa conseguir abri-la). */
async function png(page: Page, name: string) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#1a1a1a';
    ctx.font = '24px sans-serif';
    ctx.fillText('Nome: Paciente Sintético', 20, 60);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}
type Chosen = ReturnType<typeof pdf>;
/** Escolhe arquivos por um dos dois botões da tela, como a pessoa faria. */
async function choose(page: Page, button: RegExp, files: Chosen[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: button }).click();
  await (await chooser).setFiles(files);
}
const gallery = /Galeria ou PDF/;
const destination = (page: Page) => page.locator('.capture-destination');
// O Next também tem um elemento com role=alert (anúncio de rota); este é o aviso da tela.
const alert = (page: Page) => page.locator('.mobile-capture [role=alert]');
const pagesHeading = (page: Page) =>
  page.getByRole('heading', { name: /Conferir páginas/ });
const confirmPatient = (page: Page) =>
  page.getByLabel(/Confirmo que estes arquivos pertencem a/);

test('sem pareamento, orienta a ler o QR code no computador', async ({
  page,
}) => {
  await mockCapture(page);
  await page.goto('/celular');
  await expect(
    page.getByRole('heading', { name: 'Conecte pelo computador' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Tirar foto/ })).toHaveCount(0);
});

test('link de conexão malformado é recusado com aviso', async ({ page }) => {
  await mockCapture(page);
  await page.goto('/celular#nao-e-um-link');
  await expect(alert(page)).toContainText(
    'Link de conexão inválido. Leia o QR code novamente.',
  );
  await expect(
    page.getByRole('heading', { name: 'Conecte pelo computador' }),
  ).toBeVisible();
});

test('pareia pelo link, some com o segredo da barra de endereço e sobrevive a recarregar', async ({
  page,
}) => {
  await mockCapture(page);
  await page.goto(pairingUrl);
  await expect(destination(page)).toContainText('Paciente Sintético');
  await expect(destination(page)).toContainText('DESTINO DA SOLICITAÇÃO');
  await expect(page).toHaveURL(/\/celular$/);
  await expect(page.getByText(/Conexão temporária até \d\d:\d\d/)).toBeVisible();
  await page.reload();
  await expect(destination(page)).toContainText('Paciente Sintético');
  await expect(page.getByRole('button', { name: /Tirar foto/ })).toBeEnabled();
});

test('confere, renomeia, reordena e envia as páginas', async ({ page }) => {
  const state = await mockCapture(page);
  await page.goto(pairingUrl);
  await choose(page, /Tirar foto/, [await png(page, 'foto.png')]);
  await choose(page, gallery, [pdf('laudo antigo.pdf')]);
  await expect(pagesHeading(page)).toContainText('2');
  await expect(destination(page)).toContainText('FIXADO PARA ESTAS PÁGINAS');

  const cards = page.locator('.capture-page');
  await expect(cards.nth(0).locator('.page-name-input')).toHaveValue('foto');
  await expect(cards.nth(0).locator('.page-name-ext')).toHaveText('.png');
  await expect(cards.nth(1).getByText('Conferir PDF')).toBeVisible();
  await cards.nth(0).getByRole('button', { name: 'Hemograma' }).click();
  await expect(cards.nth(0).locator('.page-name-input')).toHaveValue(
    'Hemograma',
  );
  await cards.nth(1).locator('.page-name-input').fill('Laudo/2024');

  await expect(page.getByLabel('Subir página 1')).toBeDisabled();
  await expect(page.getByLabel('Descer página 2')).toBeDisabled();
  await page.getByLabel('Descer página 1').click();
  await expect(cards.nth(0).locator('.page-name-input')).toHaveValue(
    'Laudo/2024',
  );

  const send = page.getByRole('button', { name: 'Enviar 2 arquivo(s)' });
  await expect(send).toBeDisabled();
  await confirmPatient(page).check();
  await send.click();
  await expect(page.getByRole('status')).toHaveText(
    'Envio concluído. Os arquivos já estão disponíveis no computador.',
  );
  expect(
    state.committed.map(({ requestId, name, mime }) => ({
      requestId,
      name,
      mime,
    })),
  ).toEqual([
    { requestId: firstRequest, name: 'Laudo_2024.pdf', mime: 'application/pdf' },
    { requestId: firstRequest, name: 'Hemograma.png', mime: 'image/png' },
  ]);
  expect(state.completed).toEqual([firstRequest]);
  await expect(pagesHeading(page)).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Pronto para o próximo envio' }),
  ).toBeVisible();
});

test('remover página e limpar seleção devolvem a tela ao início', async ({
  page,
}) => {
  await mockCapture(page);
  await page.goto(pairingUrl);
  await choose(page, gallery, [pdf('um.pdf'), pdf('dois.pdf')]);
  await expect(pagesHeading(page)).toContainText('2');
  await page.getByLabel('Remover página 1').click();
  await expect(pagesHeading(page)).toContainText('1');
  await expect(page.locator('.page-name-input')).toHaveValue('dois');
  await confirmPatient(page).check();
  await page
    .getByRole('button', {
      name: 'Limpar seleção e acompanhar nova solicitação',
    })
    .click();
  await expect(pagesHeading(page)).toHaveCount(0);
  await expect(destination(page)).toContainText('DESTINO DA SOLICITAÇÃO');
  await choose(page, gallery, [pdf('tres.pdf')]);
  await expect(confirmPatient(page)).not.toBeChecked();
});

test('recusa mais de 10 arquivos, arquivo vazio e tipo não aceito', async ({
  page,
}) => {
  await mockCapture(page);
  await page.goto(pairingUrl);
  await choose(
    page,
    gallery,
    Array.from({ length: 11 }, (_, i) => pdf(`arquivo-${i}.pdf`)),
  );
  await expect(alert(page)).toContainText(
    'Envie até 10 arquivos por solicitação.',
  );
  await choose(page, gallery, [{ ...pdf('vazio.pdf'), buffer: Buffer.alloc(0) }]);
  await expect(alert(page)).toContainText(
    'Cada arquivo precisa ter entre 1 byte e 12 MB.',
  );
  await choose(page, gallery, [
    { name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('texto') },
  ]);
  await expect(alert(page)).toContainText(
    'Use fotos JPG, PNG, WebP ou arquivos PDF.',
  );
  await expect(pagesHeading(page)).toHaveCount(0);
});

test('falha no meio do envio preserva as páginas e reenvia só as restantes', async ({
  page,
}) => {
  const state = await mockCapture(page);
  await page.goto(pairingUrl);
  await choose(page, gallery, [pdf('primeiro.pdf'), pdf('segundo.pdf')]);
  await confirmPatient(page).check();
  state.failCommitOnce = 'segundo.pdf';
  await page.getByRole('button', { name: 'Enviar 2 arquivo(s)' }).click();
  await expect(alert(page)).toContainText(
    'Falha sintética no envio.',
  );
  await expect(page.getByRole('status')).toContainText(
    'Tente novamente para enviar apenas as restantes.',
  );
  const cards = page.locator('.capture-page');
  await expect(cards.nth(0)).toContainText('Recebido no computador');
  await expect(cards.nth(1)).not.toContainText('Recebido no computador');
  await expect(cards.nth(0).locator('.page-name-input')).toBeDisabled();
  await expect(page.getByLabel('Remover página 1')).toBeDisabled();
  await expect(page.getByRole('button', { name: gallery })).toBeDisabled();
  expect(state.completed).toEqual([]);

  await page.getByRole('button', { name: 'Enviar 1 arquivo(s)' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Envio concluído. Os arquivos já estão disponíveis no computador.',
  );
  expect(state.committed.map((u) => u.name)).toEqual([
    'primeiro.pdf',
    'segundo.pdf',
  ]);
  expect(state.completed).toEqual([firstRequest]);
});

test('tarja: cobre parte da imagem, permite desfazer e troca o arquivo enviado', async ({
  page,
}) => {
  const state = await mockCapture(page);
  await page.goto(pairingUrl);
  const original = await png(page, 'exame.png');
  await choose(page, gallery, [original, pdf('laudo.pdf')]);
  const cards = page.locator('.capture-page');
  // A tarja só existe para imagens.
  await expect(cards.nth(1).getByRole('button', { name: /tarja/i })).toHaveCount(
    0,
  );
  await cards.nth(0).getByRole('button', { name: 'Ocultar dados (tarja)' }).click();

  const dialog = page.getByRole('dialog', {
    name: 'Ocultar dados identificadores',
  });
  await expect(dialog.getByText('Carregando imagem…')).toHaveCount(0);
  const undo = dialog.getByRole('button', { name: 'Desfazer' });
  await expect(undo).toBeDisabled();
  const box = (await dialog.locator('canvas').boundingBox())!;
  const drag = async (fromX: number, toX: number) => {
    await page.mouse.move(box.x + box.width * fromX, box.y + box.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * toX, box.y + box.height * 0.3, {
      steps: 4,
    });
    await page.mouse.up();
  };
  await drag(0.05, 0.6);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(undo).toBeDisabled();
  await dialog.getByRole('button', { name: 'Pincel livre' }).click();
  await drag(0.05, 0.6);
  await expect(undo).toBeEnabled();
  await dialog.getByRole('button', { name: 'Aplicar tarja' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    cards.nth(0).getByRole('button', { name: 'Tarja aplicada (editar)' }),
  ).toBeVisible();
  // A prévia da página já é a imagem tarjada: preto onde o pincel passou, intacta fora dele.
  const pixel = (fx: number, fy: number) =>
    cards
      .nth(0)
      .locator('img')
      .evaluate(
        async (img: HTMLImageElement, [x, y]) => {
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const at = [Math.round(canvas.width * x), Math.round(canvas.height * y)];
          return Math.max(...ctx.getImageData(at[0], at[1], 1, 1).data.slice(0, 3));
        },
        [fx, fy],
      );
  expect(await pixel(0.325, 0.225)).toBeLessThan(40);
  expect(await pixel(0.9, 0.9)).toBeGreaterThan(215);

  // Cancelar uma segunda edição não desfaz a tarja já aplicada.
  await cards.nth(0).getByRole('button', { name: 'Tarja aplicada (editar)' }).click();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(
    cards.nth(0).getByRole('button', { name: 'Tarja aplicada (editar)' }),
  ).toBeVisible();

  await confirmPatient(page).check();
  await page.getByRole('button', { name: 'Enviar 2 arquivo(s)' }).click();
  await expect(page.getByRole('status')).toContainText('Envio concluído.');
  expect(state.committed[0].name).toBe('exame.png');
  expect(state.committed[0].mime).toBe('image/png');
  // O que sobe é a imagem tarjada, não a original.
  expect(state.committed[0].size).not.toBe(original.buffer.length);
});

test('nova solicitação no computador não muda o destino das páginas já escolhidas', async ({
  page,
}) => {
  const state = await mockCapture(page);
  await page.goto(pairingUrl);
  await choose(page, gallery, [pdf('laudo.pdf')]);
  state.request = requestFor(secondRequest, 'Outra Paciente Sintética');
  await expect(
    page.getByText('O computador abriu uma nova solicitação.'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(destination(page)).toContainText('Paciente Sintético');
  await confirmPatient(page).check();
  await expect(
    page.getByRole('button', { name: 'Enviar 1 arquivo(s)' }),
  ).toBeDisabled();
  await page
    .getByRole('button', {
      name: 'Limpar seleção e acompanhar nova solicitação',
    })
    .click();
  await expect(destination(page)).toContainText('Outra Paciente Sintética');
  expect(state.committed).toEqual([]);
});

test('conexão vencida bloqueia o envio', async ({ page }) => {
  const state = await mockCapture(page);
  state.deviceExpiresAt = Date.now() - 1000;
  await page.goto(pairingUrl);
  await expect(
    page.getByText('A conexão ou solicitação expirou.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Tirar foto/ })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Pronto para o próximo envio' }),
  ).toHaveCount(0);
});

test('erro de conexão aparece e o botão de tentar de novo reconecta', async ({
  page,
}) => {
  const state = await mockCapture(page);
  state.pollError = 'Servidor sintético indisponível.';
  await page.goto(pairingUrl);
  await expect(alert(page)).toContainText(
    'Servidor sintético indisponível.',
  );
  await expect(page.getByRole('button', { name: /Tirar foto/ })).toHaveCount(0);
  state.pollError = '';
  await page.getByRole('button', { name: 'Tentar reconectar' }).click();
  await expect(alert(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Tirar foto/ })).toBeEnabled();
});

test('desconectar encerra a sessão do celular', async ({ page }) => {
  const state = await mockCapture(page);
  await page.goto(pairingUrl);
  await choose(page, gallery, [pdf('laudo.pdf')]);
  await page.getByRole('button', { name: 'Desconectar' }).click();
  await expect(page.getByRole('status')).toHaveText('Celular desconectado.');
  await expect(
    page.getByRole('heading', { name: 'Conecte pelo computador' }),
  ).toBeVisible();
  await expect(pagesHeading(page)).toHaveCount(0);
  expect(state.disconnected).toEqual([pairingId]);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Conecte pelo computador' }),
  ).toBeVisible();
});
