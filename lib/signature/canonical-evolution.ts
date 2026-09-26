import crypto from 'node:crypto';

export interface CanonicalEvolutionV1 {
  schema_version: 1;
  evolution_id: string;
  clinic_id: string;
  patient_id: string;
  appointment_id: string | null;
  doctor_id: string;
  created_at: string;
  clinical_text: string;
  version: number;
}

export type CanonicalEvolution = CanonicalEvolutionV1;

/**
 * Normaliza o texto da evolução clínica:
 * - Unicode NFC
 * - Quebras de linha padronizadas em LF (\n)
 * - Trim de espaços no início e final
 */
export function normalizeClinicalText(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/**
 * Constrói a estrutura canônica V1 para a evolução clínica.
 */
export function buildCanonicalEvolutionV1(params: {
  evolutionId: string;
  clinicId: string;
  patientId: string;
  appointmentId?: string | null;
  doctorId: string;
  createdAt: string | Date;
  clinicalText: string;
  version: number;
}): CanonicalEvolutionV1 {
  const createdAtIso =
    typeof params.createdAt === 'string'
      ? new Date(params.createdAt).toISOString()
      : params.createdAt.toISOString();

  return {
    schema_version: 1,
    evolution_id: params.evolutionId,
    clinic_id: params.clinicId,
    patient_id: params.patientId,
    appointment_id: params.appointmentId || null,
    doctor_id: params.doctorId,
    created_at: createdAtIso,
    clinical_text: normalizeClinicalText(params.clinicalText),
    version: params.version,
  };
}

/**
 * Serialização JSON canônica determinística com chaves ordenadas lexicograficamente.
 */
export function serializeCanonicalData(data: Record<string, unknown>): string {
  const sortedKeys = Object.keys(data).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedObj[key] = data[key];
  }
  return JSON.stringify(sortedObj);
}

/**
 * Calcula o hash SHA-256 da representação canônica.
 */
export function computeEvolutionHash(canonicalData: Record<string, unknown>): {
  canonicalJson: string;
  hashHex: string;
} {
  const canonicalJson = serializeCanonicalData(canonicalData);
  const hashHex = crypto
    .createHash('sha256')
    .update(Buffer.from(canonicalJson, 'utf8'))
    .digest('hex');
  return { canonicalJson, hashHex };
}
