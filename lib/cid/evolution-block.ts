// Bloco de diagnósticos escrito no fim da evolução, para que entre no texto assinado.
export const DIAGNOSIS_HEADER = 'Diagnósticos (CID):';

type Item = {
  description: string;
  cid_code: string | null;
  icd11_code: string | null;
  status: 'hypothesis' | 'confirmed' | 'resolved';
};
const statusText = {
  hypothesis: 'hipótese diagnóstica',
  confirmed: 'confirmado',
  resolved: 'resolvido',
};

export function diagnosisBlock(items: Item[]) {
  if (!items.length) return '';
  const lines = items.map((x) => {
    const codes = [x.cid_code && `CID-10 ${x.cid_code}`, x.icd11_code && `CID-11 ${x.icd11_code}`]
      .filter(Boolean)
      .join(' · ');
    return `- ${x.description}${codes ? ` (${codes})` : ''} — ${statusText[x.status]}`;
  });
  return [DIAGNOSIS_HEADER, ...lines].join('\n');
}

/**
 * Substitui o bloco existente (cabeçalho + linhas "- " seguintes) ou o acrescenta ao fim.
 * Texto escrito depois do bloco é preservado. Bloco vazio remove o existente.
 */
export function upsertDiagnosisBlock(text: string, block: string) {
  const lines = text.split('\n');
  const start = lines.lastIndexOf(DIAGNOSIS_HEADER);
  if (start < 0) {
    if (!block) return text;
    return text.trim() ? `${text.replace(/\s+$/, '')}\n\n${block}` : block;
  }
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith('- ')) end++;
  const before = lines.slice(0, start).join('\n').replace(/\s+$/, '');
  const after = lines.slice(end).join('\n').replace(/^\s+/, '');
  return [before, block, after].filter(Boolean).join('\n\n');
}
