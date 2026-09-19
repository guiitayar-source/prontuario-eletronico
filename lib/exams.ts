export type ExamField = {
  id: string;
  name: string;
  type: 'number' | 'text' | 'choice';
  unit: string;
  group?: string;
  options?: string[];
};
export type ExamDefinition = {
  id: string;
  name: string;
  aliases: string[];
  fields: ExamField[];
  clinic_id?: string | null;
};
export type ExamValue = { value: string; unit: string; reference: string };
export type ExamResult = {
  id: string;
  definition_id: string;
  collected_on: string;
  laboratory: string;
  method: string;
  specimen: string;
  values: Record<string, ExamValue>;
  notes: string;
  attachment_id: string | null;
  supersedes_id: string | null;
  correction_reason: string;
  created_at: string;
  author_id: string;
  source: 'manual' | 'ai_reviewed';
  provenance: Record<string, unknown>;
};
export const normalizeExamSearch = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
export function searchExams(definitions: ExamDefinition[], query: string) {
  const words = normalizeExamSearch(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return definitions
    .filter((d) =>
      words.every((w) =>
        normalizeExamSearch([d.name, ...d.aliases].join(' ')).includes(w),
      ),
    )
    .slice(0, 20);
}
// Deliberately reject thousands separators: ambiguous laboratory values need review.
export function numericExamValue(raw: string): number | null {
  const value = raw.trim();
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(value)) return null;
  const number = Number(value.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}
export function validNumericExamValue(raw: string) {
  return numericExamValue(raw.replace(/^(?:<=|>=|<|>|≤|≥)\s*/, '')) !== null;
}
export function activeExamResults(results: ExamResult[]) {
  const replaced = new Set(results.map((r) => r.supersedes_id).filter(Boolean));
  return results.filter((r) => !replaced.has(r.id));
}
export function examSeries(results: ExamResult[], field: string) {
  const groups = new Map<
    string,
    {
      date: string;
      value: number;
      id: string;
      unit: string;
      laboratory?: string;
      method?: string;
      specimen?: string;
      reference?: string;
    }[]
  >();
  for (const r of activeExamResults(results)) {
    const v = r.values[field];
    if (!v) continue;
    const number = numericExamValue(v.value);
    if (number === null) continue;
    const unit = (v.unit || '').trim();
    const key = unit.toLowerCase();
    const group = groups.get(key) || [];
    group.push({
      date: r.collected_on,
      value: number,
      id: r.id,
      unit,
      laboratory: r.laboratory,
      method: r.method,
      specimen: r.specimen,
      reference: v.reference,
    });
    groups.set(key, group);
  }
  return [...groups].map(([key, points]) => {
    const unit = points.find((p) => p.unit)?.unit || '';
    return {
      key,
      unit,
      label: unit ? `Unidade: ${unit}` : 'Unidade não informada',
      points: points.sort((a, b) => a.date.localeCompare(b.date)),
    };
  });
}
export function validateDefinition(d: ExamDefinition) {
  if (
    typeof d.name !== 'string' ||
    !d.name.trim() ||
    d.name.length > 160 ||
    !Array.isArray(d.aliases) ||
    d.aliases.length > 30 ||
    d.aliases.some((a) => typeof a !== 'string' || a.length > 100)
  )
    throw new Error('Confira o nome e os sinônimos.');
  if (!Array.isArray(d.fields) || !d.fields.length || d.fields.length > 50)
    throw new Error('Defina de 1 a 50 parâmetros.');
  const ids = new Set();
  for (const f of d.fields) {
    if (
      !f ||
      typeof f.id !== 'string' ||
      !/^[a-z0-9_-]{1,64}$/.test(f.id) ||
      ids.has(f.id) ||
      typeof f.name !== 'string' ||
      !f.name.trim() ||
      f.name.length > 120 ||
      !['number', 'text', 'choice'].includes(f.type) ||
      typeof f.unit !== 'string' ||
      f.unit.length > 40
    )
      throw new Error('Confira os parâmetros do exame.');
    if (
      f.type === 'choice' &&
      (!Array.isArray(f.options) ||
        !f.options.length ||
        f.options.length > 30 ||
        f.options.some(
          (o) => typeof o !== 'string' || !o.trim() || o.length > 100,
        ))
    )
      throw new Error('Informe as opções do parâmetro.');
    ids.add(f.id);
  }
}
export function validateResult(d: ExamResult, definition: ExamDefinition) {
  if (
    typeof d.collected_on !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.collected_on) ||
    !Number.isFinite(Date.parse(d.collected_on)) ||
    new Date(d.collected_on).toISOString().slice(0, 10) !== d.collected_on
  )
    throw new Error('Informe uma data de coleta válida.');
  if (
    !d.values ||
    typeof d.values !== 'object' ||
    Array.isArray(d.values) ||
    !Object.keys(d.values).length
  )
    throw new Error('Preencha pelo menos um resultado.');
  for (const [id, v] of Object.entries(d.values)) {
    const field = definition.fields.find((f) => f.id === id);
    if (
      !field ||
      !v ||
      typeof v.value !== 'string' ||
      !v.value.trim() ||
      v.value.length > 2000 ||
      typeof v.unit !== 'string' ||
      v.unit.length > 40 ||
      typeof v.reference !== 'string' ||
      v.reference.length > 500
    )
      throw new Error('Confira os valores, unidades e referências.');
    if (field.type === 'number' && !validNumericExamValue(v.value))
      throw new Error(
        `${field.name}: use números sem separador de milhar; limites como < 0,1 são aceitos.`,
      );
    if (field.type === 'choice' && !field.options?.includes(v.value))
      throw new Error(`${field.name}: escolha uma opção válida.`);
  }
  for (const k of [
    'laboratory',
    'method',
    'specimen',
    'notes',
    'correction_reason',
  ] as const)
    if (typeof d[k] !== 'string' || d[k].length > (k === 'notes' ? 4000 : 500))
      throw new Error('Confira os dados da coleta.');
  if (d.supersedes_id && !d.correction_reason.trim())
    throw new Error('Informe o motivo da correção.');
  const source = d.source || 'manual';
  if (!['manual', 'ai_reviewed'].includes(source))
    throw new Error('Origem do resultado inválida.');
  if (
    !d.provenance ||
    typeof d.provenance !== 'object' ||
    Array.isArray(d.provenance)
  )
    throw new Error('Proveniência do resultado inválida.');
  if (
    source === 'ai_reviewed' &&
    (!d.attachment_id ||
      d.provenance.attachment_id !== d.attachment_id ||
      typeof d.provenance.provider !== 'string' ||
      !d.provenance.provider ||
      typeof d.provenance.model !== 'string' ||
      !d.provenance.model ||
      typeof d.provenance.extracted_at !== 'string' ||
      typeof d.provenance.reviewed_at !== 'string')
  )
    throw new Error('Confira a origem da sugestão revisada.');
}
