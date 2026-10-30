// Server-side only. Contract: docs/sncr/openapi-hmg-2026-10-19.json and manual 3rd ed.
import { isPrescriptionCategory, type PrescriptionCategory } from './policy.ts';

export const sncrBases = {
  hmg: 'https://api-gateway.hmg.apps.anvisa.gov.br/api-sncr/api/v1/',
  prd: 'https://api-gateway.prd.apps.anvisa.gov.br/api-sncr/api/v1/',
} as const;
export type SncrEnvironment = keyof typeof sncrBases;
export type NumberingInput = {
  category: PrescriptionCategory;
  conselho: 'CRM'; // PsyWrite currently serves physicians.
  documento: string;
  uf: string;
  quantidade?: number;
};
const ufs = new Set(
  'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(
    ' ',
  ),
);
const hasUnsafeHeaderChars = (value: string) =>
  value.split('').some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127);
export function validateNumberingInput(value: unknown): NumberingInput {
  const v = value as Partial<NumberingInput> | null;
  if (
    !v ||
    !isPrescriptionCategory(v.category) ||
    v.category === 'SIMPLES' ||
    v.conselho !== 'CRM' ||
    typeof v.documento !== 'string' ||
    !/^\d{1,15}$/.test(v.documento) ||
    typeof v.uf !== 'string' ||
    !ufs.has(v.uf)
  )
    throw new Error('Confira tipo de receita e CRM/UF.');
  if (
    v.category !== 'RCE' &&
    v.category !== 'RET' &&
    (!Number.isInteger(v.quantidade) ||
      v.quantidade! < 10 ||
      v.quantidade! > 50)
  )
    throw new Error('Solicite entre 10 e 50 numerações de notificação.');
  return {
    category: v.category,
    conselho: 'CRM',
    documento: v.documento,
    uf: v.uf,
    ...(v.category === 'RCE' || v.category === 'RET'
      ? {}
      : { quantidade: v.quantidade }),
  };
}
export function validCnpj(value: string) {
  if (!/^\d{14}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  const digit = (s: string) => {
    let weight = s.length - 7;
    const sum = s.split('').reduce((n, c) => {
      const r = n + Number(c) * weight;
      weight = weight === 2 ? 9 : weight - 1;
      return r;
    }, 0);
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  return (
    digit(value.slice(0, 12)) === Number(value[12]) &&
    digit(value.slice(0, 13)) === Number(value[13])
  );
}
export class SncrError extends Error {
  httpStatus: number;
  uncertain: boolean;
  constructor(status: number, uncertain: boolean) {
    super(
      uncertain
        ? 'O resultado da solicitação ao SNCR é incerto. Não repita a operação; é necessária conferência.'
        : status === 401
          ? 'A autenticação no SNCR expirou. Inicie uma nova autenticação.'
          : 'O SNCR não concluiu a solicitação. Confira os dados e a disponibilidade da numeração.',
    );
    this.httpStatus = status;
    this.uncertain = uncertain;
  }
}

export function sncrLoginUrl(env: SncrEnvironment, returnUrl: string) {
  const u = new URL(returnUrl);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/sncr' ||
    !(
      (u.protocol === 'https:' && u.hostname.endsWith('.br')) ||
      (env === 'hmg' &&
        u.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(u.hostname))
    )
  )
    throw new Error(
      'Configure SNCR_RETURN_URL com HTTPS em domínio .br, caminho /sncr; localhost é permitido em homologação.',
    );
  const login = new URL('auth/login', sncrBases[env]);
  login.searchParams.set('client_url', u.href);
  return login.href;
}

export class SncrClient {
  environment: SncrEnvironment;
  origin: string;
  fetcher: typeof fetch;
  constructor(
    environment: SncrEnvironment,
    origin: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.environment = environment;
    this.origin = origin;
    this.fetcher = fetcher;
  }
  private async call(
    path: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
    mutation: boolean,
  ) {
    let r: Response;
    try {
      r = await this.fetcher(new URL(path, sncrBases[this.environment]), {
        ...init,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
        headers: {
          ...init.headers,
          Origin: this.origin,
          Accept: 'application/json',
        },
      });
    } catch {
      throw new SncrError(503, mutation);
    }
    // Do not retry POSTs. A 5xx/timeout may have consumed a real quota.
    if (!r.ok || r.status === 204)
      throw new SncrError(
        r.status,
        mutation && ![204, 400, 401, 403, 404].includes(r.status),
      );
    try {
      const reader = r.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65536) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new SncrError(502, mutation);
    }
  }
  async exchange(sessionId: string) {
    if (
      !sessionId ||
      sessionId.length > 2048 ||
      hasUnsafeHeaderChars(sessionId)
    )
      throw new SncrError(400, false);
    const result = await this.call(
      'auth/token?session_id=' + encodeURIComponent(sessionId),
      { method: 'GET' },
      false,
    );
    if (
      typeof result.access_token !== 'string' ||
      !result.access_token ||
      hasUnsafeHeaderChars(result.access_token) ||
      result.access_token.length > 16000 ||
      result.token_type !== 'Bearer'
    )
      throw new SncrError(502, false);
    return result.access_token; // Only retained in memory for the immediate request.
  }
  async requestNumbers(
    token: string,
    input: NumberingInput,
    platformCnpj: string,
  ) {
    const v = validateNumberingInput(input);
    const white = v.category === 'RCE' || v.category === 'RET';
    if (white && !validCnpj(platformCnpj))
      throw new Error(
        'Configure o CNPJ válido da empresa mantenedora do PsyWrite.',
      );
    const payload = white
      ? {
          conselho: v.conselho,
          tipo: v.category,
          documento: v.documento,
          uf: v.uf,
          cnpj: platformCnpj,
        }
      : {
          receita: v.category,
          conselho: v.conselho,
          uf: v.uf,
          documento: v.documento,
          quantidade: v.quantidade,
        };
    return this.call(
      white
        ? 'numeracoes/receita-especial-retencao'
        : 'numeracoes/notificacao-receita',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      true,
    );
  }
}

// Only the published 14-digit format is understood. The announced 16-digit
// change must be checked against updated official docs before accepting it.
export function parseNumberingResponse(
  input: NumberingInput,
  raw: Record<string, unknown>,
): string[] {
  const pattern = /^\d{4}\.\d-\d{2}\.\d{7}$/;
  if (input.category === 'RCE' || input.category === 'RET') {
    if (
      typeof raw.inicio !== 'string' ||
      typeof raw.fim !== 'string' ||
      raw.quantidade !== 1000 ||
      !pattern.test(raw.inicio) ||
      !pattern.test(raw.fim) ||
      raw.inicio.slice(0, 10) !== raw.fim.slice(0, 10)
    )
      throw new Error('Contrato de numeração divergente.');
    const start = Number(raw.inicio.slice(10)),
      end = Number(raw.fim.slice(10));
    const prefix = raw.inicio.slice(0, 10);
    if (end - start + 1 !== raw.quantidade)
      throw new Error('Intervalo inconsistente.');
    return Array.from(
      { length: 1000 },
      (_, i) => prefix + String(start + i).padStart(7, '0'),
    );
  }
  // Swagger declares an array; the manual example incorrectly uses a string.
  if (
    !Array.isArray(raw.numeracoesReceita) ||
    !raw.numeracoesReceita.length ||
    raw.numeracoesReceita.length > input.quantidade! ||
    !raw.numeracoesReceita.every(
      (n) => typeof n === 'string' && pattern.test(n),
    ) ||
    new Set(raw.numeracoesReceita).size !== raw.numeracoesReceita.length ||
    !Number.isInteger(raw.saldoReceitas) ||
    Number(raw.saldoReceitas) < 0
  )
    throw new Error('Contrato de numeração divergente.');
  return raw.numeracoesReceita as string[];
}
