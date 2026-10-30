// Shared clinical policy. Number acquisition alone never establishes regularity.
export const prescriptionCategories = {
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
// Receita simples (sem retenção nem notificação) não é categoria SNCR: não pede numeração à
// Anvisa e sua assinatura eletrônica não depende da integração. Fica fora de
// `prescriptionCategories` para nunca ser aceita num pedido de numeração.
export const SIMPLE_PRESCRIPTION = 'SIMPLES';
export type DocumentPrescriptionCategory =
  | PrescriptionCategory
  | typeof SIMPLE_PRESCRIPTION;
export const documentPrescriptionCategories: Record<
  DocumentPrescriptionCategory,
  string
> = {
  SIMPLES: 'Receita simples (sem retenção)',
  ...prescriptionCategories,
};
export function isDocumentPrescriptionCategory(
  v: unknown,
): v is DocumentPrescriptionCategory {
  return v === SIMPLE_PRESCRIPTION || isPrescriptionCategory(v);
}
export function prescriptionSigningBlock(
  category: DocumentPrescriptionCategory,
  now = new Date(),
) {
  if (category === SIMPLE_PRESCRIPTION) return null;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
  }).format(now);
  if (category !== 'RCE' && category !== 'RET')
    return 'A emissão eletrônica desta notificação exige integração com o SNCR e modelo próprio. Esse fluxo ainda não está disponível no PsyWrite. Utilize o receituário físico autorizado pela Vigilância Sanitária.';
  if (day >= '2026-10-30')
    return 'A emissão eletrônica desta receita exige integração com o SNCR desde 30/10/2026. O fluxo integrado ainda não está disponível no PsyWrite. A impressão para assinatura manual continua disponível.';
  // The current PDF is an RCE model. Do not repurpose it for RET.
  if (category === 'RET')
    return 'O modelo eletrônico para receita sujeita à retenção ainda não está disponível no PsyWrite. Utilize o receituário físico adequado.';
  return null;
}
