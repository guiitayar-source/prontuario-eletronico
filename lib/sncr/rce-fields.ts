// Contrato explícito do rascunho eletrônico. Nunca infere medicamento a partir
// do receituário livre antigo e nunca altera o texto clínico persistido.
import { parsePrescriptionText } from '../document-fields.ts';

export const rceLabels = {
  patientPassport: 'Passaporte do paciente (se estrangeiro)',
  medication: 'Nome do medicamento ou substância',
  concentration: 'Concentração',
  pharmaceuticalForm: 'Forma farmacêutica',
  quantity: 'Quantidade',
  dosage: 'Posologia',
  guidance: 'Orientações complementares',
} as const;
export type RceFields = Record<keyof typeof rceLabels, string> & { route: string };
const key = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function requireRceValue(value: string | null | undefined, label: string) {
  if (!value?.trim() || /\[[\s\S]*?\]|\{[\s\S]*?\}|\b(?:preencher|pendente|a definir|não informad[oa])\b/iu.test(value))
    throw new Error(`RCE incompleta: preencha ${label} e remova os marcadores de preenchimento.`);
  // eslint-disable-next-line no-control-regex -- Rejeição intencional de controles no conteúdo clínico.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value))
    throw new Error(`RCE: ${label} contém caractere de controle não permitido.`);
  return value.trim();
}

export function parseRceFields(raw: string): RceFields {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  requireRceValue(text, 'a prescrição');
  if (parsePrescriptionText(text).modality !== 'controle_especial')
    throw new Error('Modelo eletrônico RCE exclusivo de controle especial.');
  const fields: RceFields = { patientPassport: '', medication: '', concentration: '', pharmaceuticalForm: '', quantity: '', dosage: '', guidance: '', route: '' };
  const seen = new Set<string>();
  let current: keyof typeof rceLabels | null = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^\s*([^:]+):\s*(.*)$/u);
    const name = heading ? key(heading[1]) : '';
    if (name === 'sncr' || /^(?:n[º°o]?\s*)sncr$/.test(name))
      throw new Error('RCE eletrônica não aceita número SNCR manual no texto.');
    if (name === 'modalidade' || name === 'via de administracao') {
      if (current || seen.has(name)) throw new Error('RCE: cabeçalhos duplicados ou fora de posição.');
      seen.add(name);
      if (name === 'modalidade' && !['controle especial', 'controle_especial', 'receituario de controle especial'].includes(key(heading![2])))
        throw new Error('Modelo eletrônico RCE exclusivo de controle especial.');
      if (name === 'via de administracao') fields.route = requireRceValue(heading![2], 'a via de administração');
      continue;
    }
    const field = (Object.keys(rceLabels) as (keyof typeof rceLabels)[]).find(f => key(rceLabels[f]) === name);
    if (field) {
      if (seen.has(field)) throw new Error(`RCE ambígua: campo ${rceLabels[field]} repetido. Use um medicamento por documento.`);
      seen.add(field);
      current = field;
      fields[field] = heading![2];
    } else if (current) {
      // Toda linha remanescente pertence ao campo atual, inclusive instruções
      // e quebras. Nada é descartado por um parser de texto livre.
      fields[current] += '\n' + line;
    } else if (line.trim()) {
      throw new Error('RCE: use os campos explícitos do modelo eletrônico; o texto livre original deve ser revisado pelo prescritor.');
    }
  }
  fields.route = requireRceValue(fields.route, 'a via de administração');
  for (const field of Object.keys(rceLabels) as (keyof typeof rceLabels)[]) {
    if (field !== 'guidance' && field !== 'patientPassport') fields[field] = requireRceValue(fields[field], rceLabels[field]);
    else fields[field] = fields[field].trim();
  }
  return fields;
}

// Inserido somente por ação explícita, sem substituir o texto existente.
export const rceElectronicTemplate = `Via de administração: [preencher]
Passaporte do paciente (se estrangeiro):

Nome do medicamento ou substância: [preencher]
Concentração: [preencher]
Forma farmacêutica: [preencher]
Quantidade: [preencher]
Posologia: [preencher]
Orientações complementares:
`;
