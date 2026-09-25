import crypto from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import type { CertificateInfo } from './types.ts';

/**
 * Standardize CPF to 11 digits (only numbers).
 */
export function cleanCpf(cpf: string | null | undefined): string {
  if (!cpf) return '';
  return cpf.replace(/\D/g, '').slice(0, 11);
}

/**
 * Format CPF to 000.000.000-00.
 */
export function formatCpf(cpf: string): string {
  const cleaned = cleanCpf(cpf);
  if (cleaned.length !== 11) return cleaned;
  return cleaned.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

/**
 * Generate PKCE code_verifier and code_challenge (RFC 7636).
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Derives or normalizes a 32-byte AES-256 key from an environment secret or provided key.
 */
function getEncryptionKey(providedKey?: string): Buffer {
  const rawKey =
    providedKey ||
    process.env.SIGNATURE_ENCRYPTION_KEY ||
    'default-dev-signature-secret-key-32b!';

  // If 64 hex characters (32 bytes in hex), parse as hex
  if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  // Otherwise hash with SHA-256 to ensure exact 32 bytes
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

/**
 * Encrypt sensitive token (OAuth access/refresh token) using AES-256-GCM.
 * Format: `ivHex:authTagHex:cipherTextHex`
 */
export function encryptToken(plainText: string, secretKey?: string): string {
  const key = getEncryptionKey(secretKey);
  const iv = crypto.randomBytes(12); // 96 bits recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt token encrypted with encryptToken using AES-256-GCM.
 */
export function decryptToken(
  cipherTextWithMeta: string,
  secretKey?: string
): string {
  const parts = cipherTextWithMeta.split(':');
  if (parts.length !== 3) {
    throw new Error('Formato inválido de token criptografado');
  }
  const [ivHex, tagHex, encryptedHex] = parts;
  const key = getEncryptionKey(secretKey);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/**
 * Timing-safe string comparison to prevent side-channel timing attacks.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Perform dummy comparison with self to equalize timing
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Extracts CPF from ICP-Brasil X.509 Certificate:
 * 1. Checks Subject Alternative Name (SAN) for otherName OID 2.16.76.1.3.1 (Dados Titular PF).
 * 2. Fallbacks to Common Name (CN) pattern "NAME:CPF".
 */
export function extractCpfFromCertificate(
  x509: crypto.X509Certificate,
  derBuffer?: Buffer
): string | null {
  // Method 1: Search Subject Alternative Name OID 2.16.76.1.3.1 (ICP-Brasil Pessoa Física)
  if (derBuffer) {
    try {
      const u8 = new Uint8Array(derBuffer.length);
      u8.set(derBuffer);
      const asn1 = asn1js.fromBER(u8.buffer);
      if (asn1.result && asn1.result.valueBlock) {
        const pkiCert = new pkijs.Certificate({ schema: asn1.result });
        if (pkiCert.extensions) {
          // OID 2.5.29.17 is Subject Alternative Name
          const sanExt = pkiCert.extensions.find(
            (ext) => ext.extnID === '2.5.29.17'
          );
          if (sanExt && sanExt.parsedValue) {
            const generalNames = sanExt.parsedValue as pkijs.GeneralNames;
            if (Array.isArray(generalNames.names)) {
              for (const gn of generalNames.names) {
                // type 0 is otherName
                if (gn.type === 0 && gn.value) {
                  const otherName = gn.value as { typeId?: string; value?: unknown };
                  if (otherName.typeId === '2.16.76.1.3.1') {
                    // In ICP-Brasil, OID 2.16.76.1.3.1 contains birthdate (8 chars) + CPF (11 chars)
                    const val = otherName.value as { valueBlock?: { valueHex?: ArrayBuffer; value?: unknown } };
                    if (val?.valueBlock?.valueHex) {
                      const str = Buffer.from(val.valueBlock.valueHex).toString('latin1');
                      const candidate = str.slice(8, 19);
                      if (/^\d{11}$/.test(candidate)) {
                        return candidate;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Continue to CN fallback
    }
  }

  // Method 2: Common Name fallback (Standard in ICP-Brasil: "NOME COMPLETO:01234567890")
  const subjectStr = x509.subject;
  const cnMatch = subjectStr.match(/CN=([^,\n/]+)/i);
  if (cnMatch) {
    const commonName = cnMatch[1].trim();
    // Look for 11 digits preceded by : or space
    const cpfMatch = commonName.match(/(?:[:\s-]|^)(\d{11})(?:[:\s-]|$)/);
    if (cpfMatch) {
      return cpfMatch[1];
    }
  }

  // Method 3: Search subject string directly for 11 consecutive digits after colon
  const colonMatch = subjectStr.match(/:(\d{11})/);
  if (colonMatch) {
    return colonMatch[1];
  }

  return null;
}

/**
 * Parse an X.509 certificate from PEM or Base64 or DER buffer.
 */
export function parseX509Certificate(
  certInput: string | Buffer,
  alias = ''
): CertificateInfo {
  let derBuffer: Buffer;
  let pemString: string;

  if (Buffer.isBuffer(certInput)) {
    derBuffer = certInput;
    const base64 = derBuffer.toString('base64');
    pemString = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join('\n') || base64}\n-----END CERTIFICATE-----`;
  } else if (typeof certInput === 'string') {
    if (certInput.includes('-----BEGIN CERTIFICATE-----')) {
      pemString = certInput.trim();
      const base64 = pemString
        .replace(/-----BEGIN CERTIFICATE-----/g, '')
        .replace(/-----END CERTIFICATE-----/g, '')
        .replace(/\s+/g, '');
      derBuffer = Buffer.from(base64, 'base64');
    } else {
      // Raw base64 string
      const cleanBase64 = certInput.replace(/\s+/g, '');
      derBuffer = Buffer.from(cleanBase64, 'base64');
      pemString = `-----BEGIN CERTIFICATE-----\n${cleanBase64.match(/.{1,64}/g)?.join('\n') || cleanBase64}\n-----END CERTIFICATE-----`;
    }
  } else {
    throw new Error('Entrada de certificado inválida: esperado string ou Buffer');
  }

  const x509 = new crypto.X509Certificate(derBuffer);
  const cpf = extractCpfFromCertificate(x509, derBuffer);

  const cnMatch = x509.subject.match(/CN=([^,\n/]+)/i);
  const commonName = cnMatch ? cnMatch[1].trim() : x509.subject;

  return {
    alias: alias || commonName,
    rawPem: pemString,
    subject: x509.subject,
    issuer: x509.issuer,
    serialNumber: x509.serialNumber,
    fingerprint256: x509.fingerprint256,
    validFrom: new Date(x509.validFrom),
    validTo: new Date(x509.validTo),
    cpf,
    commonName,
  };
}
