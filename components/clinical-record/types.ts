// Consulta (evolução) como devolvida por /api/consultations.
export type RecordEntry = {
  id: string;
  text: string;
  version: number;
  created_at: string;
  finalized_at: string | null;
  author_id: string;
  finalized_by: string | null;
  status?: string;
  signed_at?: string | null;
  signed_by?: string | null;
  current_signature_id?: string | null;
  current_signature?: {
    id: string;
    signer_user_id: string;
    certificate_subject: string;
    certificate_issuer: string;
    certificate_serial: string;
    certificate_fingerprint: string;
    signed_at: string;
    verification_status: string;
    document_hash: string;
    provider: string;
    canonical_data?: Record<string, unknown>;
  } | null;
  consultation_addenda?: {
    id: string;
    text: string;
    author_id: string;
    created_at: string;
  }[];
};

/** Data e hora no fuso de São Paulo. */
export const date = (v: string) =>
  new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
