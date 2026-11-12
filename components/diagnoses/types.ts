// Tipos dos códigos de diagnóstico usados pelas telas de diagnóstico.
export type CidEntry = { code: string; title: string };
export type Icd11Suggestion = CidEntry & {
  kind: 'official' | 'compatible' | 'related';
};
export type Icd11Choice = CidEntry & { release: string };
