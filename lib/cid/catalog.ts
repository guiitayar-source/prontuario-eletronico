// Catálogos de diagnóstico, separados por versão. Gerados por scripts/update-cid.mjs
// a partir das fontes oficiais (DATASUS e OMS); não edite os JSON à mão.
import cid10Data from './data/cid10.json';
import icd11Data from './data/icd11-2025-01.json';
import mapData from './data/map10to11-2025-01.json';

export const ICD11_RELEASE = icd11Data.release;

export type CidEntry = { code: string; title: string };
export type Icd11Suggestion = CidEntry & {
  kind: 'official' | 'compatible' | 'related';
};

type Indexed = CidEntry & { key: string; norm: string; parent?: string | null };

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const codeKey = (s: string) => s.replace(/[.\s]/g, '').toUpperCase();

const cid10: Indexed[] = (cid10Data.codes as [string, string][]).map(
  ([code, title]) => ({ code, title, key: codeKey(code), norm: normalize(title) }),
);
const icd11: Indexed[] = (icd11Data.codes as [string, string, string | null][]).map(
  ([code, title, parent]) => ({
    code,
    title,
    parent,
    key: codeKey(code),
    norm: normalize(title),
  }),
);
const cid10ByCode = new Map(cid10.map((x) => [x.code, x]));
const icd11ByCode = new Map(icd11.map((x) => [x.code, x]));
const icd11Children = new Map<string, Indexed[]>();
for (const x of icd11)
  if (x.parent)
    icd11Children.set(x.parent, [...(icd11Children.get(x.parent) || []), x]);
const forward = mapData.forward as Record<string, string[]>;
const reverse = mapData.reverse as Record<string, string[]>;

const plain = ({ code, title }: Indexed): CidEntry => ({ code, title });

function search(list: Indexed[], query: string, limit: number): CidEntry[] {
  const q = query.trim();
  if (!q) return [];
  // Código: "F32", "f321", "F32.1", "6A70"
  if (/^[a-z0-9]{1,2}\d/i.test(q) && !/\s/.test(q)) {
    const key = codeKey(q);
    const hits = list.filter((x) => x.key.startsWith(key));
    if (hits.length) return hits.slice(0, limit).map(plain);
  }
  const words = normalize(q).split(/\s+/).filter(Boolean);
  const scored: [number, Indexed][] = [];
  for (const x of list) {
    if (!words.every((w) => x.norm.includes(w))) continue;
    const first = words[0]!;
    const score = x.norm.startsWith(first)
      ? 0
      : new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(x.norm)
        ? 1
        : 2;
    scored.push([score * 10 + (x.key.length > 3 ? 1 : 0), x]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].key.localeCompare(b[1].key))
    .slice(0, limit)
    .map(([, x]) => plain(x));
}

// Siglas e termos usuais que não aparecem nos títulos oficiais do DATASUS.
const cid10Aliases: Record<string, string[]> = {
  tdah: ['F90.0', 'F90'],
  hiperatividade: ['F90.0', 'F90'],
  tag: ['F41.1'],
  toc: ['F42', 'F42.2'],
  tept: ['F43.1'],
  tab: ['F31'],
  bipolaridade: ['F31'],
  tea: ['F84', 'F84.0', 'F84.5'],
  borderline: ['F60.3'],
  depressao: ['F32', 'F33'],
  panico: ['F41.0'],
};
export function searchCid10(q: string, limit = 15) {
  const alias = (cid10Aliases[normalize(q.trim())] || [])
    .map((c) => cid10ByCode.get(c))
    .filter((x): x is Indexed => !!x)
    .map(plain);
  const rest = search(cid10, q, limit).filter(
    (x) => !alias.some((a) => a.code === x.code),
  );
  return [...alias, ...rest].slice(0, limit);
}
export const searchIcd11 = (q: string, limit = 15) => search(icd11, q, limit);
export const cid10Entry = (code: string) => {
  const x = cid10ByCode.get(code.trim().toUpperCase());
  return x ? plain(x) : null;
};
export const icd11Entry = (code: string) => {
  const x = icd11ByCode.get(code.trim().toUpperCase());
  return x ? plain(x) : null;
};

/**
 * Sugestões CID-11 para um código CID-10:
 * - official: correspondência da tabela 10→11 da OMS;
 * - compatible: códigos CID-11 que a tabela 11→10 da OMS remete ao mesmo CID-10;
 * - related: outros códigos do mesmo grupo CID-11 (ex.: demais gravidades).
 */
export function suggestIcd11(code10: string, limit = 12): Icd11Suggestion[] {
  const code = code10.trim().toUpperCase();
  const category = code.slice(0, 3);
  const seen = new Set<string>();
  const out: Icd11Suggestion[] = [];
  const push = (c: string, kind: Icd11Suggestion['kind']) => {
    const x = icd11ByCode.get(c);
    if (!x || seen.has(c) || out.length >= limit) return;
    seen.add(c);
    out.push({ ...plain(x), kind });
  };
  const official = forward[code] || forward[category] || [];
  official.forEach((c) => push(c, 'official'));
  (reverse[code] || (code === category ? [] : reverse[category]) || []).forEach(
    (c) => push(c, 'compatible'),
  );
  for (const c of official) {
    const parent = icd11ByCode.get(c)?.parent;
    for (const sibling of (parent && icd11Children.get(parent)) || [])
      push(sibling.code, 'related');
  }
  return out;
}
