// Lote 6F.2D (A1): obtenção de evidência de revogação (LCR/OCSP) na rede.
//
// Este módulo só BUSCA bytes. Quem decide é o revocation-validator: toda LCR/OCSP baixada entra
// como evidência injetada e passa pela mesma validação (assinatura, emissor, frescor) que a
// evidência fornecida pelo chamador. Falha de rede ou resposta ruim só deixa a evidência faltando,
// e o resultado fica INDETERMINATE/TRY_LATER, nunca GOOD.
//
// Proteções (CORRECAO-6F2C-R.md, Fase 3):
// - endereços só de CDP/AIA de certificados de uma cadeia já validada até uma raiz ICP-Brasil
//   oficial (icp-brasil-certs.ts);
// - qualquer host do CDP/AIA dessa cadeia, salvo nomes internos e a lista de bloqueio opcional
//   (PSYWRITE_REVOCATION_BLOCKED_HOSTS); só http/https, portas 80/443, sem credenciais nem IP;
// - DNS resolvido aqui, com recusa de IP privado, loopback, link-local, CGNAT, metadados de
//   nuvem e afins; a conexão usa o IP conferido (sem nova resolução, contra DNS rebinding);
// - redirecionamento manual, no máximo 2, cada destino conferido de novo;
// - limite de tamanho e de tempo por requisição e prazo total por coleta;
// - cache em memória até nextUpdate (com teto), guardando só os bytes e a validade.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

import { ICP_BRASIL_ROOTS } from './icp-brasil-certs.ts';
import type { ParsedX509Node } from './icp-chain.ts';
import {
  extractCertCrlDistributionPointUris,
  parseCrlDer,
} from './revocation-validator.ts';
import type {
  CollectedRevocationEvidence,
  PadesVerificationOptions,
  RevocationEvidenceProvider,
  RevocationFetchAttempt,
} from './types.ts';

try {
  pkijs.setEngine(
    'NodeJS',
    new pkijs.CryptoEngine({ name: 'NodeJS', crypto: globalThis.crypto }),
  );
} catch {
  // Engine já inicializado
}

const OID_AUTHORITY_INFO_ACCESS = '1.3.6.1.5.5.7.1.1';
const OID_AD_OCSP = '1.3.6.1.5.5.7.48.1';

/**
 * Nomes que nunca são consultados, qualquer que seja o certificado: rede interna por convenção.
 * O bloqueio de IP após o DNS continua sendo a proteção principal.
 */
const INTERNAL_HOST_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home.arpa',
];

export interface RevocationFetchPolicy {
  /**
   * Restrição opcional de hosts. Ausente (padrão), vale qualquer host que conste no CDP/AIA de
   * um certificado cuja cadeia já foi validada até uma raiz ICP-Brasil oficial.
   */
  allowedHostSuffixes?: readonly string[];
  /** Hosts nunca consultados (PSYWRITE_REVOCATION_BLOCKED_HOSTS, separados por vírgula). */
  blockedHostSuffixes: readonly string[];
  allowedPorts: readonly number[];
  maxCrlBytes: number;
  maxOcspBytes: number;
  /** Tempo por requisição OCSP (resposta de poucos KB). */
  requestTimeoutMs: number;
  /** Tempo por requisição de LCR (podem ter centenas de KB a alguns MB). */
  crlRequestTimeoutMs: number;
  /** Prazo total de uma coleta (todas as requisições da cadeia). */
  collectTimeoutMs: number;
  maxRedirects: number;
  maxUrlsPerCertificate: number;
  /** Teto do cache, mesmo quando nextUpdate é mais distante. */
  maxCacheSeconds: number;
  /** Cache de OCSP sem nextUpdate. */
  ocspWithoutNextUpdateCacheSeconds: number;
}

export function defaultRevocationFetchPolicy(
  env: Record<string, string | undefined> = process.env,
): RevocationFetchPolicy {
  const blocked = (env.PSYWRITE_REVOCATION_BLOCKED_HOSTS || '')
    .split(',')
    .map((h) => normalizeHost(h))
    .filter((h): h is string => Boolean(h));
  return {
    blockedHostSuffixes: blocked,
    allowedPorts: [80, 443],
    // 4 MB acompanha CRL_MAX_ASN1_NODES (~9 bytes por elemento numa LCR real); acima disso a
    // análise passaria de ~600 MB de heap numa função serverless.
    maxCrlBytes: 4 * 1024 * 1024,
    maxOcspBytes: 64 * 1024,
    requestTimeoutMs: 4000,
    crlRequestTimeoutMs: 10000,
    collectTimeoutMs: 15000,
    maxRedirects: 2,
    maxUrlsPerCertificate: 3,
    maxCacheSeconds: 6 * 60 * 60,
    ocspWithoutNextUpdateCacheSeconds: 5 * 60,
  };
}

function normalizeHost(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  return h && /^[a-z0-9.-]+$/.test(h) && !h.startsWith('.') ? h : null;
}

// ---------------------------------------------------------------------------------------------
// Política de URL e de endereço

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkRevocationUrl(
  raw: string,
  policy: Pick<
    RevocationFetchPolicy,
    'allowedHostSuffixes' | 'blockedHostSuffixes' | 'allowedPorts'
  >,
  base?: URL,
): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return { ok: false, reason: 'URL inválida' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: `esquema não permitido (${url.protocol})` };
  if (url.username || url.password)
    return { ok: false, reason: 'credenciais na URL' };
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;
  if (!policy.allowedPorts.includes(port))
    return { ok: false, reason: `porta não permitida (${port})` };
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return { ok: false, reason: 'IP literal na URL' };
  const host = normalizeHost(bare);
  if (!host) return { ok: false, reason: 'host inválido' };
  const under = (suffixes: readonly string[]) =>
    suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!host.includes('.') || under(INTERNAL_HOST_SUFFIXES))
    return { ok: false, reason: `host interno (${host})` };
  if (under(policy.blockedHostSuffixes))
    return { ok: false, reason: `host bloqueado (${host})` };
  if (policy.allowedHostSuffixes && !under(policy.allowedHostSuffixes))
    return { ok: false, reason: `host fora da lista (${host})` };
  return { ok: true, url };
}

const blockedAddresses = (() => {
  const list = new net.BlockList();
  for (const [prefix, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // CGNAT (inclui metadados de alguns provedores)
    ['127.0.0.0', 8],
    ['169.254.0.0', 16], // link-local e metadados de nuvem (169.254.169.254)
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    list.addSubnet(prefix, bits, 'ipv4');
  for (const [prefix, bits] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7], // ULA (inclui fd00:ec2::254)
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const)
    list.addSubnet(prefix, bits, 'ipv6');
  return list;
})();

/**
 * Endereço roteável na internet pública? O BlockList do Node confere IPv4 mapeado em IPv6
 * (::ffff:a.b.c.d e ::ffff:xxxx:yyyy) contra as regras IPv4.
 */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// ---------------------------------------------------------------------------------------------
// Transporte HTTP

export interface RevocationHttpRequest {
  url: URL;
  method: 'GET' | 'POST';
  body?: Buffer;
  contentType?: string;
  accept: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RevocationHttpResponse {
  status: number;
  location?: string;
  /** Content-Encoding recebido; nada é pedido comprimido (sem Accept-Encoding). */
  contentEncoding?: string;
  body: Buffer;
}

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${+(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
const tooLarge = (max: number) =>
  new Error(`resposta excede ${sizeLabel(max)}`);

export type RevocationTransport = (
  request: RevocationHttpRequest,
) => Promise<RevocationHttpResponse>;

export type AddressResolver = (
  host: string,
) => Promise<Array<{ address: string; family: number }>>;

const systemResolver: AddressResolver = (host) =>
  dns.promises.lookup(host, { all: true, order: 'verbatim' });

/**
 * Transporte padrão (node:http/https). Resolve o host, exige que TODOS os endereços sejam
 * públicos e conecta no primeiro, sem nova resolução. Sem agente compartilhado, cookies ou
 * credenciais; o corpo é cortado ao passar de `maxBytes`.
 */
export function createNodeRevocationTransport(
  deps: {
    resolve?: AddressResolver;
    isAddressAllowed?: (address: string) => boolean;
  } = {},
): RevocationTransport {
  const resolve = deps.resolve ?? systemResolver;
  const isAllowed = deps.isAddressAllowed ?? isPublicAddress;
  return async (req) => {
    const host = req.url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await withTimeout(
      resolve(host),
      req.timeoutMs,
      req.signal,
      'DNS',
    );
    if (addresses.length === 0) throw new Error('DNS sem endereço');
    const refused = addresses.find((a) => !isAllowed(a.address));
    if (refused) throw new Error(`endereço não permitido (${refused.address})`);
    const pinned = addresses[0];
    const lib = req.url.protocol === 'https:' ? https : http;

    return new Promise<RevocationHttpResponse>((resolvePromise, reject) => {
      let settled = false;
      const finish = (err: Error | null, value?: RevocationHttpResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolvePromise(value!);
      };
      const outgoing = lib.request(
        req.url,
        {
          method: req.method,
          agent: false,
          headers: {
            Accept: req.accept,
            'User-Agent': 'PsyWrite-Revocation/1',
            ...(req.body
              ? {
                  'Content-Type': req.contentType ?? 'application/octet-stream',
                  'Content-Length': String(req.body.length),
                }
              : {}),
          },
          lookup: (_hostname, options, callback) => {
            // Node pode pedir todos os endereços (autoSelectFamily); entrega só o conferido.
            if ((options as { all?: boolean })?.all)
              (callback as (e: null, a: typeof addresses) => void)(null, [
                pinned,
              ]);
            else
              (callback as (e: null, a: string, f: number) => void)(
                null,
                pinned.address,
                pinned.family,
              );
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            finish(null, {
              status,
              location: res.headers.location,
              body: Buffer.alloc(0),
            });
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > req.maxBytes) {
            res.destroy();
            finish(tooLarge(req.maxBytes));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > req.maxBytes) {
              res.destroy();
              finish(tooLarge(req.maxBytes));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(null, {
              status,
              contentEncoding: res.headers['content-encoding'],
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', (e) => finish(e));
        },
      );
      const timer = setTimeout(() => {
        outgoing.destroy();
        finish(new Error(`tempo esgotado (${req.timeoutMs / 1000} s)`));
      }, req.timeoutMs);
      const onAbort = () => {
        outgoing.destroy();
        finish(new Error('prazo da coleta esgotado'));
      };
      if (req.signal?.aborted) onAbort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      outgoing.on('error', (e) => finish(e));
      outgoing.end(req.body);
    });
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: tempo esgotado`)),
          ms,
        );
        onAbort = () => reject(new Error('prazo da coleta esgotado'));
        if (signal?.aborted) onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------------------------
// Leitura mínima de LCR/OCSP (só para o cache; a validação de verdade é do revocation-validator)

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

const PEM_CRL =
  /^-----BEGIN X509 CRL-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END X509 CRL-----\s*$/;

/** DER da LCR; aceita também PEM ("X509 CRL"). Outros formatos são recusados com a causa. */
function crlDerFromBody(body: Buffer): Buffer | { error: string } {
  if (body.length > 0 && body[0] === 0x30) return body;
  const text = body.subarray(0, 64).toString('latin1');
  if (text.startsWith('-----BEGIN')) {
    const pem = body.toString('latin1').match(PEM_CRL);
    return pem
      ? Buffer.from(pem[1].replace(/\s+/g, ''), 'base64')
      : { error: 'formato: PEM que não é "X509 CRL"' };
  }
  if (body[0] === 0x1f && body[1] === 0x8b)
    return { error: 'formato: conteúdo gzip sem Content-Encoding' };
  if (/^\s*</.test(text)) return { error: 'formato: HTML em vez de LCR' };
  return { error: 'formato: não é LCR DER nem PEM' };
}

/**
 * Lê a validade da LCR com o mesmo analisador (e limites) do revocation-validator. A análise fica
 * em memória ligada ao Buffer devolvido, que é o mesmo entregue ao validador: uma análise só.
 */
function readCrlWindow(der: Buffer): { nextUpdate?: Date } | { error: string } {
  const parsed = parseCrlDer(der, der);
  if ('error' in parsed) return { error: `formato: ${parsed.error}` };
  return { nextUpdate: parsed.crl.nextUpdate?.value };
}

function readOcspWindow(
  der: Buffer,
): { successful: boolean; nextUpdate?: Date } | null {
  try {
    const asn1 = asn1js.fromBER(toArrayBuffer(der));
    if (asn1.offset === -1 || asn1.offset !== der.length) return null;
    const response = new pkijs.OCSPResponse({ schema: asn1.result });
    if (response.responseStatus.valueBlock.valueDec !== 0)
      return { successful: false };
    const inner = asn1js.fromBER(
      response.responseBytes!.response.valueBlock.valueHexView.slice()
        .buffer as ArrayBuffer,
    );
    const basic = new pkijs.BasicOCSPResponse({ schema: inner.result });
    const dates = basic.tbsResponseData.responses
      .map((r) => r.nextUpdate)
      .filter((d): d is Date => d instanceof Date);
    return {
      successful: true,
      nextUpdate: dates.length
        ? new Date(Math.min(...dates.map((d) => d.getTime())))
        : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Endereços de um certificado

export function revocationUrlsForCertificate(cert: pkijs.Certificate): {
  crl: string[];
  ocsp: string[];
} {
  const crl = extractCertCrlDistributionPointUris(cert).uris;
  const ocsp: string[] = [];
  const aia = cert.extensions?.find(
    (e) => e.extnID === OID_AUTHORITY_INFO_ACCESS,
  );
  try {
    const view = aia?.extnValue.valueBlock.valueHexView;
    if (view) {
      const parsed = new pkijs.InfoAccess({
        schema: asn1js.fromBER(view.slice().buffer as ArrayBuffer).result,
      });
      for (const d of parsed.accessDescriptions)
        if (
          d.accessMethod === OID_AD_OCSP &&
          d.accessLocation.type === 6 &&
          typeof d.accessLocation.value === 'string'
        )
          ocsp.push(d.accessLocation.value);
    }
  } catch {
    // AIA malformada: sem OCSP para este certificado.
  }
  return { crl: [...new Set(crl)], ocsp: [...new Set(ocsp)] };
}

async function buildOcspRequest(
  cert: pkijs.Certificate,
  issuer: pkijs.Certificate,
): Promise<Buffer> {
  const request = new pkijs.OCSPRequest();
  // SHA-1 no CertID: é o que os respondentes ICP-Brasil aceitam de forma geral (RFC 5019).
  await request.createForCertificate(cert, {
    hashAlgorithm: 'SHA-1',
    issuerCertificate: issuer,
  });
  return Buffer.from(request.toSchema(true).toBER(false));
}

// ---------------------------------------------------------------------------------------------
// Cache

export class RevocationEvidenceCache {
  private entries = new Map<string, { der: Buffer; expiresAt: number }>();
  private readonly maxEntries: number;
  constructor(maxEntries = 256) {
    this.maxEntries = maxEntries;
  }

  get(key: string, now: Date): Buffer | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now.getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.der;
  }

  set(key: string, der: Buffer, expiresAt: Date, now: Date): void {
    if (expiresAt.getTime() <= now.getTime()) return;
    this.entries.delete(key);
    this.entries.set(key, { der, expiresAt: expiresAt.getTime() });
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Coleta

export interface OnlineRevocationProviderOptions {
  transport?: RevocationTransport;
  policy?: Partial<RevocationFetchPolicy>;
  cache?: RevocationEvidenceCache;
  /**
   * Só para testes: aceita cadeia terminada em âncora que não é raiz ICP-Brasil oficial.
   * Em produção a coleta exige raiz de icp-brasil-certs.ts.
   */
  allowNonIcpBrasilAnchor?: boolean;
}

const icpRootDers = ICP_BRASIL_ROOTS.map((r) => Buffer.from(r.der, 'base64'));

export function createOnlineRevocationProvider(
  opts: OnlineRevocationProviderOptions = {},
): RevocationEvidenceProvider {
  const policy = { ...defaultRevocationFetchPolicy(), ...opts.policy };
  const transport = opts.transport ?? createNodeRevocationTransport();
  const cache = opts.cache ?? new RevocationEvidenceCache();

  async function fetchFollowingPolicy(
    rawUrl: string,
    base: Omit<RevocationHttpRequest, 'url'>,
  ): Promise<Buffer> {
    let check = checkRevocationUrl(rawUrl, policy);
    for (let hop = 0; ; hop += 1) {
      if (!check.ok) throw new Error(check.reason);
      const response = await transport({ ...base, url: check.url });
      if (response.status >= 300 && response.status < 400) {
        if (hop >= policy.maxRedirects)
          throw new Error('redirecionamentos demais');
        if (!response.location) throw new Error('redirecionamento sem destino');
        check = checkRevocationUrl(response.location, policy, check.url);
        continue;
      }
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const encoding = response.contentEncoding?.trim().toLowerCase();
      if (encoding && encoding !== 'identity')
        throw new Error(`formato: Content-Encoding ${encoding} não suportado`);
      if (response.body.length > base.maxBytes) throw tooLarge(base.maxBytes);
      return response.body;
    }
  }

  return {
    async collect(chain: ParsedX509Node[], context: { now: Date }) {
      const attempts: RevocationFetchAttempt[] = [];
      const crls: Buffer[] = [];
      const ocspResponses: Buffer[] = [];
      const evidence: CollectedRevocationEvidence[] = [];
      const anchor = chain[chain.length - 1];
      const anchoredInIcpBrasil =
        anchor !== undefined &&
        icpRootDers.some((der) => der.equals(anchor.der));
      if (
        chain.length < 2 ||
        (!anchoredInIcpBrasil && !opts.allowNonIcpBrasilAnchor)
      ) {
        attempts.push({
          kind: 'CHAIN',
          subject: chain[0]?.subject ?? '',
          outcome: 'SKIPPED',
          reason: 'cadeia não termina em raiz ICP-Brasil oficial',
        });
        return { crls, ocspResponses, attempts, evidence };
      }

      const controller = new AbortController();
      const deadline = setTimeout(
        () => controller.abort(),
        policy.collectTimeoutMs,
      );
      const inFlightCrl = new Map<string, Promise<Buffer | null>>();

      const getCrl = (url: string, subject: string) => {
        const key = `crl ${url}`;
        const cached = cache.get(key, context.now);
        if (cached) {
          attempts.push({ kind: 'CRL', url, subject, outcome: 'CACHED' });
          return Promise.resolve(cached);
        }
        if (!inFlightCrl.has(key))
          inFlightCrl.set(
            key,
            fetchFollowingPolicy(url, {
              method: 'GET',
              accept: 'application/pkix-crl, application/x-pkcs7-crl, */*',
              maxBytes: policy.maxCrlBytes,
              timeoutMs: policy.crlRequestTimeoutMs,
              signal: controller.signal,
            }).then(
              (body) => {
                const der = crlDerFromBody(body);
                const window = Buffer.isBuffer(der) ? readCrlWindow(der) : der;
                if (!Buffer.isBuffer(der) || 'error' in window) {
                  attempts.push({
                    kind: 'CRL',
                    url,
                    subject,
                    outcome: 'ERROR',
                    reason:
                      'error' in window ? window.error : 'formato inválido',
                  });
                  return null;
                }
                cache.set(
                  key,
                  der,
                  cacheUntil(
                    window.nextUpdate,
                    context.now,
                    policy.maxCacheSeconds,
                  ),
                  context.now,
                );
                attempts.push({
                  kind: 'CRL',
                  url,
                  subject,
                  outcome: 'FETCHED',
                });
                return der;
              },
              (e: Error) => {
                attempts.push({
                  kind: 'CRL',
                  url,
                  subject,
                  outcome: 'ERROR',
                  reason: e.message,
                });
                return null;
              },
            ),
          );
        return inFlightCrl.get(key)!;
      };

      const getOcsp = async (
        url: string,
        node: ParsedX509Node,
        issuer: ParsedX509Node,
      ): Promise<Buffer | null> => {
        const key = `ocsp ${url} ${issuer.fingerprint256} ${node.serialNumber}`;
        const cached = cache.get(key, context.now);
        if (cached) {
          attempts.push({
            kind: 'OCSP',
            url,
            subject: node.subject,
            outcome: 'CACHED',
          });
          return cached;
        }
        try {
          const der = await fetchFollowingPolicy(url, {
            method: 'POST',
            body: await buildOcspRequest(node.pkiCert, issuer.pkiCert),
            contentType: 'application/ocsp-request',
            accept: 'application/ocsp-response',
            maxBytes: policy.maxOcspBytes,
            timeoutMs: policy.requestTimeoutMs,
            signal: controller.signal,
          });
          const window = readOcspWindow(der);
          if (!window?.successful) {
            attempts.push({
              kind: 'OCSP',
              url,
              subject: node.subject,
              outcome: 'ERROR',
              reason: window ? 'OCSP sem sucesso' : 'OCSP ilegível',
            });
            return null;
          }
          cache.set(
            key,
            der,
            window.nextUpdate
              ? cacheUntil(
                  window.nextUpdate,
                  context.now,
                  policy.maxCacheSeconds,
                )
              : new Date(
                  context.now.getTime() +
                    policy.ocspWithoutNextUpdateCacheSeconds * 1000,
                ),
            context.now,
          );
          attempts.push({
            kind: 'OCSP',
            url,
            subject: node.subject,
            outcome: 'FETCHED',
          });
          return der;
        } catch (e) {
          attempts.push({
            kind: 'OCSP',
            url,
            subject: node.subject,
            outcome: 'ERROR',
            reason: (e as Error).message,
          });
          return null;
        }
      };

      try {
        // A âncora (último nó) não tem revogação por política; cada certificado é conferido
        // com o seu emissor, o nó seguinte da cadeia.
        await Promise.all(
          chain.slice(0, -1).map(async (node, i) => {
            const issuer = chain[i + 1];
            const urls = revocationUrlsForCertificate(node.pkiCert);
            for (const url of urls.ocsp.slice(
              0,
              policy.maxUrlsPerCertificate,
            )) {
              const der = await getOcsp(url, node, issuer);
              if (der) {
                ocspResponses.push(der);
                evidence.push({
                  kind: 'OCSP',
                  der,
                  url,
                  certificate: node,
                  chainPosition: i,
                });
                return;
              }
            }
            for (const url of urls.crl.slice(0, policy.maxUrlsPerCertificate)) {
              const der = await getCrl(url, node.subject);
              if (der) {
                if (!crls.includes(der)) crls.push(der);
                evidence.push({
                  kind: 'CRL',
                  der,
                  url,
                  certificate: node,
                  chainPosition: i,
                });
                return;
              }
            }
            if (urls.ocsp.length === 0 && urls.crl.length === 0)
              attempts.push({
                kind: 'CHAIN',
                subject: node.subject,
                outcome: 'SKIPPED',
                reason: 'certificado sem CDP/OCSP',
              });
          }),
        );
      } finally {
        clearTimeout(deadline);
      }
      return { crls, ocspResponses, attempts, evidence };
    },
  };
}

function cacheUntil(
  nextUpdate: Date | undefined,
  now: Date,
  maxSeconds: number,
): Date {
  const cap = now.getTime() + maxSeconds * 1000;
  return new Date(
    nextUpdate ? Math.min(nextUpdate.getTime(), cap) : now.getTime(),
  );
}

/**
 * Acrescenta às opções a evidência obtida pelo provedor para `chain`. Nunca lança: qualquer
 * falha devolve as opções originais (a evidência só fica faltando).
 */
export async function withOnlineRevocationEvidence(
  options: PadesVerificationOptions,
  chain: ParsedX509Node[],
  now: Date,
  chainKind: 'SIGNER' | 'TSA',
): Promise<PadesVerificationOptions> {
  const provider = options.revocationEvidenceProvider;
  if (!provider) return options;
  try {
    const found = await provider.collect(chain, { now });
    options.onRevocationFetch?.(found.attempts);
    if (found.evidence?.length)
      options.onRevocationEvidence?.(chainKind, found.evidence);
    if (found.crls.length === 0 && found.ocspResponses.length === 0)
      return options;
    return {
      ...options,
      crls: [...(options.crls || []), ...found.crls],
      ocspResponses: [...(options.ocspResponses || []), ...found.ocspResponses],
    };
  } catch {
    return options;
  }
}

let sharedProvider: RevocationEvidenceProvider | undefined;

/**
 * Provedor do servidor (cache compartilhado no processo). Desligável com
 * PSYWRITE_REVOCATION_FETCH=off; nesse caso a emissão segue como antes (sem evidência).
 */
export function serverRevocationEvidenceProvider():
  | RevocationEvidenceProvider
  | undefined {
  if (process.env.PSYWRITE_REVOCATION_FETCH === 'off') return undefined;
  sharedProvider ??= createOnlineRevocationProvider();
  return sharedProvider;
}

/**
 * Opções de revogação da emissão ao vivo: provedor do servidor, registro no log das buscas que
 * falharam (só URL da AC e motivo) e, se `collected` vier, a evidência obtida para ser guardada.
 */
export function liveIssuanceRevocationOptions(
  collected?: Array<{
    chain: 'SIGNER' | 'TSA';
    evidence: CollectedRevocationEvidence[];
  }>,
): Pick<
  PadesVerificationOptions,
  'revocationEvidenceProvider' | 'onRevocationFetch' | 'onRevocationEvidence'
> {
  const provider = serverRevocationEvidenceProvider();
  if (!provider) return {};
  return {
    revocationEvidenceProvider: provider,
    onRevocationEvidence: collected
      ? (chain, evidence) => collected.push({ chain, evidence })
      : undefined,
    onRevocationFetch: (attempts) => {
      const failed = attempts.filter((a) => a.outcome === 'ERROR');
      if (failed.length)
        console.warn(
          '[revogação] busca sem sucesso:',
          failed.map((a) => `${a.kind} ${a.url}: ${a.reason}`).join('; '),
        );
    },
  };
}
