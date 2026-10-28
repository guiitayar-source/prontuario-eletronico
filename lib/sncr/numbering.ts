// Server only. Sem OAuth externo ou estoque em memória. O banco é a fonte de verdade.
import { createHash } from 'node:crypto';
import { HttpError } from '../supabase/server.ts';
import type { ClinicalDocument } from '../document-fields.ts';

export interface SncrDb {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { code?: string; message: string } | null;
  }>;
}
export type SncrActor = { clinicId: string; userId: string };
export type Reservation = {
  id: string;
  document_id: string;
  prescriber_id: string;
  document_version: number;
  number: string;
  modality: string;
  environment: 'hmg' | 'prd';
  state: 'reserved' | 'signing' | 'uncertain' | 'abandoned' | 'signed';
  attempt_id: string | null;
  artifact_metadata: Record<string, unknown> | null;
};
export type NumberingContext = {
  document: ClinicalDocument;
  reservation: Reservation | null;
  origin: string | null;
  sandbox: boolean;
  claimed?: boolean;
};
export function localSimulationEnabled() {
  let local = false;
  try {
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '');
    local =
      u.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {}
  return (
    process.env.PSYWRITE_SNCR_MODE === 'local-simulation' &&
    ['development', 'test'].includes(process.env.NODE_ENV || '') &&
    !process.env.VERCEL &&
    !process.env.VERCEL_ENV &&
    local &&
    process.env.ANVISA_SNCR_ENV?.trim().toLowerCase() !== 'prd'
  );
}
export function requireLocalSimulation() {
  if (!localSimulationEnabled())
    throw new HttpError(
      503,
      'Emissão eletrônica controlada bloqueada até autenticação SNCR/gov.br. Apenas simulação local isolada está disponível.',
    );
}
export async function sncrRpc(
  db: SncrDb,
  name: string,
  args: Record<string, unknown>,
): Promise<NumberingContext> {
  let result;
  try {
    result = await db.rpc(name, args);
  } catch {
    throw new HttpError(
      503,
      'Resultado da operação SNCR desconhecido. Consulte o estado; não crie outra reserva.',
    );
  }
  if (result.error) {
    const code = result.error.code;
    const status =
      code === '42501'
        ? 403
        : code === '40001' || code === '23505'
          ? 409
          : code === '23514' || code === '22023' || code === 'P0001'
            ? 422
            : 503;
    throw new HttpError(
      status,
      status === 503
        ? 'Banco indisponível ou resultado incerto. Consulte o estado antes de repetir.'
        : result.error.message,
    );
  }
  const ctx = result.data as NumberingContext;
  if (!ctx?.document?.id || typeof ctx.sandbox !== 'boolean')
    throw new HttpError(503, 'Resposta de numeração inconsistente.');
  return ctx;
}
export function actorArgs(actor: SncrActor, documentId: string) {
  return {
    p_clinic: actor.clinicId,
    p_prescriber: actor.userId,
    p_document: documentId,
  };
}
export function reservationKey(actor: SncrActor, documentId: string) {
  const hex = createHash('sha256')
    .update(`sncr-local-v1:${actor.clinicId}:${actor.userId}:${documentId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function getNumberingContext(
  db: SncrDb,
  actor: SncrActor,
  documentId: string,
) {
  return sncrRpc(db, 'sncr_document_context', actorArgs(actor, documentId));
}
export async function reserveDocument(
  db: SncrDb,
  actor: SncrActor,
  documentId: string,
) {
  requireLocalSimulation();
  const ctx = await sncrRpc(db, 'sncr_reserve_document', {
    ...actorArgs(actor, documentId),
    p_request_key: reservationKey(actor, documentId),
  });
  assertSynthetic(ctx);
  return ctx;
}
export function assertSynthetic(ctx: NumberingContext) {
  const r = ctx.reservation;
  if (
    !ctx.sandbox ||
    ctx.origin !== 'synthetic' ||
    !r ||
    r.environment !== 'hmg' ||
    !r.number.startsWith('SIMULADO.') ||
    r.document_id !== ctx.document.id ||
    r.prescriber_id !== ctx.document.author_id ||
    r.document_version !== ctx.document.version
  ) {
    throw new HttpError(
      409,
      'Reserva sintética ausente ou incompatível. Números manuais não autorizam assinatura.',
    );
  }
}

export function abandonReservation(
  db: SncrDb,
  actor: SncrActor,
  documentId: string,
  reason: 'document_abandoned' | 'replaced_by_new_document',
) {
  requireLocalSimulation();
  return sncrRpc(db, 'sncr_abandon_document', {
    ...actorArgs(actor, documentId),
    p_reason: reason,
  });
}
