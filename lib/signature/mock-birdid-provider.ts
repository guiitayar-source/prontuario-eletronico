import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { parseX509Certificate } from './crypto-utils.ts';
import type {
  CertificateInfo,
  DigitalSignatureProvider,
  SignatureResult,
} from './types.ts';

export interface MockProviderOptions {
  mockCpf?: string;
  doctorName?: string;
  shouldFailSign?: boolean;
  shouldFailTokenExchange?: boolean;
}

export class MockBirdIdProvider implements DigitalSignatureProvider {
  private readonly mockCpf: string;
  private readonly doctorName: string;
  private readonly shouldFailSign: boolean;
  private readonly shouldFailTokenExchange: boolean;

  private keyPair: CryptoKeyPair | null = null;
  private cert: pkijs.Certificate | null = null;
  private certPem: string | null = null;

  constructor(options?: MockProviderOptions) {
    this.mockCpf = options?.mockCpf || '12345678901';
    this.doctorName = options?.doctorName || 'DR. GUILHERME TAYAR';
    this.shouldFailSign = Boolean(options?.shouldFailSign);
    this.shouldFailTokenExchange = Boolean(options?.shouldFailTokenExchange);

    // Initialize WebCrypto engine for pkijs if not already set
    try {
      const cryptoEngine = new pkijs.CryptoEngine({
        name: 'NodeJS',
        crypto: globalThis.crypto,
      });
      pkijs.setEngine('NodeJS', cryptoEngine);
    } catch {
      // Already set
    }
  }

  private async ensureKeysAndCertificate(): Promise<{
    keyPair: CryptoKeyPair;
    cert: pkijs.Certificate;
    certPem: string;
  }> {
    if (this.keyPair && this.cert && this.certPem) {
      return {
        keyPair: this.keyPair,
        cert: this.cert,
        certPem: this.certPem,
      };
    }

    this.keyPair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );

    const cert = new pkijs.Certificate();
    cert.version = 2; // v3
    cert.serialNumber = new asn1js.Integer({ value: 12345678 });

    // Standard ICP-Brasil Common Name: "NOME:CPF"
    const commonName = `${this.doctorName}:${this.mockCpf}`;
    const subjectAttrs = [
      new pkijs.AttributeTypeAndValue({
        type: '2.5.4.6', // C
        value: new asn1js.PrintableString({ value: 'BR' }),
      }),
      new pkijs.AttributeTypeAndValue({
        type: '2.5.4.10', // O
        value: new asn1js.Utf8String({ value: 'ICP-Brasil' }),
      }),
      new pkijs.AttributeTypeAndValue({
        type: '2.5.4.11', // OU
        value: new asn1js.Utf8String({ value: 'Autoridade Certificadora Teste' }),
      }),
      new pkijs.AttributeTypeAndValue({
        type: '2.5.4.3', // CN
        value: new asn1js.Utf8String({ value: commonName }),
      }),
    ];

    cert.issuer.typesAndValues = subjectAttrs;
    cert.subject.typesAndValues = subjectAttrs;
    cert.notBefore.value = new Date(Date.now() - 3600 * 1000);
    cert.notAfter.value = new Date(Date.now() + 365 * 24 * 3600 * 1000);

    await cert.subjectPublicKeyInfo.importKey(this.keyPair.publicKey);
    await cert.sign(this.keyPair.privateKey, 'SHA-256');

    this.cert = cert;
    const certDer = Buffer.from(cert.toSchema().toBER());
    const base64 = certDer.toString('base64');
    this.certPem = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----`;

    return {
      keyPair: this.keyPair,
      cert: this.cert,
      certPem: this.certPem,
    };
  }

  getAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    loginHint?: string;
    lifetimeSeconds?: number;
  }): string {
    const url = new URL(params.redirectUri);
    url.searchParams.set('code', `mock_code_${Date.now()}`);
    url.searchParams.set('state', params.state);
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
    if (this.shouldFailTokenExchange) {
      throw new Error('Falha simulada na troca de código por token (Mock)');
    }
    return {
      accessToken: `mock_access_token_${Buffer.from(params.codeVerifier).toString('hex').slice(0, 16)}`,
      expiresIn: 3600,
      tokenType: 'Bearer',
      cpf: this.mockCpf,
    };
  }

  async getCertificates(_accessToken: string): Promise<CertificateInfo[]> {
    const { certPem } = await this.ensureKeysAndCertificate();
    const info = parseX509Certificate(certPem, 'Mock ICP-Brasil e-CPF');
    return [info];
  }

  async signHash(params: {
    accessToken: string;
    certificateAlias: string;
    hashHex: string;
    documentAlias: string;
  }): Promise<SignatureResult> {
    if (this.shouldFailSign) {
      throw new Error('Falha simulada na assinatura digital (Mock)');
    }

    const { keyPair, cert } = await this.ensureKeysAndCertificate();

    const hashBytes = Buffer.from(params.hashHex, 'hex');
    const u8Hash = new Uint8Array(hashBytes.length);
    u8Hash.set(hashBytes);

    const signerInfo = new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({
        issuer: cert.issuer,
        serialNumber: cert.serialNumber,
      }),
      signedAttrs: new pkijs.SignedAndUnsignedAttributes({
        type: 0,
        attributes: [
          new pkijs.Attribute({
            type: '1.2.840.113549.1.9.3', // contentType
            values: [
              new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' }),
            ],
          }),
          new pkijs.Attribute({
            type: '1.2.840.113549.1.9.5', // signingTime
            values: [new asn1js.UTCTime({ valueDate: new Date() })],
          }),
          new pkijs.Attribute({
            type: '1.2.840.113549.1.9.4', // messageDigest
            values: [new asn1js.OctetString({ valueHex: u8Hash.buffer })],
          }),
        ],
      }),
    });

    const signedData = new pkijs.SignedData({
      version: 1,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: '1.2.840.113549.1.7.1', // id-data
      }),
      signerInfos: [signerInfo],
      certificates: [cert],
    });

    await signedData.sign(keyPair.privateKey, 0, 'SHA-256');

    const contentInfo = new pkijs.ContentInfo({
      contentType: '1.2.840.113549.1.7.2', // id-signedData
      content: signedData.toSchema(),
    });

    const cmsDer = Buffer.from(contentInfo.toSchema().toBER());

    return {
      cmsSignatureBase64: cmsDer.toString('base64'),
      algorithm: 'SHA256withRSA',
      providerTransactionId: `mock_tx_${Date.now()}`,
    };
  }

  async revokeSession(_accessToken: string): Promise<void> {
    // No-op for mock
  }
}
