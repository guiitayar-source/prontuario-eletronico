// Identificadores (OIDs) e listas de algoritmos/extensões aceitos na validação de revogação
// (LCR — RFC 5280; OCSP — RFC 6960). Só constantes: nenhuma lógica mora aqui.

export const OID_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';
export const OID_ISSUER_ALT_NAME = '2.5.29.18';
export const OID_CRL_NUMBER = '2.5.29.20';
export const OID_CRL_REASON = '2.5.29.21';
export const OID_INVALIDITY_DATE = '2.5.29.24';
export const OID_DELTA_CRL_INDICATOR = '2.5.29.27';
export const OID_ISSUING_DISTRIBUTION_POINT = '2.5.29.28';
export const OID_CERTIFICATE_ISSUER = '2.5.29.29';
export const OID_CRL_DISTRIBUTION_POINTS = '2.5.29.31';
export const OID_FRESHEST_CRL = '2.5.29.46';
export const OID_AUTHORITY_INFO_ACCESS = '1.3.6.1.5.5.7.1.1';

export const OID_KP_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';
export const OID_PKIX_OCSP_BASIC = '1.3.6.1.5.5.7.48.1.1';
export const OID_PKIX_OCSP_NONCE = '1.3.6.1.5.5.7.48.1.2';
export const OID_PKIX_OCSP_CRL = '1.3.6.1.5.5.7.48.1.3';
export const OID_PKIX_OCSP_RESPONSE = '1.3.6.1.5.5.7.48.1.4';
export const OID_PKIX_OCSP_NOCHECK = '1.3.6.1.5.5.7.48.1.5';
export const OID_PKIX_OCSP_ARCHIVE_CUTOFF = '1.3.6.1.5.5.7.48.1.6';

export const ALLOWED_SIGNATURE_OIDS: Record<
  string,
  { name: string; digestName: 'SHA-256' | 'SHA-384' | 'SHA-512' }
> = {
  '1.2.840.113549.1.1.10': { name: 'RSASSA-PSS', digestName: 'SHA-256' },
  '1.2.840.113549.1.1.11': { name: 'SHA256withRSA', digestName: 'SHA-256' },
  '1.2.840.113549.1.1.12': { name: 'SHA384withRSA', digestName: 'SHA-384' },
  '1.2.840.113549.1.1.13': { name: 'SHA512withRSA', digestName: 'SHA-512' },
  '1.2.840.10045.4.3.2': { name: 'ECDSAwithSHA256', digestName: 'SHA-256' },
  '1.2.840.10045.4.3.3': { name: 'ECDSAwithSHA384', digestName: 'SHA-384' },
  '1.2.840.10045.4.3.4': { name: 'ECDSAwithSHA512', digestName: 'SHA-512' },
};

export const ALLOWED_CERTID_HASH_OIDS: Record<
  string,
  'sha1' | 'sha256' | 'sha384' | 'sha512'
> = {
  '1.3.14.3.2.26': 'sha1', // RFC 6960 mandatory-to-implement for CertID
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

export const RECOGNIZED_CRL_CRITICAL_EXT_OIDS = new Set<string>([
  OID_ISSUING_DISTRIBUTION_POINT,
  OID_DELTA_CRL_INDICATOR,
]);

export const RECOGNIZED_CRL_ENTRY_CRITICAL_EXT_OIDS = new Set<string>([
  OID_CRL_REASON,
  OID_INVALIDITY_DATE,
  OID_CERTIFICATE_ISSUER,
]);

export const RECOGNIZED_OCSP_RESPONSE_CRITICAL_EXT_OIDS = new Set<string>([
  OID_PKIX_OCSP_NONCE,
  OID_PKIX_OCSP_CRL,
  OID_PKIX_OCSP_RESPONSE,
  OID_PKIX_OCSP_ARCHIVE_CUTOFF,
]);

export const RECOGNIZED_OCSP_SINGLE_CRITICAL_EXT_OIDS = new Set<string>([
  OID_CRL_REASON,
  OID_INVALIDITY_DATE,
  OID_PKIX_OCSP_ARCHIVE_CUTOFF,
]);
