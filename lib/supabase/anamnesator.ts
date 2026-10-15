import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { adminClient } from './admin.ts';
import { assertFeature } from './features.ts';
import {
  body,
  boundedBody,
  check,
  handle,
  HttpError,
  json,
  writeGuard,
} from './server.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^[a-f0-9]{64}$/;
const COLUMNS =
  'id,consultation_id,patient_label,source,state,created_at,pair_expires_at,device_expires_at,transcription,draft,revision,received_at';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new HttpError(422, 'Atendimento inválido.');
  return value;
}

export const anamnesator = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role))
    throw new HttpError(403, 'Acesso exclusivo da equipe médica.');
  await assertFeature(ctx, 'anamnesator');
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const consultation = id(url.searchParams.get('consultationId'));
    return json({
      requests: check(
        await ctx.db
          .from('anamnesator_requests')
          .select(COLUMNS)
          .eq('clinic_id', ctx.clinic)
          .eq('consultation_id', consultation)
          .order('created_at', { ascending: false })
          .limit(20),
      ),
    });
  }
  writeGuard(request, 'X-Anamnesator-Action');
  const action = url.searchParams.get('action');
  if (action === 'desktop-result') {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await boundedBody(request, 900000),
        ),
      );
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'Solicitação inválida.');
    }
    if (
      !d ||
      typeof d !== 'object' ||
      Array.isArray(d) ||
      Object.keys(d).some(
        (k) =>
          ![
            'id',
            'consultation_id',
            'revision',
            'transcription',
            'draft',
          ].includes(k),
      ) ||
      !Number.isSafeInteger(d.revision) ||
      Number(d.revision) < 1 ||
      Number(d.revision) > 2147483647 ||
      typeof d.transcription !== 'string' ||
      !d.transcription.trim() ||
      d.transcription.length > 100000 ||
      typeof d.draft !== 'string' ||
      d.draft.length > 100000
    )
      throw new HttpError(422, 'Resultado em texto inválido.');
    id(d.id);
    id(d.consultation_id);
    return json(
      check(
        await ctx.db.rpc('anamnesator_request', {
          c: ctx.clinic,
          action: 'desktop_result',
          d,
        }),
      ),
    );
  }
  const d = await body(request);
  if (action === 'cancel') {
    return json(
      check(
        await ctx.db.rpc('anamnesator_request', {
          c: ctx.clinic,
          action,
          d: { id: id(d.id) },
        }),
      ),
    );
  }
  if (action !== 'create') throw new HttpError(404, 'Operação não encontrada.');
  const origin =
    process.env.PSYWRITE_ANAMNESATOR_ORIGIN || 'https://psywrite.vercel.app';
  if (origin !== 'https://psywrite.vercel.app')
    throw new HttpError(503, 'Origem do aplicativo nativo não configurada.');
  const token = randomBytes(32).toString('hex');
  const result = check(
    await ctx.db.rpc('anamnesator_request', {
      c: ctx.clinic,
      action,
      d: {
        id: randomUUID(),
        consultation_id: id(d.consultation_id),
        pair_hash: hash(token),
      },
    }),
  ) as { id: string; pair_expires_at: string };
  // Pairing contains no home-server credential and grants no chart-reading access.
  const parameters = new URLSearchParams({ origin, request: result.id, token });
  return json(
    {
      ...result,
      qr: JSON.stringify({
        type: 'psywrite-request/v1',
        origin,
        id: result.id,
        token,
      }),
      // Explicit package prevents another handler for the custom scheme receiving
      // the capability when this link is opened from Chrome on Android.
      app_url:
        'intent://psywrite/pair?' +
        parameters +
        '#Intent;scheme=anamnesator;package=com.anamnesator.android;end',
    },
    201,
  );
});

/** Only JSON text is accepted. This endpoint has no upload/storage operation. */
export async function anamnesatorNative(request: Request) {
  try {
    if (request.method !== 'POST')
      throw new HttpError(405, 'Método não permitido.');
    if (
      request.headers.has('origin') ||
      request.headers.get('X-Anamnesator-Native') !== '1'
    )
      throw new HttpError(403, 'Use o aplicativo Anamnesator.');
    if (
      request.headers.get('content-type')?.split(';')[0].trim() !==
      'application/json'
    )
      throw new HttpError(415, 'Somente resultados em texto são aceitos.');
    const authorization = request.headers.get('authorization') || '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    if (!TOKEN.test(token))
      throw new HttpError(403, 'Autorização inválida ou expirada.');
    const url = new URL(request.url),
      action = url.searchParams.get('action');
    const requestId = id(url.searchParams.get('id'));
    const bytes = await boundedBody(
      request,
      action === 'claim' ? 1024 : 900000,
    );
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error();
    } catch {
      throw new HttpError(400, 'Solicitação inválida.');
    }
    const admin = adminClient();
    if (action === 'claim') {
      if (
        Object.keys(d).some((k) => k !== 'device_token') ||
        typeof d.device_token !== 'string' ||
        !TOKEN.test(d.device_token)
      )
        throw new HttpError(422, 'Autorização do dispositivo inválida.');
      return json(
        check(
          await admin.rpc('anamnesator_native_claim', {
            request_id: requestId,
            pair_hash: hash(token),
            device_hash: hash(d.device_token),
          }),
        ),
      );
    }
    if (action !== 'result')
      throw new HttpError(404, 'Operação não encontrada.');
    if (
      Object.keys(d).some(
        (k) => !['revision', 'transcription', 'draft'].includes(k),
      ) ||
      !Number.isSafeInteger(d.revision) ||
      Number(d.revision) < 1 ||
      Number(d.revision) > 2147483647 ||
      typeof d.transcription !== 'string' ||
      !d.transcription.trim() ||
      d.transcription.length > 100000 ||
      typeof d.draft !== 'string' ||
      d.draft.length > 100000
    )
      throw new HttpError(422, 'Resultado em texto inválido.');
    return json(
      check(
        await admin.rpc('anamnesator_native_result', {
          request_id: requestId,
          device_hash: hash(token),
          d,
        }),
      ),
    );
  } catch (error) {
    return json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : 'Não foi possível receber o resultado.',
      },
      error instanceof HttpError ? error.status : 500,
    );
  }
}
