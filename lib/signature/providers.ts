/**
 * Provedores de certificado em nuvem (PSC) aceitos. Todos seguem o mesmo padrão de API do ITI
 * (DOC-ICP-17.01): OAuth com PKCE, descoberta de certificados e assinatura de hash. Mudam só o
 * endereço e as credenciais, lidos de `<PREFIXO>_BASE_URL`, `_CLIENT_ID`, `_CLIENT_SECRET` e
 * `_REDIRECT_URI`. Este arquivo não lê variáveis de ambiente e pode ser usado na tela.
 */
export const SIGNATURE_PROVIDERS = {
  birdid: {
    label: 'Bird ID',
    envPrefix: 'BIRDID',
    defaultBaseUrl: 'https://api.birdid.com.br/v0',
  },
  vidaas: {
    label: 'VIDaaS',
    envPrefix: 'VIDAAS',
    // Endereço de produção informado na documentação pública da Valid; confirmar com a Valid
    // junto com as credenciais (a homologação usa outro endereço, via VIDAAS_BASE_URL).
    defaultBaseUrl: 'https://certificado.vidaas.com.br/v0',
  },
} as const;

export type SignatureProviderId = keyof typeof SIGNATURE_PROVIDERS;

export const SIGNATURE_PROVIDER_IDS = Object.keys(
  SIGNATURE_PROVIDERS,
) as SignatureProviderId[];

export const isSignatureProviderId = (
  value: unknown,
): value is SignatureProviderId =>
  typeof value === 'string' && Object.hasOwn(SIGNATURE_PROVIDERS, value);

/** Nome para a tela. Registros antigos (ou de teste) com outro valor mostram o próprio valor. */
export const signatureProviderLabel = (id: string | null | undefined) =>
  isSignatureProviderId(id)
    ? SIGNATURE_PROVIDERS[id].label
    : id || 'certificado em nuvem';
