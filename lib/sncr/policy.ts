// Shared clinical policy. Number acquisition alone never establishes regularity.
export const prescriptionCategories = {
  SIMPLES: 'Receita simples',
  RCE: 'Receita de Controle Especial',
  RET: 'Receita sujeita à retenção',
  NRA: 'Notificação de Receita A',
  NRB: 'Notificação de Receita B',
  NRB2: 'Notificação de Receita B2',
  NRR: 'Notificação para retinoides sistêmicos',
  NRT: 'Notificação de Talidomida',
} as const;
export type PrescriptionCategory = keyof typeof prescriptionCategories;
export function isPrescriptionCategory(v: unknown): v is PrescriptionCategory {
  return typeof v === 'string' && Object.hasOwn(prescriptionCategories, v);
}
// Fim da transição de RCE/RET eletrônicas sem integração ao SNCR
// (RDC 1.000/2025; prorrogação aprovada pela Anvisa em 29/10/2026 até 03/03/2027).
// Primeiro dia bloqueado, no horário de Brasília. O banco usa public.sncr_transition_end().
export const sncrTransitionEnd = '2027-03-04';

/** Assinatura exigida (RDC 1.000/2025): RCE art. 8º; RET art. 11. Bird ID/VIDaaS são qualificadas. */
export const prescriptionSignatureRequirement: Partial<
  Record<PrescriptionCategory, 'QUALIFICADA' | 'AVANCADA_OU_QUALIFICADA'>
> = { RCE: 'QUALIFICADA', RET: 'AVANCADA_OU_QUALIFICADA' };
export function prescriptionSigningBlock(
  category: PrescriptionCategory,
  now = new Date(),
) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
  }).format(now);
  // Receita simples não é controlada: não depende do SNCR.
  if (category === 'SIMPLES') return null;
  if (category !== 'RCE' && category !== 'RET')
    return 'A emissão eletrônica desta notificação exige integração com o SNCR e modelo próprio. Esse fluxo ainda não está disponível no PsyWrite. Utilize o receituário físico autorizado pela Vigilância Sanitária.';
  if (day >= sncrTransitionEnd)
    return 'A emissão eletrônica desta receita exige integração com o SNCR desde 04/03/2027. O fluxo integrado ainda não está disponível no PsyWrite. A impressão para assinatura manual continua disponível. Se for receita simples, altere o tipo de receituário para "Receita simples".';
  // RET tem fluxo e PDF próprios (duas vias, idade e sexo do paciente; RDC 471/2021).
  return null;
}
