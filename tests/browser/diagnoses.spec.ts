// Diagnósticos do atendimento (abaixo da evolução): busca no CID-10, sugestões da CID-11, texto
// livre, diagnósticos anteriores do paciente e o bloco escrito no fim da evolução.
// A API é sintética, mas os códigos e títulos vêm dos catálogos oficiais em lib/cid/data/
// (gerados por scripts/update-cid.mjs a partir do DATASUS e da OMS): nenhum código é escrito à mão.
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { mockApi, patient } from './fixtures';

const read = <T>(name: string) =>
  JSON.parse(readFileSync(`lib/cid/data/${name}`, 'utf8')) as T;
const cid10 = read<{ codes: [string, string][] }>('cid10.json');
const icd11 = read<{ release: string; codes: [string, string, string | null][] }>(
  'icd11-2025-01.json',
);
const map = read<{
  forward: Record<string, string[]>;
  reverse: Record<string, string[]>;
}>('map10to11-2025-01.json');

type Entry = { code: string; title: string };
type Kind = 'official' | 'compatible' | 'related';
type Suggestion = Entry & { kind: Kind };

const normalize = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const codeKey = (s: string) => s.replace(/[.\s]/g, '').toUpperCase();
const icd11ByCode = new Map(icd11.codes.map((x) => [x[0], x]));
const icd11Children = new Map<string, string[]>();
for (const [code, , parent] of icd11.codes)
  if (parent)
    icd11Children.set(parent, [...(icd11Children.get(parent) || []), code]);

/** Busca simples nos catálogos oficiais: por começo do código ou por palavras do título. */
function search(system: string, query: string): Entry[] {
  const list: Entry[] = (system === 'icd11' ? icd11.codes : cid10.codes).map(
    ([code, title]) => ({ code, title }),
  );
  const q = query.trim();
  if (/^[a-z0-9]{1,2}\d/i.test(q) && !/\s/.test(q)) {
    const hits = list.filter((x) => codeKey(x.code).startsWith(codeKey(q)));
    if (hits.length) return hits.slice(0, 6);
  }
  const words = normalize(q).split(/\s+/).filter(Boolean);
  return list
    .filter((x) => words.every((w) => normalize(x.title).includes(w)))
    .slice(0, 6);
}
/** Sugestões CID-11 para um CID-10, pelas tabelas de correspondência da OMS (como o servidor faz). */
function suggest(code10: string): Suggestion[] {
  const code = code10.toUpperCase();
  const category = code.slice(0, 3);
  const out: Suggestion[] = [];
  const push = (c: string, kind: Kind) => {
    const x = icd11ByCode.get(c);
    if (!x || out.some((y) => y.code === c) || out.length >= 12) return;
    out.push({ code: x[0], title: x[1], kind });
  };
  const official = map.forward[code] || map.forward[category] || [];
  official.forEach((c) => push(c, 'official'));
  (map.reverse[code] || (code === category ? [] : map.reverse[category]) || []).forEach(
    (c) => push(c, 'compatible'),
  );
  for (const c of official)
    for (const sibling of icd11Children.get(icd11ByCode.get(c)?.[2] || '') || [])
      push(sibling, 'related');
  return out;
}
const cid10Entry = (code: string): Entry => {
  const found = cid10.codes.find(([c]) => c === code);
  if (!found) throw new Error(`Código ausente do catálogo: ${code}`);
  return { code: found[0], title: found[1] };
};
// Códigos escolhidos no próprio catálogo, pela forma das sugestões, e não digitados aqui.
const fChapter = cid10.codes.filter(([code]) => code.startsWith('F') && code.length > 3);
/** CID-10 com sugestões CID-11 dos três tipos. */
const rich = cid10Entry(
  fChapter.find(([code]) => {
    const kinds = new Set(suggest(code).map((x) => x.kind));
    return kinds.size === 3;
  })![0],
);
/** CID-10 sem nenhuma correspondência publicada na CID-11. */
const bare = cid10Entry(
  cid10.codes.find(([code]) => code.length > 3 && !suggest(code).length)![0],
);
const otherF = fChapter.filter(([code]) => code !== rich.code);
const second = cid10Entry(otherF[0][0]);
const third = cid10Entry(otherF[1][0]);

type Condition = {
  id: string;
  description: string;
  cid_code: string | null;
  status: 'hypothesis' | 'confirmed' | 'resolved';
  notes: string | null;
  icd11_code: string | null;
  icd11_title: string | null;
  icd11_release: string | null;
  version: number;
};
type Link = Omit<Condition, 'notes' | 'version'> & {
  consultation_id: string;
  condition_id: string;
};
const id = (n: number) => `abababab-0000-4000-8000-${String(n).padStart(12, '0')}`;
const condition = (
  n: number,
  entry: Entry | null,
  extra: Partial<Condition> = {},
): Condition => ({
  id: id(n),
  description: entry?.title || `Diagnóstico sintético ${n}`,
  cid_code: entry?.code || null,
  status: 'hypothesis',
  notes: null,
  icd11_code: null,
  icd11_title: null,
  icd11_release: null,
  version: 1,
  ...extra,
});

/** Responde ao contexto clínico e ao catálogo CID como o servidor faria e guarda o que a tela enviou. */
async function mockDiagnoses(page: Page) {
  const api = await mockApi(page);
  const consultationId = api.consultation.id;
  const state = {
    api,
    conditions: [] as Condition[],
    links: [] as Link[],
    posts: [] as Record<string, unknown>[],
    failure: null as { status: number; json: Record<string, unknown> } | null,
    // Quando preenchido, a resposta só sai depois que o teste liberar.
    gate: null as Promise<void> | null,
    suggestGate: null as Promise<void> | null,
  };
  // Copia o diagnóstico para o atendimento, como a função do banco faz.
  const snapshot = (c: Condition, consultation = consultationId) => {
    const link: Link = {
      id: `link-${consultation}-${c.id}`,
      consultation_id: consultation,
      condition_id: c.id,
      description: c.description,
      cid_code: c.cid_code,
      status: c.status,
      icd11_code: c.icd11_code,
      icd11_title: c.icd11_title,
      icd11_release: c.icd11_release,
    };
    const at = state.links.findIndex((x) => x.id === link.id);
    if (at < 0) state.links.push(link);
    else state.links[at] = link;
  };
  await page.route(/\/api\/clinical-context\?/, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      state.posts.push(body);
      if (state.gate) await state.gate;
      if (state.failure) return route.fulfill(state.failure);
      if (body.entity === 'consultation_diagnosis') {
        const c = state.conditions.find((x) => x.id === body.condition_id)!;
        if (body.linked) snapshot(c, body.consultation_id);
        else
          state.links = state.links.filter(
            (x) =>
              !(x.consultation_id === body.consultation_id && x.condition_id === c.id),
          );
      } else if (body.entity === 'condition') {
        const saved: Condition = {
          id: body.id,
          description: body.description,
          cid_code: body.cid_code || null,
          status: body.status,
          notes: body.notes || null,
          icd11_code: body.icd11_code || null,
          icd11_title: body.icd11_code ? body.icd11_title || null : null,
          icd11_release: body.icd11_code ? body.icd11_release || null : null,
          version: (body.version || 0) + 1,
        };
        const at = state.conditions.findIndex((x) => x.id === saved.id);
        if (at < 0) state.conditions.push(saved);
        else state.conditions[at] = saved;
        // Atualiza a cópia nas consultas abertas que já citam o diagnóstico.
        for (const link of state.links.filter((x) => x.condition_id === saved.id))
          if (link.consultation_id === consultationId && !api.consultation.finalized_at)
            snapshot(saved, link.consultation_id);
        if (body.consultation_id) snapshot(saved, body.consultation_id);
      }
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      json: {
        conditions: state.conditions,
        medications: [],
        allergies: [],
        allergyState: { state: 'unknown', version: 0 },
        medicationState: api.medicationState,
        consultationDiagnoses: state.links,
      },
    });
  });
  await page.route(/\/api\/cid\?/, async (route) => {
    const url = new URL(route.request().url());
    const code = url.searchParams.get('suggest');
    if (code) {
      if (state.suggestGate) await state.suggestGate;
      return route.fulfill({
        json: { release: icd11.release, suggestions: suggest(code) },
      });
    }
    const system = url.searchParams.get('system') || 'cid10';
    return route.fulfill({
      json: {
        release: system === 'icd11' ? icd11.release : '2008',
        results: search(system, url.searchParams.get('q') || ''),
      },
    });
  });
  return state;
}

/** Segura uma resposta até a função devolvida ser chamada. */
function hold<K extends 'gate' | 'suggestGate'>(
  state: Record<K, Promise<void> | null>,
  key: K,
) {
  let release = () => {};
  state[key] = new Promise<void>((resolve) => (release = resolve));
  return () => {
    state[key] = null;
    release();
  };
}

const initialText = 'Texto inicial sintético';
async function openRecord(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Paciente Sintético/ }).click();
  await expect(page.getByLabel('Evolução em texto livre')).toBeVisible();
}
const section = (page: Page) => page.locator('.consultation-diagnoses');
const cidSearch = (page: Page) =>
  section(page).getByRole('combobox', { name: 'Buscar diagnóstico CID-10' });
const options = (page: Page) => section(page).getByRole('option');
const list = (page: Page) => section(page).locator('.diagnoses-list > li');
const row = (page: Page, description: string) =>
  list(page).filter({ has: page.locator('.diagnosis-main', { hasText: description }) });
/** Busca um código no CID-10 e escolhe o resultado (espera a resposta do catálogo chegar). */
async function pickCid(page: Page, entry: Entry) {
  await cidSearch(page).fill(entry.code);
  await expect(options(page).first()).toHaveText(`${entry.code}${entry.title}`);
  await options(page).first().click();
}
const addButton = (page: Page) =>
  section(page).getByRole('button', { name: /^Adicionar ao atendimento/ });
const evolution = (page: Page) => page.getByLabel('Evolução em texto livre');
const statusText = {
  hypothesis: 'hipótese diagnóstica',
  confirmed: 'confirmado',
  resolved: 'resolvido',
};
/** Linha do bloco de diagnósticos da evolução, no formato que entra no texto assinado. */
const line = (
  description: string,
  status: keyof typeof statusText,
  cid?: string | null,
  icd?: string | null,
) => {
  const codes = [cid && `CID-10 ${cid}`, icd && `CID-11 ${icd}`].filter(Boolean).join(' · ');
  return `- ${description}${codes ? ` (${codes})` : ''} — ${statusText[status]}`;
};
const withBlock = (...lines: string[]) =>
  lines.length
    ? `${initialText}\n\nDiagnósticos (CID):\n${lines.join('\n')}`
    : initialText;

test('busca no CID-10, escolhe pelo teclado e adiciona com CID-11', async ({
  page,
}) => {
  const state = await mockDiagnoses(page);
  await openRecord(page);
  await expect(section(page).getByRole('heading')).toHaveText(
    'Diagnósticos do atendimento',
  );
  await expect(section(page).locator('.diagnoses-header small')).toHaveText(
    'Escritos no fim da evolução e assinados junto com ela',
  );
  await expect(section(page).locator('p.muted')).toHaveText(
    'Nenhum diagnóstico registrado neste atendimento ainda.',
  );
  await expect(section(page).locator('.diagnoses-previous')).toHaveCount(0);

  // Busca pelo código: aparecem os códigos do catálogo e a opção de texto livre por último.
  const found = search('cid10', rich.code);
  await cidSearch(page).fill(rich.code);
  await expect(options(page)).toHaveText([
    ...found.map((x) => `${x.code}${x.title}`),
    `Adicionar “${rich.code}” sem código`,
  ]);
  await expect(cidSearch(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
  await cidSearch(page).press('ArrowDown');
  await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'false');
  await cidSearch(page).press('ArrowUp');
  await cidSearch(page).press('ArrowUp');
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
  // Passar o mouse também muda o item ativo.
  await options(page).last().hover();
  await expect(options(page).last()).toHaveAttribute('aria-selected', 'true');
  await options(page).first().hover();
  const release = hold(state, 'suggestGate');
  await cidSearch(page).press('Enter');

  // Rascunho: descrição e situação editáveis, e as correspondências da CID-11.
  const draft = section(page).locator('.diagnosis-draft');
  await expect(draft.getByLabel('Descrição')).toHaveValue(rich.title);
  await expect(draft.getByLabel('Situação')).toHaveValue('hypothesis');
  await expect(draft.locator('.icd11-heading')).toHaveText(
    `CID-11Correspondências para ${rich.code}`,
  );
  await expect(draft).toContainText('Buscando correspondências…');
  release();
  await expect(draft.locator('.icd11-heading')).toHaveText(
    `CID-11Correspondências para ${rich.code} · OMS ${icd11.release}`,
  );
  const suggestions = suggest(rich.code);
  const labels = {
    official: 'Correspondência oficial',
    compatible: 'Também corresponde',
    related: 'Mesmo grupo',
  };
  await expect(draft.locator('.icd11-group small')).toHaveText(Object.values(labels));
  for (const kind of ['official', 'compatible', 'related'] as const)
    await expect(
      draft.locator('.icd11-group').filter({ hasText: labels[kind] }).getByRole('button'),
    ).toHaveText(
      suggestions.filter((x) => x.kind === kind).map((x) => `${x.code} ${x.title}`),
    );
  await expect(addButton(page)).toHaveText(`Adicionar ao atendimento · ${rich.code}`);

  // Escolher um código da CID-11; clicar de novo desfaz a escolha.
  const official = suggestions.find((x) => x.kind === 'official')!;
  const chip = draft.getByRole('button', {
    name: `${official.code} ${official.title}`,
    exact: true,
  });
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(addButton(page)).toHaveText(
    `Adicionar ao atendimento · ${rich.code} + ${official.code}`,
  );
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect(addButton(page)).toHaveText(`Adicionar ao atendimento · ${rich.code}`);
  await chip.click();

  await draft.getByLabel('Situação').selectOption('confirmed');
  await addButton(page).click();

  await expect(draft).toHaveCount(0);
  expect(state.posts).toEqual([
    {
      entity: 'condition',
      id: expect.stringMatching(/^[a-f0-9-]{36}$/),
      patient_id: patient.id,
      description: rich.title,
      cid_code: rich.code,
      status: 'confirmed',
      notes: '',
      icd11_code: official.code,
      icd11_title: official.title,
      icd11_release: icd11.release,
      version: 0,
      consultation_id: state.api.consultation.id,
    },
  ]);
  const item = row(page, rich.title);
  await expect(item.locator('.diagnosis-main strong')).toHaveText(
    `${rich.code}${rich.title}`,
  );
  await expect(item.locator('.icd11-tag')).toHaveText(`CID-11 ${official.code}`);
  await expect(item.locator('.icd11-tag')).toHaveAttribute('title', official.title);
  await expect(item.getByLabel('Situação do diagnóstico')).toHaveValue('confirmed');
  await expect(item.getByRole('button', { name: 'Alterar CID-11' })).toBeVisible();
  await expect(section(page).locator('p.muted')).toHaveCount(0);
  // A busca volta vazia para o próximo diagnóstico.
  await expect(cidSearch(page)).toHaveValue('');

  // O bloco entra no fim da evolução.
  await expect(evolution(page)).toHaveValue(
    withBlock(line(rich.title, 'confirmed', rich.code, official.code)),
  );
});

test('texto livre sem código; Escape e clique fora fecham a lista', async ({
  page,
}) => {
  const state = await mockDiagnoses(page);
  await openRecord(page);
  const free = 'Queixa sintética sem correspondência qwz';
  await cidSearch(page).fill(free);
  await expect(options(page)).toHaveText([`Adicionar “${free}” sem código`]);
  await expect(section(page)).not.toContainText('Nenhum código encontrado.');

  await cidSearch(page).press('Escape');
  await expect(section(page).getByRole('listbox')).toHaveCount(0);
  await expect(cidSearch(page)).toHaveAttribute('aria-expanded', 'false');
  await cidSearch(page).press('ArrowDown');
  await expect(section(page).getByRole('listbox')).toBeVisible();
  await page.locator('.diagnoses-header').click();
  await expect(section(page).getByRole('listbox')).toHaveCount(0);
  await cidSearch(page).focus();
  await expect(section(page).getByRole('listbox')).toBeVisible();

  // Enter escolhe o item ativo: duas setas para baixo levam ao terceiro resultado.
  const word = second.title.split(' ')[0];
  const results = search('cid10', word);
  await cidSearch(page).fill(word);
  await expect(options(page).first()).toHaveText(`${results[0].code}${results[0].title}`);
  await cidSearch(page).press('ArrowDown');
  await cidSearch(page).press('ArrowDown');
  await cidSearch(page).press('Enter');
  const draft = section(page).locator('.diagnosis-draft');
  await expect(draft.getByLabel('Descrição')).toHaveValue(results[2].title);
  await draft.getByRole('button', { name: 'Cancelar' }).click();

  await cidSearch(page).fill(free);
  await expect(options(page)).toHaveText([`Adicionar “${free}” sem código`]);
  await cidSearch(page).press('Enter');
  await expect(draft.getByLabel('Descrição')).toHaveValue(free);
  await expect(draft.locator('.icd11-suggestions')).toHaveCount(0);
  await expect(addButton(page)).toHaveText('Adicionar ao atendimento');

  // Sem descrição não dá para adicionar; Cancelar volta para a busca.
  await draft.getByLabel('Descrição').fill('   ');
  await expect(addButton(page)).toBeDisabled();
  await draft.getByRole('button', { name: 'Cancelar' }).click();
  await expect(draft).toHaveCount(0);
  await expect(cidSearch(page)).toHaveValue('');

  await cidSearch(page).fill(free);
  await options(page).first().click();
  await draft.getByLabel('Descrição').fill(`  ${free} editada  `);
  await addButton(page).click();
  await expect(row(page, `${free} editada`)).toBeVisible();
  expect(state.posts[0]).toMatchObject({
    entity: 'condition',
    description: `${free} editada`,
    cid_code: '',
    status: 'hypothesis',
    icd11_code: '',
    icd11_title: '',
    icd11_release: '',
  });
  await expect(row(page, `${free} editada`).locator('code')).toHaveCount(0);
  // Sem código não há CID-11 para ver.
  await expect(
    row(page, `${free} editada`).getByRole('button', { name: /^(Ver|Alterar) CID-11$/ }),
  ).toHaveCount(0);
  await expect(evolution(page)).toHaveValue(
    withBlock(line(`${free} editada`, 'hypothesis')),
  );
});

test('diagnósticos do paciente: incluir, mudar situação, escolher CID-11 e remover', async ({
  page,
}) => {
  const state = await mockDiagnoses(page);
  const linked = condition(1, second, { status: 'confirmed' });
  const earlier = condition(2, third);
  const resolved = condition(3, null, { status: 'resolved' });
  state.conditions = [linked, earlier, resolved];
  // Diagnóstico já citado neste atendimento.
  state.links = [
    {
      id: 'link-inicial',
      consultation_id: state.api.consultation.id,
      condition_id: linked.id,
      description: linked.description,
      cid_code: linked.cid_code,
      status: linked.status,
      icd11_code: null,
      icd11_title: null,
      icd11_release: null,
    },
  ];
  await openRecord(page);
  await expect(list(page)).toHaveCount(1);

  // Só aparece como sugestão o que não está no atendimento e não foi resolvido.
  const chips = section(page).locator('.diagnoses-previous button');
  await expect(section(page).locator('.diagnoses-previous small')).toHaveText(
    'Diagnósticos do paciente:',
  );
  await expect(chips).toHaveText([`${third.code}${third.title}`]);
  await chips.first().click();
  await expect(list(page)).toHaveCount(2);
  await expect(section(page).locator('.diagnoses-previous')).toHaveCount(0);
  expect(state.posts.at(-1)).toEqual({
    entity: 'consultation_diagnosis',
    patient_id: patient.id,
    consultation_id: state.api.consultation.id,
    condition_id: earlier.id,
    linked: true,
  });
  await expect(evolution(page)).toHaveValue(
    withBlock(
      line(second.title, 'confirmed', second.code),
      line(third.title, 'hypothesis', third.code),
    ),
  );

  // Mudar a situação salva o diagnóstico e reescreve o bloco.
  await row(page, third.title).getByLabel('Situação do diagnóstico').selectOption('confirmed');
  await expect(evolution(page)).toHaveValue(
    withBlock(
      line(second.title, 'confirmed', second.code),
      line(third.title, 'confirmed', third.code),
    ),
  );
  expect(state.posts.at(-1)).toMatchObject({
    entity: 'condition',
    id: earlier.id,
    status: 'confirmed',
    patient_id: patient.id,
    consultation_id: state.api.consultation.id,
    version: 1,
  });

  // CID-11 de um diagnóstico já incluído.
  const target = row(page, third.title);
  const toggle = target.getByRole('button', { name: 'Ver CID-11' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const options11 = suggest(third.code);
  expect(options11.length).toBeGreaterThan(0);
  const box = target.locator('.icd11-suggestions');
  await box
    .getByRole('button', { name: `${options11[0].code} ${options11[0].title}`, exact: true })
    .click();
  await expect(target.locator('.icd11-tag')).toHaveText(`CID-11 ${options11[0].code}`);
  await expect(target.getByRole('button', { name: 'Alterar CID-11' })).toBeVisible();
  expect(state.posts.at(-1)).toMatchObject({
    id: earlier.id,
    icd11_code: options11[0].code,
    icd11_title: options11[0].title,
    icd11_release: icd11.release,
  });
  await expect(evolution(page)).toHaveValue(
    withBlock(
      line(second.title, 'confirmed', second.code),
      line(third.title, 'confirmed', third.code, options11[0].code),
    ),
  );
  await target.getByRole('button', { name: /^(Ver|Alterar) CID-11$/ }).click();
  await expect(box).toHaveCount(0);

  // Remover tira só deste atendimento: volta como diagnóstico do paciente.
  await row(page, second.title)
    .getByRole('button', { name: `Remover ${second.title} deste atendimento` })
    .click();
  await expect(list(page)).toHaveCount(1);
  await expect(chips).toHaveText([`${second.code}${second.title}`]);
  expect(state.posts.at(-1)).toEqual({
    entity: 'consultation_diagnosis',
    patient_id: patient.id,
    consultation_id: state.api.consultation.id,
    condition_id: linked.id,
    linked: false,
  });
  await row(page, third.title)
    .getByRole('button', { name: `Remover ${third.title} deste atendimento` })
    .click();
  await expect(list(page)).toHaveCount(0);
  // Sem diagnósticos, o bloco sai da evolução.
  await expect(evolution(page)).toHaveValue(initialText);
});

test('sem correspondência na CID-11, busca outro código no catálogo da OMS', async ({
  page,
}) => {
  const state = await mockDiagnoses(page);
  await openRecord(page);
  await pickCid(page, bare);
  const draft = section(page).locator('.diagnosis-draft');
  await expect(draft.getByLabel('Descrição')).toHaveValue(bare.title);
  await expect(draft).toContainText('A OMS não publica correspondência para este código.');

  await draft.getByRole('button', { name: 'Buscar outro código na CID-11' }).click();
  const icdSearch = draft.getByRole('combobox', { name: 'Buscar na CID-11' });
  await expect(icdSearch).toBeFocused();
  await expect(icdSearch).toHaveAttribute('placeholder', 'Buscar outro código na CID-11');
  // A busca da CID-11 não oferece texto livre.
  await icdSearch.fill('qwzqwz');
  await expect(draft.getByRole('listbox')).toHaveText('Nenhum código encontrado.');
  const chosen = search('icd11', 'depress')[0];
  await icdSearch.fill('depress');
  const icdOptions = draft.getByRole('listbox').getByRole('option');
  await expect(icdOptions.first()).toHaveText(`${chosen.code}${chosen.title}`);
  await icdOptions.first().click();
  await expect(icdSearch).toHaveCount(0);
  await expect(
    draft.getByRole('button', { name: 'Buscar outro código na CID-11' }),
  ).toBeVisible();
  await expect(addButton(page)).toHaveText(
    `Adicionar ao atendimento · ${bare.code} + ${chosen.code}`,
  );
  await addButton(page).click();
  await expect(row(page, bare.title).locator('.icd11-tag')).toHaveText(
    `CID-11 ${chosen.code}`,
  );
  expect(state.posts.at(-1)).toMatchObject({
    cid_code: bare.code,
    icd11_code: chosen.code,
    icd11_title: chosen.title,
    icd11_release: icd11.release,
  });
});

test('erro ao salvar aparece na seção e o rascunho continua', async ({
  page,
}) => {
  const state = await mockDiagnoses(page);
  await openRecord(page);
  await pickCid(page, second);
  const draft = section(page).locator('.diagnosis-draft');

  // Enquanto salva, nada mais pode ser enviado.
  state.failure = { status: 409, json: { error: 'Falha sintética ao salvar.' } };
  const release = hold(state, 'gate');
  await addButton(page).click();
  await expect(addButton(page)).toBeDisabled();
  release();
  await expect(section(page).getByRole('alert')).toHaveText('Falha sintética ao salvar.');
  await expect(draft.getByLabel('Descrição')).toHaveValue(second.title);
  await expect(addButton(page)).toBeEnabled();
  await expect(evolution(page)).toHaveValue(initialText);

  // Sem texto na resposta de erro: mensagem padrão.
  state.failure = { status: 500, json: {} };
  await addButton(page).click();
  await expect(section(page).getByRole('alert')).toHaveText(
    'Não foi possível salvar o contexto clínico.',
  );

  state.failure = null;
  await addButton(page).click();
  await expect(section(page).getByRole('alert')).toHaveCount(0);
  await expect(draft).toHaveCount(0);
  await expect(evolution(page)).toHaveValue(
    withBlock(line(second.title, 'hypothesis', second.code)),
  );
});

test('consulta finalizada mostra os diagnósticos como foram registrados, sem edição', async ({
  page,
}) => {
  const state = await mockDiagnoses(page);
  const current = condition(1, second, { status: 'resolved', icd11_code: null });
  state.conditions = [current, condition(2, third)];
  state.api.consultation.finalized_at = '2026-11-01T13:00:00Z';
  // Cópia feita quando a consulta foi aberta: vale o que foi registrado naquele dia.
  const snapshotIcd = suggest(rich.code)[0];
  state.links = [
    {
      id: 'link-finalizado',
      consultation_id: state.api.consultation.id,
      condition_id: current.id,
      description: 'Descrição registrada na consulta',
      cid_code: second.code,
      status: 'confirmed',
      icd11_code: snapshotIcd.code,
      icd11_title: snapshotIcd.title,
      icd11_release: icd11.release,
    },
  ];
  // Abre direto a consulta finalizada (o mesmo caminho da volta da assinatura).
  await page.addInitScript(
    (value) => sessionStorage.setItem('birdid_return_evolution_id', value),
    state.api.consultation.id,
  );
  await openRecord(page);
  const item = list(page).first();
  await expect(item.locator('.diagnosis-main strong')).toHaveText(
    `${second.code}Descrição registrada na consulta`,
  );
  await expect(item.locator('.icd11-tag')).toHaveText(`CID-11 ${snapshotIcd.code}`);
  await expect(item.locator('.context-item-badge')).toHaveText('Confirmado');
  await expect(section(page).getByRole('combobox')).toHaveCount(0);
  await expect(section(page).getByRole('button')).toHaveCount(0);
  await expect(section(page).locator('select')).toHaveCount(0);
  await expect(section(page).locator('.diagnoses-header small')).toHaveCount(0);
  await expect(section(page).locator('.diagnoses-previous')).toHaveCount(0);

  // Sem diagnósticos registrados, o texto muda para o passado.
  state.links = [];
  await page.reload();
  await page.getByRole('button', { name: /Paciente Sintético/ }).click();
  await expect(section(page).locator('p.muted')).toHaveText(
    'Nenhum diagnóstico registrado neste atendimento.',
  );
});
