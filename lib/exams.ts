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
export function normalizeExamUnit(
  rawUnit: string,
  defaultUnit = '',
): { key: string; label: string } {
  let u = (rawUnit || '').trim();
  if (!u && defaultUnit) u = defaultUnit.trim();
  if (!u) return { key: '', label: 'Unidade não informada' };

  const cleaned = u
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[µμ]/g, 'u')
    .replace(/³/g, '3')
    .replace(/⁶/g, '6')
    .replace(/\^3/g, '3')
    .replace(/\^6/g, '6')
    .replace(/\s+/g, ' ')
    .trim();

  // 1. Milhões / uL / mm3 (Hemácias: milhões/µL, milhões/mm3, 10^6/mm3, etc.)
  if (
    /^(?:milhoes|milhao)\s*\/\s*(?:ul|mm3|micro?litro|milimetro\s*cubico)$/.test(cleaned) ||
    /^(?:x\s*)?10\s*6\s*\/\s*(?:ul|mm3|l)$/.test(cleaned) ||
    /^(?:x\s*)?10e6\s*\/\s*(?:ul|mm3|l)$/.test(cleaned) ||
    /^m\s*\/\s*(?:ul|mm3)$/.test(cleaned) ||
    /^(?:tera|t)\s*\/\s*l$/.test(cleaned)
  ) {
    return { key: 'milhoes/ul', label: 'milhões/µL' };
  }

  // 2. Mil / uL / mm3 (Plaquetas ou contagens em milhares: mil/mm3, 10^3/mm3, etc.)
  if (
    /^mil\s*\/\s*(?:ul|mm3|micro?litro|milimetro\s*cubico)$/.test(cleaned) ||
    /^(?:x\s*)?10\s*3\s*\/\s*(?:ul|mm3|l)$/.test(cleaned) ||
    /^(?:x\s*)?10e3\s*\/\s*(?:ul|mm3|l)$/.test(cleaned) ||
    /^k\s*\/\s*(?:ul|mm3)$/.test(cleaned) ||
    /^(?:giga|g)\s*\/\s*l$/.test(cleaned)
  ) {
    return { key: 'mil/ul', label: 'mil/µL' };
  }

  // 3. /uL / mm3 (Leucócitos, Plaquetas, contagens absolutas: /µL, /mm3, etc.)
  if (
    /^(?:\/|por\s+)?(?:cel(?:ulas)?|leucocitos)?\s*\/?\s*(?:ul|mm3|micro?litro|milimetro\s*cubico)$/.test(cleaned) ||
    cleaned === '/ul' ||
    cleaned === '/mm3' ||
    cleaned === 'ul' ||
    cleaned === 'mm3' ||
    cleaned === '/ u'
  ) {
    return { key: '/ul', label: '/µL' };
  }

  // 4. Porcentagem (%)
  if (cleaned === '%' || cleaned === 'pct' || cleaned === 'por cento' || cleaned === 'porcento') {
    return { key: '%', label: '%' };
  }

  // 5. g/dL (Hemoglobina, CHCM, etc.)
  if (/^g\s*\/\s*(?:dl|100ml)$/.test(cleaned) || cleaned === 'g%' || cleaned === 'g/dl') {
    return { key: 'g/dl', label: 'g/dL' };
  }

  // 6. mg/dL (Glicemia, Colesterol, etc.)
  if (/^mg\s*\/\s*(?:dl|100ml)$/.test(cleaned) || cleaned === 'mg%' || cleaned === 'mg/dl') {
    return { key: 'mg/dl', label: 'mg/dL' };
  }

  // 7. fL (VCM, VPM: fL, µm3)
  if (/^fl\.?$/.test(cleaned) || cleaned === 'um3' || cleaned === 'femtolitro' || cleaned === 'femtolitros') {
    return { key: 'fl', label: 'fL' };
  }

  // 8. pg (HCM)
  if (/^pg\.?$/.test(cleaned) || cleaned === 'picograma' || cleaned === 'picogramas') {
    return { key: 'pg', label: 'pg' };
  }

  // 9. U/L (Enzimas AST, ALT, etc.)
  if (/^(?:u|ui)\s*\/\s*l$/.test(cleaned) || cleaned === 'unidades/l') {
    return { key: 'u/l', label: 'U/L' };
  }

  // 10. ng/mL
  if (/^ng\s*\/\s*ml$/.test(cleaned)) {
    return { key: 'ng/ml', label: 'ng/mL' };
  }

  // 11. pg/mL
  if (/^pg\s*\/\s*ml$/.test(cleaned)) {
    return { key: 'pg/ml', label: 'pg/mL' };
  }

  // 12. µg/dL, mcg/dL
  if (/^(?:mcg|ug)\s*\/\s*dl$/.test(cleaned)) {
    return { key: 'ug/dl', label: 'µg/dL' };
  }

  // 13. mg/L
  if (/^mg\s*\/\s*l$/.test(cleaned)) {
    return { key: 'mg/l', label: 'mg/L' };
  }

  // 14. mUI/mL, µUI/mL
  if (/^(?:mui|uui)\s*\/\s*ml$/.test(cleaned) || /^(?:mu|uu)\s*\/\s*ml$/.test(cleaned)) {
    return { key: 'mui/ml', label: 'mUI/mL' };
  }

  return { key: cleaned, label: u };
}

export function examSeries(
  results: ExamResult[],
  field: string,
  defaultUnit = '',
) {
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
      normalizedLabel: string;
    }[]
  >();
  for (const r of activeExamResults(results)) {
    const v = r.values[field];
    if (!v) continue;
    const number = numericExamValue(v.value);
    if (number === null) continue;
    const rawUnit = (v.unit || '').trim();
    const { key, label } = normalizeExamUnit(rawUnit, defaultUnit);
    const groupKey = key || 'sem_unidade';
    const group = groups.get(groupKey) || [];
    group.push({
      date: r.collected_on,
      value: number,
      id: r.id,
      unit: rawUnit,
      laboratory: r.laboratory,
      method: r.method,
      specimen: r.specimen,
      reference: v.reference,
      normalizedLabel: label,
    });
    groups.set(groupKey, group);
  }
  return [...groups].map(([key, points]) => {
    const label = points[0]?.normalizedLabel || 'Unidade não informada';
    return {
      key,
      unit: label,
      label: label ? `Unidade: ${label}` : 'Unidade não informada',
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
