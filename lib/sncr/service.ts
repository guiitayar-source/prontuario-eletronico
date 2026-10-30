// Imported only by app/api/sncr. Never send access tokens to the browser/storage.
import { createHash, randomBytes } from 'node:crypto';
import { adminClient } from '../supabase/admin.ts';
import {
  handle,
  HttpError,
  json,
  writeGuard,
  body,
  check,
} from '../supabase/server.ts';
import {
  SncrClient,
  SncrError,
  sncrLoginUrl,
  validateNumberingInput,
  validCnpj,
} from './client.ts';
import { completeNumbering } from './workflow.ts';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cookieName = 'psywrite_sncr_flow';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function browserSecret(request: Request) {
  return (
    request.headers
      .get('cookie')
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + '='))
      ?.slice(cookieName.length + 1) || ''
  );
}
export function sncrPreparationConfig(
  request: Request,
  environment = process.env.SNCR_ENVIRONMENT,
  returnUrl = process.env.SNCR_RETURN_URL || '',
) {
  // Deliberate homologation-only gate. Removing it requires the documented
  // binding/layout/16-digit checks, not simply changing an environment variable.
  if (environment !== 'hmg')
    throw new HttpError(
      503,
      'A integração SNCR ainda não está liberada. A emissão integrada permanece indisponível.',
    );
  let loginUrl: string;
  try {
    loginUrl = sncrLoginUrl('hmg', returnUrl);
  } catch (e) {
    throw new HttpError(503, (e as Error).message);
  }
  const origin = new URL(returnUrl).origin;
  if (new URL(request.url).origin !== origin)
    throw new HttpError(403, 'Origem de retorno SNCR não autorizada.');
  return { returnUrl, loginUrl, origin, environment: 'hmg' as const };
}
export const sncr = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role))
    throw new HttpError(403, 'Apenas prescritores podem utilizar o SNCR.');
  if (request.method === 'GET' && !new URL(request.url).searchParams.has('id'))
    return json({
      environment: process.env.SNCR_ENVIRONMENT === 'hmg' ? 'hmg' : 'disabled',
      issuanceAvailable: false,
    });
  const cfg = sncrPreparationConfig(request);
  const admin = adminClient();
  if (request.method === 'GET') {
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!uuid.test(id)) throw new HttpError(422, 'Solicitação inválida.');
    const row = check(
      await admin
        .from('sncr_numbering_requests')
        .select('id,category,state,http_status,created_at,updated_at')
        .eq('id', id)
        .eq('clinic_id', ctx.clinic)
        .eq('user_id', ctx.user)
        .maybeSingle(),
    );
    if (!row) throw new HttpError(404, 'Solicitação não encontrada.');
    // A worker/process can die after the remote POST. Never reclaim its lease.
    const state =
      row.state === 'REQUESTING' &&
      Date.parse(row.updated_at) < Date.now() - 30000
        ? 'UNKNOWN'
        : row.state;
    return json({ request: { ...row, state }, issuanceAvailable: false });
  }
  writeGuard(request, 'X-SNCR-Action');
  const p = await body(request);
  if (typeof p.id !== 'string' || !uuid.test(p.id))
    throw new HttpError(422, 'Identificador inválido.');
  if (p.action === 'start') {
    let input;
    try {
      input = validateNumberingInput(p.input);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
    if (
      ['RCE', 'RET'].includes(input.category) &&
      !validCnpj(process.env.SNCR_PLATFORM_CNPJ || '')
    )
      throw new HttpError(
        503,
        'Configure o CNPJ da empresa mantenedora do PsyWrite antes dos testes.',
      );
    // Expired authorization never sent a numbering POST and may be abandoned.
    check(
      await admin
        .from('sncr_numbering_requests')
        .update({ state: 'AUTH_EXPIRED', updated_at: new Date().toISOString() })
        .eq('user_id', ctx.user)
        .eq('environment', cfg.environment)
        .eq('state', 'AUTH_PENDING')
        .lt('expires_at', new Date().toISOString()),
    );
    const old = check(
      await admin
        .from('sncr_numbering_requests')
        .select('input,state,browser_hash')
        .eq('id', p.id)
        .eq('clinic_id', ctx.clinic)
        .eq('user_id', ctx.user)
        .maybeSingle(),
    );
    let secret = browserSecret(request);
    if (!/^[0-9a-f]{64}$/.test(secret))
      secret = randomBytes(32).toString('hex');
    if (old) {
      if (
        old.state !== 'AUTH_PENDING' ||
        old.browser_hash !== hash(secret) ||
        JSON.stringify(validateNumberingInput(old.input)) !==
          JSON.stringify(input)
      )
        throw new HttpError(
          409,
          'Solicitação já iniciada ou processada. Consulte o resultado.',
        );
    } else {
      const result = await admin
        .from('sncr_numbering_requests')
        .insert({
          id: p.id,
          clinic_id: ctx.clinic,
          user_id: ctx.user,
          environment: cfg.environment,
          category: input.category,
          input,
          browser_hash: hash(secret),
        });
      if (result.error?.code === '23505')
        throw new HttpError(
          409,
          'Já existe uma solicitação deste tipo aguardando conclusão ou conferência. Não solicite outro lote.',
        );
      check(result);
    }
    const response = json({
      loginUrl: cfg.loginUrl,
      environment: cfg.environment,
      issuanceAvailable: false,
    });
    response.headers.append(
      'Set-Cookie',
      `${cookieName}=${secret}; HttpOnly; SameSite=Lax; Path=/api/sncr; Max-Age=600${cfg.origin.startsWith('https:') ? '; Secure' : ''}`,
    );
    return response;
  }
  if (p.action !== 'complete' || typeof p.sessionId !== 'string')
    throw new HttpError(422, 'Solicitação inválida.');
  const secret = browserSecret(request);
  if (!/^[0-9a-f]{64}$/.test(secret))
    throw new HttpError(403, 'Inicie a autenticação neste navegador.');
  // CAS in a DB transaction; concurrent callbacks and repeated sends lose here,
  // before token exchange or number acquisition can happen.
  const row = check(
    await admin.rpc('sncr_claim_request', {
      rid: p.id,
      c: ctx.clinic,
      u: ctx.user,
      browser: hash(secret),
    }),
  );
  const input = validateNumberingInput(row.input);
  const client = new SncrClient(cfg.environment, cfg.origin);
  const update = async (fields: Record<string, unknown>) =>
    check(
      await admin
        .from('sncr_numbering_requests')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', p.id)
        .eq('clinic_id', ctx.clinic)
        .eq('user_id', ctx.user),
    );
  try {
    return json(
      await completeNumbering({
        client,
        sessionId: p.sessionId,
        input,
        platformCnpj: process.env.SNCR_PLATFORM_CNPJ || '',
        store: {
          update,
          storeNumbers: async (numbers) => {
            check(
              await admin.rpc('sncr_store_numbers', {
                rid: p.id,
                c: ctx.clinic,
                u: ctx.user,
                numbers,
              }),
            );
          },
        },
      }),
    );
  } catch (e) {
    // A remote 401 is not an expired PsyWrite session. Returning local 401
    // would make apiFetch refresh Supabase and replay this one-use callback.
    if (e instanceof SncrError)
      throw new HttpError(e.uncertain ? 503 : 422, e.message);
    throw e;
  }
});
