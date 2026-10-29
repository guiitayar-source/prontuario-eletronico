import { HttpError } from '@/lib/supabase/server';
import { cleanCpf, parseX509Certificate } from './crypto-utils.ts';
import type {
  CertificateInfo,
  DigitalSignatureProvider,
  SignatureResult,
} from './types.ts';

export interface PscProviderConfig {
  /** Nome mostrado nas mensagens de erro (ex.: Bird ID, VIDaaS). */
  label: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

interface PscTokenResponse {
  access_token: string;
  expires_in?: number | string;
  token_type?: string;
  authorized_identification?: string;
}

interface PscDiscoveryResponse {
  status?: string;
  error?: string;
  error_description?: string;
  certificates?: Array<{ alias?: string; certificate?: string }>;
}

interface PscSignatureResponse {
  status?: string;
  error?: string;
  error_description?: string;
  signature?: string;
  signature_format?: string;
  transaction_id?: string;
  signatures?: Array<{
    id?: string;
    raw_signature?: string;
    signature?: string;
  }>;
}

/**
 * Cliente da API padrão dos PSCs (DOC-ICP-17.01), usada pelo Bird ID e pelo VIDaaS.
 * As credenciais vêm de `provider-factory.ts`.
 */
export class PscProvider implements DigitalSignatureProvider {
  private readonly label: string;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(config: PscProviderConfig) {
    this.label = config.label;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.clientId = config.clientId.trim();
    this.clientSecret = config.clientSecret.trim();

    if (!this.clientId || !this.clientSecret) {
      throw new HttpError(
        500,
        `Integração ${this.label} não configurada: faltam as credenciais.`
      );
    }
  }

  getAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    loginHint?: string;
    lifetimeSeconds?: number;
  }): string {
    if (!params.redirectUri) {
      throw new HttpError(
        500,
        `Integração ${this.label} não configurada: falta o endereço de retorno.`
      );
    }

    const url = new URL(`${this.baseUrl}/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', 'signature_session');
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    if (params.loginHint) {
      const cpf = cleanCpf(params.loginHint);
      if (cpf && cpf.length === 11) {
        url.searchParams.set('login_hint', cpf);
      }
    }

    if (params.lifetimeSeconds && params.lifetimeSeconds > 0) {
      url.searchParams.set('lifetime', params.lifetimeSeconds.toString());
    }

    return url.toString();
  }

  async exchangeAuthorizationCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{
    accessToken: string;
    expiresIn: number;
    tokenType: string;
    cpf: string;
  }> {
    const tokenUrl = `${this.baseUrl}/oauth/token`;
    const basicAuth = Buffer.from(
      `${this.clientId}:${this.clientSecret}`
    ).toString('base64');

    const tokenPayload = {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    };

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(tokenPayload),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      // Nunca repassar corpo externo: pode repetir código, token ou dados pessoais.
      throw new HttpError(response.status, `Autorização ${this.label} recusada pelo provedor.`);
    }
    const data = (await response.json()) as PscTokenResponse;
    const expiresIn = data.expires_in === undefined ? 3600 : Number(data.expires_in);
    if (typeof data.access_token !== 'string' || !data.access_token ||
        (data.token_type && data.token_type.toLowerCase() !== 'bearer') ||
        !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86400)
      throw new HttpError(502, 'Resposta de autorização inválida.');

    return {
      accessToken: data.access_token,
      expiresIn,
      tokenType: data.token_type || 'Bearer',
      cpf: cleanCpf(data.authorized_identification || ''),
    };
  }

  async getCertificates(accessToken: string): Promise<CertificateInfo[]> {
    const discoveryUrl = `${this.baseUrl}/oauth/certificate-discovery`;

    const response = await fetch(discoveryUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok)
      throw new HttpError(response.status, `Não foi possível consultar o certificado no ${this.label}.`);
    const data = (await response.json()) as PscDiscoveryResponse;
    if (data.status && !['S', 'success', 'OK'].includes(data.status))
      throw new HttpError(422, 'Consulta de certificado recusada pelo provedor.');

    const rawList: Array<{ alias?: string; certificate?: string }> =
      data.certificates || [];
    if (!Array.isArray(rawList) || rawList.length === 0) {
      throw new HttpError(
        422,
        `Nenhum certificado ICP-Brasil encontrado na conta ${this.label}.`
      );
    }

    return rawList.map((item) => {
      const certContent = item.certificate || '';
      return parseX509Certificate(certContent, item.alias || '');
    });
  }

  async signHash(params: {
    accessToken: string;
    certificateAlias: string;
    hashHex: string;
    documentAlias: string;
  }): Promise<SignatureResult> {
    const signatureUrl = `${this.baseUrl}/oauth/signature`;

    // Conforme documentação oficial Bird ID / Vault ID (POST /v0/oauth/signature):
    // hashes: Array com { id, alias, hash, hash_algorithm, signature_format }
    // SHA-256 OID: 2.16.840.1.101.3.4.2.1
    const bodyPayload = {
      certificate_alias: params.certificateAlias,
      hashes: [
        {
          id: '1',
          alias: params.documentAlias || 'Documento Prontuário',
          hash: params.hashHex,
          hash_algorithm: '2.16.840.1.101.3.4.2.1',
          signature_format: 'CMS',
        },
      ],
      include_chain: true,
    };

    const response = await fetch(signatureUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(60000), // Operação de assinatura HSM / push
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: { error?: string; error_description?: string } = {};
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        // Ignored
      }
      throw new HttpError(
        response.status,
        `Erro na assinatura remota ${this.label} (${response.status}): ${
          errorJson.error_description || errorJson.error || errorText
        }`
      );
    }

    const data = (await response.json()) as PscSignatureResponse & {
      message?: string;
      detail?: { code?: number; status?: string; message?: string };
    };

    const signatureRaw =
      data.signatures?.[0]?.raw_signature ||
      data.signatures?.[0]?.signature ||
      data.signature;

    const isSuccess =
      Boolean(signatureRaw) ||
      data.status === 'S' ||
      data.status === 'success' ||
      data.detail?.status === 'SIGNED';

    if (!isSuccess) {
      throw new HttpError(
        422,
        `${this.label} retornou erro na assinatura: ${
          data.error_description || data.error || data.message || JSON.stringify(data)
        }`
      );
    }

    if (!signatureRaw) {
      throw new HttpError(
        500,
        `${this.label} não retornou o conteúdo da assinatura CMS.`
      );
    }

    // Se vier no formato PEM (ex: -----BEGIN PKCS7----- ... -----END PKCS7-----),
    // remove os delimitadores PEM e espaços em branco para obter a string Base64 limpa
    const cmsSignatureBase64 = signatureRaw
      .replace(/-----[^-]+-----/g, '')
      .replace(/\s+/g, '');

    return {
      cmsSignatureBase64,
      algorithm: 'SHA256withRSA',
      providerTransactionId:
        data.transaction_id || data.signatures?.[0]?.id || undefined,
    };
  }

  async revokeSession(accessToken: string): Promise<void> {
    try {
      const revokeUrl = `${this.baseUrl}/oauth/revoke`;
      await fetch(revokeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token: accessToken }).toString(),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Revogação best-effort
    }
  }
}
