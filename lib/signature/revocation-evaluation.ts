// Resultado da avaliação de UMA evidência de revogação (uma LCR ou uma resposta OCSP) contra
// um certificado. É o formato comum que as validações de LCR e de OCSP devolvem.

import type { CrlReasonName } from './types.ts';

export interface SingleEvidenceEvaluation {
  source: 'CRL' | 'OCSP';
  matchKind:
    | 'MATCHED_VALID'
    /** Autêntica e aplicável, mas não comprova não revogação no instante de referência. */
    | 'NOT_FRESH'
    /** Resposta sem conteúdo autenticado (ex.: OCSP tryLater): não é evidência. */
    | 'UNAVAILABLE'
    | 'SCOPE_INCOMPATIBLE'
    | 'INVALID_EVIDENCE'
    | 'UNRELATED_ISSUER';
  certStatus?: 'GOOD' | 'REVOKED' | 'CERTIFICATE_HOLD' | 'UNKNOWN' | 'TRY_LATER';
  thisUpdate?: Date;
  nextUpdate?: Date;
  producedAt?: Date;
  revokedAt?: Date;
  invalidityDate?: Date;
  reasonCode?: number;
  reasonName?: CrlReasonName;
  subIndication?: string;
  error?: string;
}
