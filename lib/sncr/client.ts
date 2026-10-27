import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../supabase/server.ts';
import {
  parsePrescriptionText,
  type PrescriptionModality,
} from '../document-fields.ts';

export type SncrEnvironment = 'prd' | 'hmg';

export type CouncilRegistration = {
  conselho: string;
  documento: string;
  uf: string;
};

export type SncrControlledModality = Exclude<PrescriptionModality, 'simples'>;

export type SncrBatch = {
  id: string;
  modality: SncrControlledModality;
  label: string;
  inicio: string;
  fim: string;
  numbers: string[];
  createdAt: string;
};

export type SncrBatchSummary = {
  id: string;
  modality: SncrControlledModality;
  label: string;
  inicio: string;
  fim: string;
  total: number;
  used: number;
  remaining: number;
  nextNumber: string | null;
  createdAt: string;
};

export type SncrAllocationResult = {
  number: string;
  source: 'batch' | 'api' | 'pool';
  remainingInPool: number;
  saldoReceitas?: number;
  message?: string;
};

const VALID_UFS = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO',
  'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI',
  'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]);

/**
 * Extrai conselho (padrão CRM), número de inscrição (apenas dígitos) e UF
 * a partir do campo livre `physician_registration` (ex.: "CRM 164119 SP · RQE 72731",
 * "Psiquiatra · CRM 164119 · RQE 72731", "CRM/SP 164.119").
 * Caso a UF não esteja explícita no texto do registro, utiliza `fallbackUf` (ou `ANVISA_SNCR_UF`, padrão 'SP').
 */
export function extractCouncilRegistration(
  rawRegistration: string,
  fallbackUf?: string
): CouncilRegistration | null {
  const cleaned = (rawRegistration || '').toUpperCase().trim();
  if (!cleaned) return null;

  // Corta antes de RQE para não confundir o número do RQE (ex.: RQE 72731) com o CRM
  const beforeRqe = cleaned.split(/\bRQE\b/)[0] || cleaned;

  const councilMatch = beforeRqe.match(/\b(CRM|CRO|CRMV|CRF|COREN)\b/);
  const conselho = councilMatch ? councilMatch[1] : 'CRM';

  // Procura sigla de UF válida como token isolado (ex: CRM/SP, CRM-SP, 164119 SP)
  let uf = '';
  const ufTokens = beforeRqe.match(/\b([A-Z]{2})\b/g) || [];
  for (const token of ufTokens) {
    if (token !== conselho && VALID_UFS.has(token)) {
      uf = token;
      break;
    }
  }
  if (!uf) {
    const candidateFallback = (
      fallbackUf ??
      process.env.ANVISA_SNCR_UF ??
      'SP'
    )
      .toUpperCase()
      .trim();
    if (VALID_UFS.has(candidateFallback)) {
      uf = candidateFallback;
    }
  }

  // Extrai o primeiro bloco numérico (permitindo ponto de milhar como 164.119)
  const numMatch = beforeRqe.match(/\b(\d{1,3}(?:\.\d{3})+|\d{3,10})\b/);
  const documento = numMatch ? numMatch[1].replace(/\D/g, '') : '';

  if (!documento || !uf) return null;
  return { conselho, documento, uf };
}

/**
 * Expande um intervalo retornado pelo endpoint de Receita Branca (RCE / RET) da Anvisa,
 * por exemplo: inicio = "2602.6-53.0000001", fim = "2602.6-53.0000999".
 */
export function expandSncrRange(
  inicio: string,
  fim: string,
  maxItems = 200
): string[] {
  const startTrimmed = (inicio || '').trim();
  const endTrimmed = (fim || '').trim();
  if (!startTrimmed) return [];
  if (!endTrimmed || startTrimmed === endTrimmed) return [startTrimmed];

  const startMatch = startTrimmed.match(/^(.*?)(\d+)$/);
  const endMatch = endTrimmed.match(/^(.*?)(\d+)$/);
  if (!startMatch || !endMatch || startMatch[1] !== endMatch[1]) {
    return [startTrimmed];
  }

  const prefix = startMatch[1];
  const width = startMatch[2].length;
  const startNum = Number.parseInt(startMatch[2], 10);
  const endNum = Number.parseInt(endMatch[2], 10);
  if (
    !Number.isFinite(startNum) ||
    !Number.isFinite(endNum) ||
    endNum < startNum
  ) {
    return [startTrimmed];
  }

  const count = Math.min(endNum - startNum + 1, maxItems);
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(`${prefix}${String(startNum + i).padStart(width, '0')}`);
  }
  return result;
}

/**
 * Normaliza o campo `numeracoesReceita` do endpoint `/notificacao-receita`,
 * que na especificação da Anvisa pode vir como `string[]` ou como string
 * formatada `"[2411.1-00.0000001, 2411.1-00.0000002]"`.
 */
export function parseNotificacaoNumbers(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => parseNotificacaoNumbers(item));
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
    return trimmed
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return [];
}

/**
 * Interpreta um lote SNCR informado pelo médico (seja por faixa `inicio` → `fim`,
 * seja por lista colada separada por quebras de linha, vírgulas ou ponto-e-vírgula).
 */
export function parseSncrBatchInput(params: {
  inicio?: string;
  fim?: string;
  rawList?: string;
  maxItems?: number;
}): { numbers: string[]; inicio: string; fim: string } {
  const max = params.maxItems ?? 1000;
  const rawList = (params.rawList || '').trim();

  if (rawList) {
    // Permite colar uma lista ou até mesmo uma faixa do tipo "2602.6-53.0000001 a 2602.6-53.0000100"
    const rangeInList = rawList.match(
      /^([^\s,;]+)\s+(?:a|até|ate|-|–|—)\s+([^\s,;]+)$/i
    );
    if (rangeInList) {
      const expanded = expandSncrRange(rangeInList[1], rangeInList[2], max);
      return {
        numbers: expanded,
        inicio: expanded[0] || '',
        fim: expanded[expanded.length - 1] || '',
      };
    }

    const tokens = rawList
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(/[\r\n,;]+/)
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length >= 3 && s.length <= 60 && /\d/.test(s));

    const unique = Array.from(new Set(tokens)).slice(0, max);
    return {
      numbers: unique,
      inicio: unique[0] || '',
      fim: unique[unique.length - 1] || '',
    };
  }

  const inicio = (params.inicio || '').trim();
  const fim = (params.fim || '').trim() || inicio;
  if (!inicio) {
    return { numbers: [], inicio: '', fim: '' };
  }

  const expanded = expandSncrRange(inicio, fim, max);
  return {
    numbers: expanded,
    inicio: expanded[0] || '',
    fim: expanded[expanded.length - 1] || '',
  };
}

export function isSncrConfigured(): boolean {
  return Boolean(
    process.env.ANVISA_SNCR_CLIENT_ID?.trim() &&
      process.env.ANVISA_SNCR_CLIENT_SECRET?.trim()
  );
}

export function getSncrEnvironment(): SncrEnvironment {
  return process.env.ANVISA_SNCR_ENV?.trim().toLowerCase() === 'hmg'
    ? 'hmg'
    : 'prd';
}

function getUrls() {
  const env = getSncrEnvironment();
  const baseUrl = (
    process.env.ANVISA_SNCR_BASE_URL?.trim() ||
    (env === 'hmg'
      ? 'https://api-gateway.hmg.apps.anvisa.gov.br/api-sncr'
      : 'https://api-gateway.prd.apps.anvisa.gov.br/api-sncr')
  ).replace(/\/+$/, '');

  const tokenUrl =
    process.env.ANVISA_SNCR_TOKEN_URL?.trim() ||
    (env === 'hmg'
      ? 'https://acesso.hmg.apps.anvisa.gov.br/auth/realms/externo/protocol/openid-connect/token'
      : 'https://acesso.prd.apps.anvisa.gov.br/auth/realms/externo/protocol/openid-connect/token');

  return { env, baseUrl, tokenUrl };
}

export class SncrService {
  private tokenCache: { accessToken: string; expiresAt: number } | null = null;
  // Pool em memória por chave `${clinicId}:${conselho}:${uf}:${documento}:${sncrKind}`
  private numberPools = new Map<string, string[]>();
  private fetchImpl: typeof fetch;

  constructor(customFetch?: typeof fetch) {
    this.fetchImpl = customFetch || globalThis.fetch;
  }

  /**
   * Obtém Bearer token via OAuth2 Client Credentials no Keycloak da Anvisa.
   */
  async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 15_000) {
      return this.tokenCache.accessToken;
    }

    const clientId = process.env.ANVISA_SNCR_CLIENT_ID?.trim();
    const clientSecret = process.env.ANVISA_SNCR_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new HttpError(
        503,
        'Credenciais do SNCR da Anvisa (ANVISA_SNCR_CLIENT_ID / ANVISA_SNCR_CLIENT_SECRET) não configuradas neste servidor.'
      );
    }

    const { tokenUrl } = getUrls();
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    const res = await this.fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new HttpError(
        502,
        `Falha ao autenticar no Keycloak da Anvisa (SNCR HTTP ${res.status}): ${
          errText.slice(0, 180) || 'verifique Client ID e Client Secret.'
        }`
      );
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new HttpError(
        502,
        'Resposta de autenticação da Anvisa não retornou access_token.'
      );
    }

    const expiresInSec = Number(data.expires_in) || 300;
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresInSec * 1000,
    };
    return data.access_token;
  }

  /**
   * Busca no banco todos os números SNCR já utilizados em receitas da clínica
   * ou já alocados em rascunhos, evitando reutilização de numeração dentro do mesmo lote.
   */
  private async getUsedNumbers(
    db: SupabaseClient,
    clinicId: string
  ): Promise<Set<string>> {
    const used = new Set<string>();
    const { data } = await db
      .from('clinical_documents')
      .select('text')
      .eq('clinic_id', clinicId)
      .eq('kind', 'Receita')
      .limit(1000);

    if (Array.isArray(data)) {
      for (const row of data) {
        if (typeof row?.text === 'string') {
          const parsed = parsePrescriptionText(row.text);
          if (parsed.sncrNumber) used.add(parsed.sncrNumber);
        }
      }
    }

    try {
      const { data: allocatedEvents } = await db
        .from('audit_events')
        .select('action, entity_id')
        .eq('clinic_id', clinicId)
        .eq('entity_type', 'sncr_numbering')
        .limit(1000);

      if (Array.isArray(allocatedEvents)) {
        for (const ev of allocatedEvents) {
          if (
            ev?.action === 'sncr.number_allocated' &&
            typeof ev?.entity_id === 'string' &&
            ev.entity_id.trim()
          ) {
            used.add(ev.entity_id.trim());
          }
        }
      }
    } catch {
      // Ignora em mocks que não implementam audit_events
    }

    return used;
  }

  /**
   * Retorna os lotes SNCR cadastrados localmente pela clínica (armazenados em audit_events).
   */
  private async listRawBatches(
    db: SupabaseClient,
    clinicId: string
  ): Promise<SncrBatch[]> {
    try {
      const { data } = await db
        .from('audit_events')
        .select('id, action, entity_id, context, occurred_at')
        .eq('clinic_id', clinicId)
        .eq('entity_type', 'sncr_batch')
        .limit(500);

      if (!Array.isArray(data) || !data.length) return [];

      // Ordena cronologicamente (do mais antigo para o mais recente) para respeitar exclusões e FIFO
      const sorted = [...data].sort((a, b) => {
        const idA = Number(a?.id) || 0;
        const idB = Number(b?.id) || 0;
        if (idA && idB) return idA - idB;
        return String(a?.occurred_at || '').localeCompare(
          String(b?.occurred_at || '')
        );
      });

      const byId = new Map<string, SncrBatch>();
      for (const row of sorted) {
        const entityId =
          typeof row?.entity_id === 'string' ? row.entity_id : '';
        if (!entityId) continue;

        if (row?.action === 'sncr.batch_deleted') {
          byId.delete(entityId);
          continue;
        }

        if (row?.action === 'sncr.batch_registered' && row.context) {
          const ctx = row.context as Record<string, unknown>;
          const modality = ctx.modality as SncrControlledModality;
          const numbers = Array.isArray(ctx.numbers)
            ? ctx.numbers.filter((n): n is string => typeof n === 'string')
            : [];
          if (!modality || !numbers.length) continue;

          byId.set(entityId, {
            id: entityId,
            modality,
            label:
              typeof ctx.label === 'string' && ctx.label.trim()
                ? ctx.label.trim()
                : `${ numbers[0] } → ${ numbers[numbers.length - 1] }`,
            inicio:
              typeof ctx.inicio === 'string' ? ctx.inicio : numbers[0] || '',
            fim:
              typeof ctx.fim === 'string'
                ? ctx.fim
                : numbers[numbers.length - 1] || '',
            numbers,
            createdAt:
              typeof ctx.createdAt === 'string'
                ? ctx.createdAt
                : typeof row.occurred_at === 'string'
                  ? row.occurred_at
                  : new Date().toISOString(),
          });
        }
      }

      return Array.from(byId.values());
    } catch {
      return [];
    }
  }

  /**
   * Lista os lotes SNCR cadastrados pela clínica com o cálculo atualizado de números
   * usados, restantes e próximo número disponível da fila.
   */
  async listBatches(
    db: SupabaseClient,
    clinicId: string
  ): Promise<SncrBatchSummary[]> {
    const [batches, usedNumbers] = await Promise.all([
      this.listRawBatches(db, clinicId),
      this.getUsedNumbers(db, clinicId),
    ]);

    return batches.map((b) => {
      const available = b.numbers.filter((n) => !usedNumbers.has(n));
      return {
        id: b.id,
        modality: b.modality,
        label: b.label,
        inicio: b.inicio,
        fim: b.fim,
        total: b.numbers.length,
        used: b.numbers.length - available.length,
        remaining: available.length,
        nextNumber: available[0] || null,
        createdAt: b.createdAt,
      };
    });
  }

  /**
   * Cadastra um novo lote de números SNCR obtido pelo médico no portal da Anvisa,
   * permitindo puxar automaticamente o próximo número sem precisar de e-CNPJ.
   */
  async registerBatch(params: {
    db: SupabaseClient;
    clinicId: string;
    userId: string;
    modality: PrescriptionModality;
    label?: string;
    inicio?: string;
    fim?: string;
    rawList?: string;
  }): Promise<SncrBatchSummary> {
    if (params.modality === 'simples') {
      throw new HttpError(
        422,
        'Receitas simples não utilizam lotes de numeração do SNCR.'
      );
    }

    const parsed = parseSncrBatchInput({
      inicio: params.inicio,
      fim: params.fim,
      rawList: params.rawList,
      maxItems: 1000,
    });

    if (!parsed.numbers.length) {
      throw new HttpError(
        422,
        'Informe a faixa (nº inicial e nº final) ou cole a lista de números do lote SNCR.'
      );
    }

    const batchId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const cleanLabel =
      (params.label || '').trim().slice(0, 80) ||
      `${parsed.inicio}${parsed.fim !== parsed.inicio ? ` → ${parsed.fim}` : ''}`;

    const { error } = await params.db.from('audit_events').insert({
      clinic_id: params.clinicId,
      actor_id: params.userId,
      action: 'sncr.batch_registered',
      entity_type: 'sncr_batch',
      entity_id: batchId,
      context: {
        id: batchId,
        modality: params.modality,
        label: cleanLabel,
        inicio: parsed.inicio,
        fim: parsed.fim,
        numbers: parsed.numbers,
        total: parsed.numbers.length,
        createdAt,
      },
    });

    if (error) {
      throw new HttpError(
        500,
        `Falha ao salvar lote SNCR: ${error.message}`
      );
    }

    const usedNumbers = await this.getUsedNumbers(params.db, params.clinicId);
    const available = parsed.numbers.filter((n) => !usedNumbers.has(n));

    return {
      id: batchId,
      modality: params.modality,
      label: cleanLabel,
      inicio: parsed.inicio,
      fim: parsed.fim,
      total: parsed.numbers.length,
      used: parsed.numbers.length - available.length,
      remaining: available.length,
      nextNumber: available[0] || null,
      createdAt,
    };
  }

  /**
   * Remove um lote SNCR cadastrado localmente.
   */
  async deleteBatch(params: {
    db: SupabaseClient;
    clinicId: string;
    userId: string;
    batchId: string;
  }): Promise<void> {
    const cleanId = (params.batchId || '').trim();
    if (!cleanId) {
      throw new HttpError(422, 'Identificador do lote inválido.');
    }

    const { error } = await params.db.from('audit_events').insert({
      clinic_id: params.clinicId,
      actor_id: params.userId,
      action: 'sncr.batch_deleted',
      entity_type: 'sncr_batch',
      entity_id: cleanId,
      context: { deletedAt: new Date().toISOString() },
    });

    if (error) {
      throw new HttpError(
        500,
        `Falha ao remover lote SNCR: ${error.message}`
      );
    }
  }

  /**
   * Verifica se há algum lote local com números disponíveis ou se a API SNCR está configurada.
   */
  async hasAvailableNumbering(
    db: SupabaseClient,
    clinicId: string,
    modality: PrescriptionModality
  ): Promise<boolean> {
    if (modality === 'simples') return false;
    if (isSncrConfigured()) return true;
    const summaries = await this.listBatches(db, clinicId);
    return summaries.some((b) => b.modality === modality && b.remaining > 0);
  }

  /**
   * Aloca um número oficial do SNCR para a prescrição de acordo com a modalidade:
   * 1. Prioriza os lotes SNCR cadastrados localmente pela clínica (sem exigir e-CNPJ);
   * 2. Caso não haja lote local disponível, consulta o pool/API do SNCR da Anvisa:
   *    - `controle_especial` -> `RCE` (`/api/v1/numeracoes/receita-especial-retencao`)
   *    - `retencao` -> `RET` (`/api/v1/numeracoes/receita-especial-retencao`)
   *    - `notificacao_b` -> `NRB` (`/api/v1/numeracoes/notificacao-receita`)
   *    - `notificacao_a` -> `NRA` (`/api/v1/numeracoes/notificacao-receita`)
   */
  async allocateForPrescription(params: {
    db?: SupabaseClient;
    clinicId: string;
    modality: PrescriptionModality;
    physicianRegistration: string;
  }): Promise<SncrAllocationResult> {
    if (params.modality === 'simples') {
      throw new HttpError(
        422,
        'Receitas simples sem retenção não utilizam numeração do SNCR.'
      );
    }

    const usedNumbers = params.db
      ? await this.getUsedNumbers(params.db, params.clinicId)
      : new Set<string>();

    // 1. Tenta alocar a partir de lote SNCR cadastrado localmente (não exige e-CNPJ nem API da Anvisa)
    if (params.db) {
      const batches = await this.listRawBatches(params.db, params.clinicId);
      const matchingNumbers = batches
        .filter((b) => b.modality === params.modality)
        .flatMap((b) => b.numbers)
        .filter((n) => !usedNumbers.has(n));

      const uniqueAvailable = Array.from(new Set(matchingNumbers));
      if (uniqueAvailable.length > 0) {
        const [nextNumber, ...rest] = uniqueAvailable;
        return {
          number: nextNumber,
          source: 'batch',
          remainingInPool: rest.length,
          saldoReceitas: rest.length,
        };
      }
    }

    if (!isSncrConfigured()) {
      throw new HttpError(
        422,
        'Nenhum número disponível no seu estoque de lotes SNCR para esta modalidade. Clique em "Lotes SNCR" para cadastrar a faixa de números obtida no portal sncr.anvisa.gov.br.'
      );
    }

    const reg = extractCouncilRegistration(params.physicianRegistration);
    if (!reg) {
      throw new HttpError(
        422,
        'Informe o número do CRM e a sigla da UF no campo "CRM/UF e RQE" (ex.: CRM 123456 SP) para solicitar numeração ao SNCR da Anvisa.'
      );
    }

    const poolKey = `${params.clinicId}:${reg.conselho}:${reg.uf}:${reg.documento}:${params.modality}`;
    const existingPool = (this.numberPools.get(poolKey) || []).filter(
      (n) => !usedNumbers.has(n)
    );

    if (existingPool.length > 0) {
      const [nextNumber, ...rest] = existingPool;
      this.numberPools.set(poolKey, rest);
      return {
        number: nextNumber,
        source: 'pool',
        remainingInPool: rest.length,
      };
    }

    const token = await this.getAccessToken();
    const { baseUrl } = getUrls();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const jws = process.env.ANVISA_SNCR_JWS_INTEGRADORA?.trim();
    if (jws) {
      headers['X-Jws-Integradora'] = jws;
    }

    // Caso 1: Receita Branca (RCE = Controle Especial C1/C5 | RET = Sujeita a Retenção)
    if (
      params.modality === 'controle_especial' ||
      params.modality === 'retencao'
    ) {
      const cnpj = (process.env.ANVISA_SNCR_CNPJ || '').replace(/\D/g, '');
      if (cnpj.length !== 14) {
        throw new HttpError(
          422,
          'Configure o CNPJ da clínica/instituição em ANVISA_SNCR_CNPJ (14 dígitos) para gerar numeração de Receita de Controle Especial / Retenção no SNCR.'
        );
      }

      const tipo = params.modality === 'controle_especial' ? 'RCE' : 'RET';
      const res = await this.fetchImpl(
        `${baseUrl}/api/v1/numeracoes/receita-especial-retencao`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            conselho: reg.conselho,
            tipo,
            documento: reg.documento,
            uf: reg.uf,
            cnpj,
          }),
        }
      );

      if (res.status === 204) {
        throw new HttpError(
          422,
          'O SNCR da Anvisa informou que não há numeração disponível para este prescritor no momento (HTTP 204).'
        );
      }

      if (!res.ok) {
        const errPayload = await res.json().catch(() => null);
        const msg =
          errPayload?.mensagem ||
          errPayload?.errorObject?.description ||
          `HTTP ${res.status}`;
        throw new HttpError(
          res.status === 400 ? 422 : 502,
          `SNCR Anvisa (${tipo}): ${msg}`
        );
      }

      const data = (await res.json()) as {
        inicio?: string;
        fim?: string;
        quantidade?: number;
        mensagem?: string;
      };
      const numbers = expandSncrRange(
        data.inicio || '',
        data.fim || ''
      ).filter((n) => !usedNumbers.has(n));

      if (!numbers.length) {
        throw new HttpError(
          502,
          'A API do SNCR não retornou numerações utilizáveis para esta receita.'
        );
      }

      const [first, ...rest] = numbers;
      this.numberPools.set(poolKey, rest);
      return {
        number: first,
        source: 'api',
        remainingInPool: rest.length,
        message: data.mensagem,
      };
    }

    // Caso 2: Notificação de Receita (NRA / NRB)
    const receitaCode = params.modality === 'notificacao_a' ? 'NRA' : 'NRB';
    const res = await this.fetchImpl(
      `${baseUrl}/api/v1/numeracoes/notificacao-receita`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          receita: receitaCode,
          conselho: reg.conselho,
          uf: reg.uf,
          documento: reg.documento,
          quantidade: 10,
        }),
      }
    );

    if (res.status === 204) {
      throw new HttpError(
        422,
        `Nenhuma numeração de Notificação (${receitaCode}) disponível no SNCR para ${reg.conselho} ${reg.documento}/${reg.uf}. Verifique sua concessão ativa no portal sncr.anvisa.gov.br.`
      );
    }

    if (!res.ok) {
      const errPayload = await res.json().catch(() => null);
      const firstArrayErr = Array.isArray(errPayload) ? errPayload[0] : null;
      const msg =
        firstArrayErr?.mensagem ||
        errPayload?.mensagem ||
        errPayload?.errorObject?.description ||
        `HTTP ${res.status}`;
      throw new HttpError(
        res.status === 400 ? 422 : 502,
        `SNCR Anvisa (${receitaCode}): ${msg}`
      );
    }

    const data = (await res.json()) as {
      numeracoesReceita?: unknown;
      saldoReceitas?: number;
      mensagem?: string;
    };
    const numbers = parseNotificacaoNumbers(data.numeracoesReceita).filter(
      (n) => !usedNumbers.has(n)
    );

    if (!numbers.length) {
      throw new HttpError(
        502,
        `O SNCR não retornou números válidos para a Notificação (${receitaCode}).`
      );
    }

    const [first, ...rest] = numbers;
    this.numberPools.set(poolKey, rest);
    return {
      number: first,
      source: 'api',
      remainingInPool: rest.length,
      saldoReceitas: data.saldoReceitas,
      message: data.mensagem,
    };
  }
}

export const sncrService = new SncrService();
