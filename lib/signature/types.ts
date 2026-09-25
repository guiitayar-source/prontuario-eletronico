export type DocumentStatus =
  | 'DRAFT'
  | 'FINALIZED'
  | 'SIGNING'
  | 'SIGNED'
  | 'SIGNATURE_FAILED'
  | 'SUPERSEDED';

export type VerificationStatus = 'VALID' | 'INVALID' | 'UNVERIFIED';

export interface CertificateInfo {
  alias: string;
  rawPem: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  fingerprint256: string;
  validFrom: Date;
  validTo: Date;
  cpf: string | null;
  commonName: string;
}

export interface SignatureSessionData {
  id: string;
  clinicId: string;
  userId: string;
  provider: string;
  cpf: string;
  certificateAlias: string;
  certificateSubject: string;
  certificateIssuer: string;
  certificateValidFrom: string;
  certificateValidTo: string;
  expiresAt: string;
  revoked: boolean;
}

export interface DigitalSignatureRecord {
  id: string;
  clinic_id: string;
  document_id: string;
  document_version: number;
  signer_user_id: string;
  signer_doctor_id: string;
  provider: string;
  certificate_subject: string;
  certificate_issuer: string;
  certificate_serial: string;
  certificate_fingerprint: string;
  cpf_from_certificate: string;
  signature_algorithm: string;
  digest_algorithm: string;
  signature_format: string;
  signed_at: string;
  document_hash: string;
  unsigned_pdf_hash: string;
  signed_pdf_hash: string;
  signed_pdf_storage_path: string;
  status: 'SIGNED' | 'SIGNATURE_FAILED';
  verification_status: VerificationStatus;
  provider_transaction_id?: string | null;
  created_at: string;
}

export interface SignatureResult {
  cmsSignatureBase64: string;
  algorithm: string;
  providerTransactionId?: string;
}

export interface DigitalSignatureProvider {
  getAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    loginHint?: string;
    lifetimeSeconds?: number;
  }): string;

  exchangeAuthorizationCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{
    accessToken: string;
    expiresIn: number;
    tokenType: string;
    cpf: string;
  }>;

  getCertificates(accessToken: string): Promise<CertificateInfo[]>;

  signHash(params: {
    accessToken: string;
    certificateAlias: string;
    hashHex: string;
    documentAlias: string;
  }): Promise<SignatureResult>;

  revokeSession?(accessToken: string): Promise<void>;
}

export interface PreparedPdf {
  pdfWithPlaceholder: Uint8Array;
  byteRange: [number, number, number, number];
  contentToSign: Uint8Array;
  digestHex: string;
  actualByteRangePdf: Buffer;
}

export interface PadesVerificationResult {
  isValid: boolean;
  signerName: string;
  signerCpf: string | null;
  certificateSubject: string;
  certificateIssuer: string;
  certificateSerial: string;
  certificateFingerprint: string;
  validFrom: Date;
  validTo: Date;
  digestAlgorithm: string;
  messageDigestHex: string;
  calculatedDigestHex: string;
  signedAt?: Date;
  error?: string;
}
