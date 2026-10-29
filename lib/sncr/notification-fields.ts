// Conteúdo explícito para os três modelos eletrônicos de Notificação.
// Nenhum campo é inferido de receitas antigas em texto livre.
import { parsePrescriptionText, type PrescriptionModality } from '../document-fields.ts';
import { requireRceValue } from './rce-fields.ts';

export type NotificationModality = Extract<PrescriptionModality, 'notificacao_a' | 'notificacao_b' | 'notificacao_b2'>;
export const notificationApiType: Record<NotificationModality, 'NRA' | 'NRB' | 'NRB2'> = {
  notificacao_a: 'NRA',
  notificacao_b: 'NRB',
  notificacao_b2: 'NRB2',
};
export const notificationLabels = {
  patientPassport: 'Passaporte do paciente (se estrangeiro)',
  medication: 'Nome do medicamento ou substância',
  concentration: 'Concentração',
  pharmaceuticalForm: 'Forma farmacêutica',
  quantity: 'Quantidade',
  dosage: 'Posologia',
  guidance: 'Orientações complementares',
} as const;
export type NotificationFields = Record<keyof typeof notificationLabels, string> & { route: string };
const key = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function parseNotificationFields(raw: string, modality: NotificationModality): NotificationFields {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  requireRceValue(text, 'a prescrição');
  if (parsePrescriptionText(text).modality !== modality)
    throw new Error('Notificação: modalidade do texto incompatível com o modelo eletrônico.');
  const fields: NotificationFields = { patientPassport: '', medication: '', concentration: '', pharmaceuticalForm: '', quantity: '', dosage: '', guidance: '', route: '' };
  const seen = new Set<string>();
  let current: keyof typeof notificationLabels | null = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^\s*([^:]+):\s*(.*)$/u);
    const name = heading ? key(heading[1]) : '';
    if (name === 'sncr' || /^(?:n[º°o]?\s*)sncr$/.test(name))
      throw new Error('Notificação eletrônica não aceita número SNCR manual no texto.');
    if (name === 'modalidade' || name === 'via de administracao') {
      if (current || seen.has(name)) throw new Error('Notificação: cabeçalhos duplicados ou fora de posição.');
      seen.add(name);
      if (name === 'modalidade' && key(heading![2]) !== key(`Notificação de Receita ${notificationApiType[modality].slice(2)}`)
          && key(heading![2]) !== modality)
        throw new Error('Notificação: modalidade do cabeçalho incompatível.');
      if (name === 'via de administracao') fields.route = requireRceValue(heading![2], 'a via de administração');
      continue;
    }
    const field = (Object.keys(notificationLabels) as (keyof typeof notificationLabels)[]).find(f => key(notificationLabels[f]) === name);
    if (field) {
      if (seen.has(field)) throw new Error(`Notificação ambígua: campo ${notificationLabels[field]} repetido. Use um medicamento por documento.`);
      seen.add(field);
      current = field;
      fields[field] = heading![2];
    } else if (current) {
      fields[current] += '\n' + line;
    } else if (line.trim()) {
      throw new Error('Notificação: use os campos explícitos do modelo eletrônico; revise o texto livre.');
    }
  }
  fields.route = requireRceValue(fields.route, 'a via de administração');
  for (const field of Object.keys(notificationLabels) as (keyof typeof notificationLabels)[]) {
    if (field !== 'guidance' && field !== 'patientPassport') fields[field] = requireRceValue(fields[field], notificationLabels[field]);
    else fields[field] = fields[field].trim();
  }
  return fields;
}

export const notificationElectronicTemplate = `Via de administração: [preencher]
Passaporte do paciente (se estrangeiro):

Nome do medicamento ou substância: [preencher]
Concentração: [preencher]
Forma farmacêutica: [preencher]
Quantidade: [preencher]
Posologia: [preencher]
Orientações complementares:
`;
