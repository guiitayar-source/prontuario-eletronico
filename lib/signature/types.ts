export type DocumentStatus =
  | 'DRAFT'
  | 'FINALIZED'
  | 'SIGNING'
  | 'SIGNED'
  | 'SIGNATURE_FAILED'
  | 'SUPERSEDED';

export type VerificationStatus = 'VALID' | 'INVALID' | 'UNVERIFIED';

export type VerificationGlobalStatus = 'VALID' | 'INDETERMINATE' | 'INVALID';

export type PdfRevisionPolicy =
  | 'PADES_LTV_ALLOWED'
  | 'STRICT_SINGLE_REVISION_AT_SIGNING';

export type ValidationContextMode = 'VERIFICATION' | 'LIVE_ISSUANCE';

export type PdfRevisionKind =
  | 'PRE_SIGNATURE_REVISION'
  | 'SIGNED_REVISION'
  | 'SUBSEQUENT_SIGNATURE_REVISION'
  | 'PADES_LTV_DSS_REVISION'
  | 'PADES_DOC_TIMESTAMP_REVISION'
  | 'UNAUTHORIZED_POST_SIGNATURE_MODIFICATION';

export interface PdfIncrementalRevisionClassification {
  revisionIndex: number;
  startByte: number;
  endByte: number;
  eofOffset: number;
  kind: PdfRevisionKind;
  coveredByFinalSignature: boolean;
  modifiedObjectNumbers: number[];
  reason?: string;
}

export interface PdfSignatureRevisionSummary {
  signatureIndex: number;
  fieldName: string | null;
  filter: string | null;
  subFilter: string | null;
  type: 'Sig' | 'DocTimeStamp';
  byteRange: [number, number, number, number];
  revisionEndByte: number;
  valid: boolean;
  contentsHexValid: boolean;
  contentsPaddingValid: boolean;
  coversUntilRevisionEof: boolean;
  cmsDerBytes?: Buffer;
  signedContentBytes?: Buffer;
  asn1ByteLength?: number;
  paddingByteLength?: number;
  error?: string;
}

export interface PadesPdfIntegrityResult {
  valid: boolean;
  policy: PdfRevisionPolicy;
  byteRange: [number, number, number, number] | null;
  coversWholeDocument: boolean;
  unsignedTrailingBytes: number;
  contentsHexValid: boolean;
  contentsPaddingValid: boolean;
  totalRevisionsCount: number;
  preSignatureRevisionsCount: number;
  signatureRevisionsCount: number;
  postSignatureLtvRevisionsCount: number;
  hasUnauthorizedPostSignatureUpdate: boolean;
  revisions: PdfIncrementalRevisionClassification[];
  signatures: PdfSignatureRevisionSummary[];
  error?: string;
}

export interface PadesCmsIntegrityResult {
  valid: boolean;
  signerInfoCount: number;
  signatureVerified: boolean;
  signedAttrsPresent: boolean;
  contentTypeValid: boolean;
  digestAlgorithm: string;
  signatureAlgorithm: string;
  messageDigestAttrHex: string;
  calculatedDigestHex: string;
  digestMatches: boolean;
  signingCertificateAttrPresent: boolean;
  signingCertificateAttrValid: boolean;
  allSignaturesCmsValid: boolean;
  error?: string;
}

export interface PadesSignerIdentityResult {
  extracted: boolean;
  commonName: string;
  cpf: string | null;
  cpfMatchesCommonName: boolean;
  subject: string;
  issuer: string;
  serialNumber: string;
  fingerprint256: string;
  validFrom: Date;
  validTo: Date;
  isCa: boolean;
  keyUsageValid: boolean;
  icpBrasilAttrsPresent: boolean;
  error?: string;
}

export interface PadesChainValidationResult {
  status:
    | 'VALID'
    | 'SELF_SIGNED'
    | 'INCOMPLETE_CHAIN'
    | 'UNTRUSTED_ROOT'
    | 'INVALID';
  valid: boolean;
  isSelfSigned: boolean;
  chainLength: number;
  chainSubjects: string[];
  error?: string;
}

export interface PadesRootTrustResult {
  trusted: boolean;
  rootSubject: string | null;
  rootFingerprint256: string | null;
  error?: string;
}

export interface ExternalPoeEvidence {
  poeTime: Date;
  targetHashHex: string;
  targetType:
    | 'SIGNED_PDF_SHA256'
    | 'SIGNATURE_VALUE_SHA256'
    | 'DOCUMENT_HASH_SHA256';
  sourceId: string;
  authenticator?: string;
}

export interface PadesTemporalValidityResult {
  status:
    | 'VALID_AT_POE'
    | 'WITHIN_CURRENT_VALIDITY_NO_TIMESTAMP'
    | 'OUT_OF_BOUNDS_NO_POE'
    | 'OUT_OF_BOUNDS_AT_POE'
    | 'NOT_YET_VALID'
    | 'CLAIMED_TIME_OUTSIDE_VALIDITY'
    | 'EXPIRED_AT_ISSUANCE'
    | 'INVALID_TIMESTAMP';
  valid: boolean;
  currentlyValid: boolean;
  hasTrustedPoe: boolean;
  poeSource:
    | 'RFC3161_SIGNATURE_TIMESTAMP'
    | 'RFC3161_DOC_TIMESTAMP'
    | 'EXTERNAL_POE'
    | 'NONE';
  poeTime?: Date;
  claimedSigningTime?: Date;
  verificationTime: Date;
  tsaChainValid?: boolean;
  tsaRootTrusted?: boolean;
  error?: string;
}

export interface PadesRevocationResult {
  status:
    | 'GOOD'
    | 'GOOD_AT_POE'
    | 'REVOKED_BEFORE_POE'
    | 'REVOKED_NO_POE'
    | 'INDETERMINATE'
    | 'INVALID_EVIDENCE';
  checked: boolean;
  source: 'CRL' | 'OCSP' | 'BOTH' | 'NONE';
  revokedAt?: Date;
  reasonCode?: number;
  error?: string;
}

export interface PadesVerificationOptions {
  trustedCerts?: unknown[];
  trustedRootPems?: string[];
  trustedTsaRootPems?: string[];
  intermediateCerts?: unknown[];
  intermediatePems?: string[];
  allowCustomTrustAnchors?: boolean;
  pdfRevisionPolicy?: PdfRevisionPolicy;
  validationContext?: ValidationContextMode;
  verificationTime?: Date;
  externalPoe?: ExternalPoeEvidence;
  crls?: Array<Buffer | Uint8Array | string>;
  ocspResponses?: Array<Buffer | Uint8Array>;
  requireFullTrust?: boolean;
}

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
  signing_attempt_id?: string | null;
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
  /**
   * Indicador de retrocompatibilidade: true quando `cryptographicIntegrity === true`
   * e `status !== 'INVALID'` (ou `status === 'VALID'` quando `requireFullTrust === true`).
   * NUNCA equivale isoladamente a confiança plena ICP-Brasil (`isTrusted` / `status === 'VALID'`).
   */
  isValid: boolean;
  status: VerificationGlobalStatus;
  subIndication?: string;
  persistenceStatus: VerificationStatus;
  cryptographicIntegrity: boolean;
  certificateTrust: boolean;
  isTrusted: boolean;
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
  claimedSigningTime?: Date;
  poeTime?: Date;
  cmsIntegrity: PadesCmsIntegrityResult;
  pdfIntegrity: PadesPdfIntegrityResult;
  signerIdentity: PadesSignerIdentityResult;
  chainValidation: PadesChainValidationResult;
  rootTrust: PadesRootTrustResult;
  temporalValidity: PadesTemporalValidityResult;
  revocation: PadesRevocationResult;
  error?: string;
}

export interface EvolutionSignatureRecord {
  id: string;
  clinic_id: string;
  evolution_id: string;
  evolution_version: number;
  signer_user_id: string;
  doctor_id: string;
  canonical_schema_version: number;
  canonical_data: Record<string, unknown>;
  digest_algorithm: string;
  document_hash: string;
  signature_format: string;
  signature_value: string;
  certificate_subject: string;
  certificate_issuer: string;
  certificate_serial: string;
  certificate_fingerprint: string;
  certificate_not_before: string;
  certificate_not_after: string;
  provider: string;
  provider_signature_id?: string | null;
  signed_at: string;
  verification_status: VerificationStatus;
  verified_at: string;
  created_at: string;
}

export interface EvolutionVerificationResult {
  isValid: boolean;
  status?: VerificationGlobalStatus;
  subIndication?: string;
  persistenceStatus?: VerificationStatus;
  cryptographicIntegrity?: boolean;
  certificateTrust?: boolean;
  isTrusted?: boolean;
  evolutionId: string;
  signatureId?: string;
  provider?: string;
  signerName: string;
  signerCpf: string | null;
  certificateSubject: string;
  certificateIssuer: string;
  certificateSerial: string;
  certificateFingerprint: string;
  validFrom: Date;
  validTo: Date;
  documentHash: string;
  recalculatedHash: string;
  hashMatches: boolean;
  dataMatchesRecord: boolean;
  signatureValid?: boolean;
  certificateValid?: boolean;
  // Cadeia até uma raiz ICP-Brasil fixada, na data da assinatura. Não consulta revogação.
  chainValid?: boolean;
  chainPath?: string[];
  chainError?: string;
  signedAt: Date;
  claimedSigningTime?: Date;
  poeTime?: Date;
  canonicalData?: Record<string, unknown>;
  error?: string;
}
