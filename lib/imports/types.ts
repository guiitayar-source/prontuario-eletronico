import type { PatientInput } from '../patient-fields';
export const MAX_IMPORT_BYTES = 2_000_000;
export type Kind =
  | 'consultation'
  | 'condition'
  | 'medication'
  | 'allergy'
  | 'prescription'
  | 'appointment'
  | 'document';
export const kindLabels: Record<Kind, string> = {
  consultation: 'Consulta',
  condition: 'Diagnóstico',
  medication: 'Medicamento',
  allergy: 'Alergia',
  prescription: 'Receita',
  appointment: 'Agendamento',
  document: 'Documento',
};
export type ImportedEntry = {
  source_id: string;
  patient_source: string;
  kind: Kind;
  title: string;
  text: string;
  occurred_at: string | null;
  source_created_at: string | null;
  source_status: string;
  fingerprint: string;
};
export type ImportPatient = {
  source_id: string;
  fields: PatientInput;
  warnings: string[];
  errors: string[];
};
export type ImportPlan = {
  format: 'lgpd' | 'fhir-r4';
  patients: ImportPatient[];
  records: ImportedEntry[];
  warnings: string[];
};
export type Candidate = {
  id: string;
  name: string;
  dob: string | null;
  cpf: string | null;
  version: number;
};
export type Preview = {
  id: string;
  source: string;
  plan: Omit<ImportPlan, 'patients' | 'records'> & {
    patients: (ImportPatient & {
      candidates: Candidate[];
      linked_id: string | null;
    })[];
    records: (ImportedEntry & { duplicate: boolean; conflict: boolean })[];
  };
};
export type ImportResult = {
  id: string;
  created: number;
  imported: number;
  skipped: number;
  patients: { id: string; name: string }[];
};
export type ImportBatch = {
  id: string;
  source: string;
  format: string;
  state: 'committed' | 'reverted';
  committed_at: string;
  result: ImportResult;
};
