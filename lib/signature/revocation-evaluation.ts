// Resultado da avaliação de UMA evidência de revogação (uma LCR ou uma resposta OCSP) contra
// um certificado: o formato comum que as validações de LCR e de OCSP devolvem e as regras sobre
// o instante em que uma revogação passa a valer.

import { mapCrlReasonCodeToName } from './revocation-asn1.ts';
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

/**
 * Instante efetivo de revogação: o menor entre revocationDate e invalidityDate
 * (RFC 5280 §5.3.2), qualquer que seja o motivo.
 */
export function effectiveRevocationTime(
  revokedAt: Date,
  invalidityDate?: Date,
): Date {
  return invalidityDate && invalidityDate < revokedAt
    ? invalidityDate
    : revokedAt;
}

/**
 * Motivos em que o comprometimento pode anteceder a data administrativa de revogação:
 * keyCompromise (1), cACompromise (2), aACompromise (10) e códigos não reconhecidos (7, > 10).
 */
export function requiresConservativeRevocationTime(
  reasonCode: number | undefined,
): boolean {
  if (reasonCode === undefined) return false;
  return (
    reasonCode === 1 ||
    reasonCode === 2 ||
    reasonCode === 10 ||
    mapCrlReasonCodeToName(reasonCode) === 'unknown'
  );
}
