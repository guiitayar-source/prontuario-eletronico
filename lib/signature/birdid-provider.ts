import { cleanCpf, parseX509Certificate } from './crypto-utils.ts';
import type {
  CertificateInfo,
  DigitalSignatureProvider,
  SignatureResult,
} from './types.ts';

export interface BirdIdConfig {
  baseUrl?: string;
  clientId: string;
  clientSecret: string;
}

interface BirdIdTokenResponse {
  access_token: string;
  expires_in?: number | string;
  token_type?: string;
  authorized_identification?: string;
}

interface BirdIdDiscoveryResponse {
  status?: string;
  error?: string;
  error_description?: string;
  certificates?: Array<{ alias?: string; certificate?: string }>;
}

interface BirdIdSignatureResponse {
  status?: string;
  error?: string;
  error_description?: string;
  signature?: string;
  signature_format?: string;
  transaction_id?: string;
}

export class BirdIdProvider implements DigitalSignatureProvider {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(config?: Partial<BirdIdConfig>) {
    this.baseUrl = (
      config?.baseUrl ||
      process.env.BIRDID_BASE_URL ||
      'https://api.birdid.com.br/v0'
    ).replace(/\/+$/, '');
    this.clientId = config?.clientId || process.env.BIRDID_CLIENT_ID || '';
    this.clientSecret =
      config?.clientSecret || process.env.BIRDID_CLIENT_SECRET || '';

    if (!this.clientId || !this.clientSecret) {
      // Allowed in development or mock mode, but warn
      console.warn(
        '[BirdIdProvider] BIRDID_CLIENT_ID ou BIRDID_CLIENT_SECRET não configurados. A API Bird ID real falhará se invocada.'
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
      if (cpf) {
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

    const formBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
        Accept: 'application/json',
      },
      body: formBody.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: { error?: string; error_description?: string } = {};
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        // Ignored
      }
      throw new Error(
        `Falha ao trocar código de autorização Bird ID (${response.status}): ${
          errorJson.error_description || errorJson.error || errorText
        }`
      );
    }

    const data = (await response.json()) as BirdIdTokenResponse;
    return {
      accessToken: data.access_token,
      expiresIn: Number(data.expires_in) || 3600,
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
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Falha ao buscar certificados na Bird ID (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as BirdIdDiscoveryResponse;
    if (data.status && data.status !== 'S') {
      throw new Error(
        `Bird ID retornou status de erro ao buscar certificados: ${
          data.error_description || data.error || JSON.stringify(data)
        }`
      );
    }

    const rawList: Array<{ alias?: string; certificate?: string }> =
      data.certificates || [];
    if (!Array.isArray(rawList) || rawList.length === 0) {
      throw new Error('Nenhum certificado ICP-Brasil encontrado na conta Bird ID.');
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

    // SHA-256 OID: 2.16.840.1.101.3.4.2.1
    const bodyPayload = {
      certificate_alias: params.certificateAlias,
      hash: params.hashHex,
      hash_algorithm: '2.16.840.1.101.3.4.2.1',
      signature_format: 'CMS',
      include_chain: true,
      document_alias: params.documentAlias,
    };

    const response = await fetch(signatureUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(30000), // Signing might require push confirmation or HSM processing
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: { error?: string; error_description?: string } = {};
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        // Ignored
      }
      throw new Error(
        `Erro na assinatura remota Bird ID (${response.status}): ${
          errorJson.error_description || errorJson.error || errorText
        }`
      );
    }

    const data = (await response.json()) as BirdIdSignatureResponse;
    if (data.status && data.status !== 'S') {
      throw new Error(
        `Bird ID retornou erro na assinatura: ${
          data.error_description || data.error || JSON.stringify(data)
        }`
      );
    }

    if (!data.signature) {
      throw new Error('Bird ID não retornou o conteúdo da assinatura CMS.');
    }

    return {
      cmsSignatureBase64: data.signature,
      algorithm: 'SHA256withRSA',
      providerTransactionId: data.transaction_id || undefined,
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
      // Best-effort revocation
    }
  }
}
