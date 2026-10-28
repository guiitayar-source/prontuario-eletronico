import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { HttpError } from '../supabase/server.ts';

export const secretHash = (s: string) =>
  createHash('sha256').update(s).digest('hex');
export const randomSecret = () => randomBytes(32).toString('base64url');
function key() {
  const value = process.env.SNCR_SESSION_ENCRYPTION_KEY || '';
  if (!/^[a-fA-F0-9]{64}$/.test(value))
    throw new HttpError(
      503,
      'Chave de proteção de sessões SNCR não configurada.',
    );
  return Buffer.from(value, 'hex');
}
export function sealSession(value: string, aad: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(`psywrite-sncr-v1:${aad}`));
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return `v1.${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`;
}
export function openSession(value: string, aad: string) {
  try {
    if (!/^v1\.[a-f0-9]{24}\.[a-f0-9]{32}\.[a-f0-9]+$/.test(value))
      throw Error();
    const [, iv, tag, encrypted] = value.split('.');
    const cipher = createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(iv, 'hex'),
    );
    cipher.setAAD(Buffer.from(`psywrite-sncr-v1:${aad}`));
    cipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([
      cipher.update(Buffer.from(encrypted, 'hex')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw new HttpError(403, 'Sessão SNCR inválida; conecte novamente.');
  }
}
