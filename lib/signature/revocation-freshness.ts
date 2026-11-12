// Política de frescor da evidência de revogação: quando uma LCR/OCSP autêntica de "não revogado"
// comprova o estado do certificado no instante de referência.

import type { PadesVerificationOptions } from './types.ts';

/**
 * Política de frescor (Lote 6F.2C-R) — ver docs/auditorias/6f2c/CORRECAO-6F2C-R.md.
 *
 * - CURRENT (sem POE confiável completa; referência = instante da verificação): a evidência de
 *   não revogação precisa estar vigente agora — `thisUpdate ≤ agora ≤ nextUpdate`
 *   (RFC 5280 §6.3.3; RFC 6960 §4.2.2.1). OCSP sem nextUpdate vale até `maxAgeWithoutNextUpdateMs`
 *   após thisUpdate. Se `maxAgeMs` for definido, limita a idade de qualquer evidência
 *   (ETSI EN 319 102-1 §5.2.5.4, "maximum accepted revocation freshness").
 * - HISTORICAL (POE confiável completa; referência = poeTime): só prova não revogação na POE a
 *   evidência emitida em/depois de `poeTime + gracePeriodMs` e antes do vencimento do certificado.
 *   Ela NÃO precisa estar vigente no instante da verificação (validação de longo prazo).
 *   Evidência emitida antes da POE nunca comprova GOOD na POE, ainda que siga vigente.
 * - COVERING_OR_LATER: uso interno (status do respondente OCSP delegado em producedAt): aceita
 *   evidência vigente em `ref` ou emitida depois dele.
 *
 * Evidência de revogação/suspensão é fato autêntico e não depende de frescor.
 */
export interface RevocationFreshnessContext {
  mode: 'CURRENT' | 'HISTORICAL' | 'COVERING_OR_LATER';
  gracePeriodMs: number;
  maxAgeMs?: number;
  maxAgeWithoutNextUpdateMs: number;
}

export const DEFAULT_OCSP_MAX_AGE_WITHOUT_NEXT_UPDATE_SECONDS = 24 * 60 * 60;

export function freshnessContextFromOptions(
  options: PadesVerificationOptions,
  mode: RevocationFreshnessContext['mode'],
): RevocationFreshnessContext {
  const f = options.revocationFreshness ?? {};
  const seconds = (v: number | undefined, fallback?: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? v * 1000
      : fallback === undefined
        ? undefined
        : fallback * 1000;
  return {
    mode,
    gracePeriodMs: seconds(f.gracePeriodSeconds, 0)!,
    maxAgeMs: seconds(f.maxAgeSeconds),
    maxAgeWithoutNextUpdateMs: seconds(
      f.maxAgeWithoutNextUpdateSeconds,
      DEFAULT_OCSP_MAX_AGE_WITHOUT_NEXT_UPDATE_SECONDS,
    )!,
  };
}

/**
 * Decide se uma evidência AUTÊNTICA de "não revogado" comprova o estado no instante de referência.
 * Retorna `null` quando comprova, ou a explicação de por que não comprova.
 */
export function goodEvidenceFreshnessProblem(params: {
  thisUpdate: Date;
  nextUpdate?: Date;
  referenceTime: Date;
  verificationTime: Date;
  targetValidTo: Date;
  freshness: RevocationFreshnessContext;
}): string | null {
  const { thisUpdate, nextUpdate, referenceTime, verificationTime, freshness } =
    params;
  // A AC pode retirar da lista certificados vencidos: evidência posterior ao vencimento não prova nada.
  if (thisUpdate > params.targetValidTo)
    return `emitida (${thisUpdate.toISOString()}) depois do vencimento do certificado (${params.targetValidTo.toISOString()})`;

  const coversReference =
    thisUpdate <= referenceTime &&
    (nextUpdate
      ? referenceTime <= nextUpdate
      : referenceTime.getTime() - thisUpdate.getTime() <=
        freshness.maxAgeWithoutNextUpdateMs);

  if (freshness.mode === 'CURRENT') {
    if (!coversReference)
      return `não vigente no instante da verificação (${referenceTime.toISOString()})`;
    if (
      freshness.maxAgeMs !== undefined &&
      verificationTime.getTime() - thisUpdate.getTime() > freshness.maxAgeMs
    )
      return `mais antiga que a idade máxima aceita (${Math.round(freshness.maxAgeMs / 1000)} s)`;
    return null;
  }

  const issuedAfterReference =
    thisUpdate.getTime() >= referenceTime.getTime() + freshness.gracePeriodMs;
  if (freshness.mode === 'HISTORICAL') {
    return issuedAfterReference
      ? null
      : `emitida (${thisUpdate.toISOString()}) antes de POE + carência (${new Date(referenceTime.getTime() + freshness.gracePeriodMs).toISOString()}); não comprova a ausência de revogação na POE`;
  }
  return coversReference || thisUpdate >= referenceTime
    ? null
    : `não cobre o instante de referência (${referenceTime.toISOString()})`;
}
