import type { ParsedX509Node } from './icp-chain.ts';

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

/**
 * Representa uma Prova Externa de Existência (POE) independente e pré-existente
 * (ex.: recibo imutável do SNCR/Anvisa ou registro de auditoria externo).
 *
 * IMPORTANTE (Lote 6F.2B):
 * - Uma data fornecida pelo chamador NÃO adquire confiança apenas por receber HMAC.
 * - A POE externa deve referenciar um registro independente (`evidenceRecordId`) emitido
 *   por uma fonte autorizada (`sourceId`) no instante `poeTime` sobre o hash `targetHashHex`.
 */
export interface ExternalPoeEvidence {
  evidenceRecordId: string;
  poeTime: Date;
  targetHashHex: string;
  targetType:
    | 'SIGNED_PDF_SHA256'
    | 'SIGNATURE_VALUE_SHA256'
    | 'DOCUMENT_HASH_SHA256';
  sourceId: string;
  authenticator?: string;
}

/**
 * Resultado da avaliação de validade temporal e Prova de Existência (POE) conforme ETSI EN 319 102-1 e RFC 3161.
 *
 * Semântica de `VALID_AT_POE`:
 * - A POE em `poeTime` comprova um limite superior (`t_criacao <= poeTime`), demonstrando que
 *   a assinatura já existia até aquele instante (antes de `notAfter`: `provenExistedBeforeExpiration = true`).
 * - A POE NÃO demonstra que a assinatura foi criada exatamente em `poeTime` (`exactCreationTimeProven = false`),
 *   nem demonstra isoladamente um limite inferior posterior a `notBefore` (`lowerBoundAfterNotBeforeProven = false`).
 * - A confiança temporal completa (`tsaTrustComplete`) somente é `true` quando assinatura, cadeia,
 *   âncora, validade temporal E revogação da cadeia da TSA (`tsaRevocationChecked`) estiverem
 *   demonstradas por evidência CRL/OCSP autêntica (Lote 6F.2C).
 */
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
  provenExistedBeforeExpiration?: boolean;
  exactCreationTimeProven?: boolean;
  lowerBoundAfterNotBeforeProven?: boolean;
  poeSource:
    | 'RFC3161_SIGNATURE_TIMESTAMP'
    | 'RFC3161_DOC_TIMESTAMP'
    | 'EXTERNAL_POE'
    | 'NONE';
  poeTime?: Date;
  claimedSigningTime?: Date;
  verificationTime: Date;
  timestampPresent?: boolean;
  timestampSignatureValid?: boolean;
  timestampMessageImprintValid?: boolean;
  timestampGenTime?: Date;
  tsaSignerSubject?: string;
  tsaKeyUsageValid?: boolean;
  tsaExtendedKeyUsageValid?: boolean;
  tsaExtendedKeyUsageCritical?: boolean;
  tsaChainStatus?:
    | 'VALID'
    | 'SELF_SIGNED'
    | 'INCOMPLETE_CHAIN'
    | 'UNTRUSTED_ROOT'
    | 'INVALID';
  tsaChainValid?: boolean;
  tsaRootTrusted?: boolean;
  tsaRevocationChecked?: boolean;
  tsaTrustComplete?: boolean;
  /** Lote 6F.2C: resultado de revogação por certificado da cadeia da TSA (sem a âncora). */
  tsaRevocationSummaries?: CertificateRevocationCheckSummary[];
  externalPoeValid?: boolean;
  subIndication?: string;
  error?: string;
}

export type CrlReasonName =
  | 'unspecified'
  | 'keyCompromise'
  | 'cACompromise'
  | 'affiliationChanged'
  | 'superseded'
  | 'cessationOfOperation'
  | 'certificateHold'
  | 'removeFromCRL'
  | 'privilegeWithdrawn'
  | 'aACompromise'
  | 'unknown';

export type RevocationEvidenceSourcePolicy =
  | 'INJECTED_ONLY'
  | 'INJECTED_AND_EMBEDDED_LTV';

export interface CertificateRevocationCheckSummary {
  subject: string;
  issuer: string;
  serialNumber: string;
  role: 'SIGNER' | 'SIGNER_CA' | 'TSA_SIGNER' | 'TSA_CA';
  status:
    | 'GOOD'
    | 'GOOD_AT_POE'
    | 'REVOKED_BEFORE_POE'
    | 'REVOKED_NO_POE'
    | 'CERTIFICATE_HOLD'
    | 'INDETERMINATE'
    | 'INVALID_EVIDENCE';
  source: 'CRL' | 'OCSP' | 'BOTH' | 'NONE';
  thisUpdate?: Date;
  nextUpdate?: Date;
  producedAt?: Date;
  revokedAt?: Date;
  invalidityDate?: Date;
  reasonCode?: number;
  reasonName?: CrlReasonName;
  isHold?: boolean;
  isKeyCompromise?: boolean;
  hasContradictoryEvidence?: boolean;
  subIndication?: string;
  error?: string;
}

/**
 * Resultado da verificação de revogação (CRL / OCSP) — Lote 6F.2C.
 *
 * Regra de segurança para evidência de revogação inválida (`INVALID_EVIDENCE`):
 * - Uma CRL ou resposta OCSP corrompida, adulterada, expirada ou sem cadeia válida deve ser
 *   rejeitada como evidência inutilizável (`status: 'INVALID_EVIDENCE'`), mas NÃO demonstra
 *   que a assinatura do documento seja inválida.
 * - Quando `revocation.status === 'INVALID_EVIDENCE'`, o status global da assinatura DEVE
 *   permanecer `'INDETERMINATE'` (`subIndication: 'REVOCATION_EVIDENCE_INVALID'`), impedindo
 *   que terceiros forcem um falso `INVALID` injetando CRL/OCSP adulterados.
 */
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
  invalidityDate?: Date;
  reasonCode?: number;
  reasonName?: CrlReasonName;
  isHold?: boolean;
  isKeyCompromise?: boolean;
  revokedCertificateRole?: 'SIGNER' | 'SIGNER_CA' | 'TSA_SIGNER' | 'TSA_CA';
  revokedCertificateSubject?: string;
  signerChainComplete?: boolean;
  tsaChainComplete?: boolean;
  hasContradictoryEvidence?: boolean;
  rejectedEvidencesCount?: number;
  certificateResults?: CertificateRevocationCheckSummary[];
  subIndication?: string;
  error?: string;
}

export interface PadesVerificationOptions {
  trustedCerts?: unknown[];
  trustedRootPems?: string[];
  trustedTsaCerts?: unknown[];
  trustedTsaRootPems?: string[];
  intermediateCerts?: unknown[];
  intermediatePems?: string[];
  tsaIntermediateCerts?: unknown[];
  tsaIntermediatePems?: string[];
  allowCustomTrustAnchors?: boolean;
  pdfRevisionPolicy?: PdfRevisionPolicy;
  validationContext?: ValidationContextMode;
  verificationTime?: Date;
  externalPoe?: ExternalPoeEvidence;
  externalPoeHmacKey?: string;
  externalPoeVerifier?: (
    evidence: ExternalPoeEvidence,
    expectedTargetHashHex: string,
  ) => boolean | Promise<boolean>;
  trustedExternalPoeSources?: string[];
  crls?: Array<Buffer | Uint8Array | string>;
  ocspResponses?: Array<Buffer | Uint8Array | string>;
  ocspResponderCerts?: unknown[];
  ocspResponderPems?: string[];
  revocationEvidenceSourcePolicy?: RevocationEvidenceSourcePolicy;
  /**
   * Política de frescor da evidência de revogação (6F.2C-R; ver `RevocationFreshnessContext`).
   * - `gracePeriodSeconds` (padrão 0): na validação histórica, a evidência de não revogação
   *   precisa ter sido emitida em/depois de `poeTime + gracePeriodSeconds`.
   * - `maxAgeSeconds` (padrão: sem limite além de nextUpdate): idade máxima na validação atual.
   * - `maxAgeWithoutNextUpdateSeconds` (padrão 86400): validade de OCSP sem nextUpdate.
   */
  revocationFreshness?: {
    gracePeriodSeconds?: number;
    maxAgeSeconds?: number;
    maxAgeWithoutNextUpdateSeconds?: number;
  };
  requireFullTrust?: boolean;
  /**
   * Lote 6F.2D (A1): busca LCR/OCSP na rede para as cadeias do signatário e da TSA, depois de
   * validadas até uma âncora. O que vier entra como evidência injetada e passa pela mesma
   * validação; falha de rede só deixa a evidência faltando (INDETERMINATE).
   */
  revocationEvidenceProvider?: RevocationEvidenceProvider;
  /** Recebe o registro das buscas (URLs e resultado; sem dados do documento). */
  onRevocationFetch?: (attempts: RevocationFetchAttempt[]) => void;
  /** Recebe a evidência obtida, por cadeia, para ser guardada (6F.2D). */
  onRevocationEvidence?: (
    chain: 'SIGNER' | 'TSA',
    evidence: CollectedRevocationEvidence[],
  ) => void;
}

export interface CollectedRevocationEvidence {
  kind: 'CRL' | 'OCSP';
  der: Buffer;
  url: string;
  /** Certificado para o qual a evidência foi buscada. */
  certificate: ParsedX509Node;
  /** Posição na cadeia: 0 é o signatário (ou a TSA); as demais, ACs. */
  chainPosition: number;
}

export interface RevocationFetchAttempt {
  kind: 'CRL' | 'OCSP' | 'CHAIN';
  subject: string;
  url?: string;
  outcome: 'FETCHED' | 'CACHED' | 'ERROR' | 'SKIPPED';
  reason?: string;
}

export interface RevocationEvidenceProvider {
  collect(
    chain: ParsedX509Node[],
    context: { now: Date },
  ): Promise<{
    crls: Buffer[];
    ocspResponses: Buffer[];
    attempts: RevocationFetchAttempt[];
    evidence?: CollectedRevocationEvidence[];
  }>;
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

/**
 * Avaliação explícita do resultado (Lote 6F.2C-R); ver `verification-policy.ts`.
 * Cada campo responde a uma pergunta diferente e nenhum substitui outro.
 */
export interface SignatureAssessment {
  /** PDF e CMS conferem com a chave do certificado embutido. */
  cryptographicIntegrity: boolean;
  /** Titular extraído, CPF coerente com o CN, certificado final com uso de assinatura. */
  signerIdentity: boolean;
  /** Cadeia validada até uma raiz confiável (ICP-Brasil fixada, salvo âncoras de teste). */
  chainTrusted: boolean;
  /** `status === 'VALID'`: cadeia, tempo/POE e revogação comprovados. */
  fullTrust: boolean;
  /** Evidência autêntica de revogação/suspensão na cadeia do signatário. */
  knownRevocation: boolean;
  /** `status === 'INVALID'` ou revogação conhecida. */
  rejected: boolean;
  /** Pode iniciar/concluir a emissão clínica (não implica confiança plena). */
  issuanceAllowed: boolean;
  issuanceBlockReason?: string;
  /** Estado que pode ser gravado no banco: INDETERMINATE nunca vira VALID. */
  persistenceStatus: VerificationStatus;
}

export interface PadesVerificationResult {
  /**
   * Retrocompatibilidade: "não rejeitada". True quando há integridade criptográfica, o status
   * não é INVALID e não há revogação conhecida da cadeia do signatário (ou, com
   * `requireFullTrust`, somente quando `status === 'VALID'`).
   * NÃO significa confiança plena: use `assessment.fullTrust` / `status === 'VALID'` para isso
   * e `assessment.issuanceAllowed` para autorizar emissão.
   */
  isValid: boolean;
  assessment: SignatureAssessment;
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
