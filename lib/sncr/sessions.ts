import { randomUUID } from 'node:crypto';
import { HttpError } from '../supabase/server.ts';
import type { SncrActor, SncrDb } from './numbering.ts';
import {
  sncrAuthConfig,
  SNCR_API,
  type SncrAuthConfig,
  type SncrEnvironment,
} from './auth-config.ts';
import {
  secretHash,
  randomSecret,
  sealSession,
  openSession,
} from './session-crypto.ts';
import { exchangeSncrSession, SncrAuthError } from './auth-http.ts';

export type SncrSessionStatus = {
  state:
    | 'disconnected'
    | 'pending'
    | 'exchanging'
    | 'connected'
    | 'expired'
    | 'failed'
    | 'uncertain'
    | 'rejected'
    | 'identity_mismatch';
  environment: SncrEnvironment;
  identityStatus: 'unverified';
  expiresAt: string | null;
  reason: string | null;
};
type PrivateSession = SncrSessionStatus & {
  id: string | null;
  token_cipher: string | null;
  profile: { registration: string; cpf: string | null } | null;
};
export async function authOperation<T>(
  db: SncrDb,
  actor: SncrActor,
  environment: SncrEnvironment,
  action: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  let result;
  try {
    result = await db.rpc('sncr_auth_operation', {
      p_clinic: actor.clinicId,
      p_user: actor.userId,
      p_environment: environment,
      p_action: action,
      p_data: data,
    });
  } catch {
    throw new HttpError(
      503,
      'Banco de sessões SNCR indisponível; consulte o estado antes de tentar novamente.',
    );
  }
  if (result.error)
    throw new HttpError(
      result.error.code === '42501'
        ? 403
        : result.error.code === '23505'
          ? 409
          : 503,
      'Sessão SNCR indisponível, incompatível ou já utilizada. Conecte novamente.',
    );
  if (!result.data || typeof result.data !== 'object')
    throw new HttpError(503, 'Resposta de sessão SNCR inválida.');
  return result.data as T;
}
const aad = (actor: SncrActor, environment: SncrEnvironment, id: string) =>
  `${actor.clinicId}:${actor.userId}:${environment}:${id}`;

export class SncrSessions {
  private readonly db: SncrDb;
  private readonly transport: typeof fetch;
  // Transporte injetável para mocks contratuais; as rotas utilizam somente fetch HTTPS nativo.
  constructor(db: SncrDb, transport: typeof fetch = fetch) {
    this.db = db;
    this.transport = transport;
  }
  async start(actor: SncrActor, config = sncrAuthConfig()) {
    const state = randomSecret(),
      binding = randomSecret(),
      id = randomUUID();
    // Falha por chave ausente antes de gravar tentativa ou redirecionar o usuário.
    sealSession('key-check', 'configuration');
    await authOperation(this.db, actor, config.environment, 'start', {
      id,
      state_hash: secretHash(state),
      binding_hash: secretHash(binding),
    });
    const url = new URL('auth/login', SNCR_API[config.environment]);
    // Correlação no caminho: não depende de o SNCR repetir o state arbitrário na query.
    url.searchParams.set('client_url', `${config.callback}/${state}`);
    url.searchParams.set('state', state);
    return { authorizationUrl: url.href, binding };
  }
  status(actor: SncrActor, environment: SncrEnvironment = 'hmg') {
    return authOperation<SncrSessionStatus>(
      this.db,
      actor,
      environment,
      'status',
    );
  }
  disconnect(actor: SncrActor, environment: SncrEnvironment = 'hmg') {
    return authOperation(this.db, actor, environment, 'disconnect');
  }
  async complete(
    actor: SncrActor,
    binding: string,
    transfer: string,
    config = sncrAuthConfig(),
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(binding))
      throw new HttpError(403, 'Tentativa de autenticação inválida.');
    let callback: {
      state: string;
      sessionId: string;
      createdAt: number;
      cancelled: boolean;
    };
    try {
      callback = JSON.parse(
        openSession(
          transfer,
          `callback:${config.origin}:${secretHash(binding)}`,
        ),
      );
    } catch {
      throw new HttpError(
        403,
        'Retorno de autenticação inválido. Conecte novamente.',
      );
    }
    if (
      !callback ||
      typeof callback.createdAt !== 'number' ||
      !Number.isFinite(callback.createdAt) ||
      callback.createdAt > Date.now() ||
      Date.now() - callback.createdAt > 30000 ||
      !/^[A-Za-z0-9_-]{43}$/.test(callback.state)
    )
      throw new HttpError(
        403,
        'Retorno de autenticação expirado. Conecte novamente.',
      );
    if (callback.cancelled || !callback.sessionId) {
      // Valida a propriedade antes de encerrar a tentativa. Não afeta outros usuários.
      const cancelled = await authOperation<{ id: string }>(
        this.db,
        actor,
        config.environment,
        'claim',
        {
          state_hash: secretHash(callback.state),
          binding_hash: secretHash(binding),
          session_hash: secretHash(`cancelled:${callback.state}`),
        },
      );
      await authOperation(this.db, actor, config.environment, 'fail', {
        id: cancelled.id,
        reason: 'cancelled',
      });
      throw new HttpError(
        409,
        'Login SNCR cancelado ou retorno sem identificador de sessão.',
      );
    }
    const claim = await authOperation<{ id: string }>(
      this.db,
      actor,
      config.environment,
      'claim',
      {
        state_hash: secretHash(callback.state),
        binding_hash: secretHash(binding),
        session_hash: secretHash(callback.sessionId),
      },
    );
    try {
      const exchanged = await exchangeSncrSession(
        config,
        callback.sessionId,
        this.transport,
      );
      const cipher = sealSession(
        exchanged.token,
        aad(actor, config.environment, claim.id),
      );
      await authOperation(this.db, actor, config.environment, 'complete', {
        id: claim.id,
        token_cipher: cipher,
        expires_at: exchanged.expiresAt,
      });
    } catch (error) {
      try {
        await authOperation(this.db, actor, config.environment, 'fail', {
          id: claim.id,
          reason: error instanceof SncrAuthError ? error.reason : 'uncertain',
        });
      } catch {}
      // Se a resposta do banco se perder, exchanging/completed continuam duráveis e não há nova troca.
      throw error;
    }
    return this.status(actor, config.environment);
  }
  async numberingIdentity(
    actor: SncrActor,
    environment: SncrEnvironment,
    registration: string,
  ) {
    const session = await authOperation<PrivateSession>(
      this.db,
      actor,
      environment,
      'read',
    );
    if (
      session.environment !== environment ||
      session.state !== 'connected' ||
      !session.id ||
      !session.token_cipher ||
      !session.expiresAt ||
      Date.parse(session.expiresAt) <= Date.now()
    )
      throw new HttpError(409, 'Autentique sua conta SNCR novamente.');
    if (session.profile?.registration !== registration)
      throw new HttpError(403, 'Inscrição incompatível com a sessão SNCR.');
    // Manual §§2.3.1.5/2.3.2.5 e FAQ 22: o SNCR valida CPF autenticado x inscrição
    // na transação de numeração; não foi localizada obrigação de repetir essa consulta.
    // Este bloqueio local é conservador: ainda não houve transação oficial nem definição
    // da evidência que vincula a conta PsyWrite ao titular. unverified não invalida o login.
    // Não usar JWT apenas decodificado, CPF/CRM digitados ou resposta mock como prova.
    throw new HttpError(
      403,
      'Correspondência entre a conta PsyWrite e a identidade SNCR ainda não comprovada localmente. Solicitação de numeração bloqueada.',
    );
  }
}

// Executado na rota GET antes de qualquer página/script: nenhum token de acesso chega ao navegador.
export function captureSncrCallback(
  request: Request,
  state: string,
  binding: string,
  config: SncrAuthConfig,
) {
  const url = new URL(request.url);
  if (
    url.origin !== config.origin ||
    url.pathname !== new URL(config.callback).pathname + '/' + state ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(binding)
  )
    throw new HttpError(403, 'Retorno de autenticação inválido.');
  const sid = url.searchParams.get('session_id') || '';
  if (
    url.searchParams.getAll('session_id').length > 1 ||
    (sid && !/^[A-Za-z0-9._~-]{1,512}$/.test(sid))
  )
    throw new HttpError(403, 'Retorno de autenticação inválido.');
  return sealSession(
    JSON.stringify({
      state,
      sessionId: sid,
      cancelled: url.searchParams.has('error'),
      createdAt: Date.now(),
    }),
    `callback:${config.origin}:${secretHash(binding)}`,
  );
}
