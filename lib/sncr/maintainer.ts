// Backend apenas. Identifica a mantenedora da plataforma, nunca a clínica do prescritor.
// Não autentica pessoas, não consulta cadastros e não habilita chamadas externas.
import { HttpError } from '../supabase/server.ts';

type MaintainerEnv = NodeJS.ProcessEnv;
export type PlatformMaintainer = Readonly<{
  legalName: string;
  cnpj: string;
  regulatoryStatus: 'unverified';
}>;

export function normalizeMaintainerCnpj(input: string): string {
  const value = input.trim();
  if (!/^(?:\d{14}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})$/.test(value)) {
    throw new HttpError(503, 'CNPJ da mantenedora ausente ou com formato inválido.');
  }
  const digits = value.replace(/[./-]/g, '');
  const checkDigit = (base: string) => {
    let weight = base.length - 7;
    let sum = 0;
    for (const char of base) {
      sum += Number(char) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const remainder = sum % 11;
    return remainder < 2 ? '0' : String(11 - remainder);
  };
  const first = checkDigit(digits.slice(0, 12));
  if (/^(\d)\1{13}$/.test(digits) || digits.slice(-2) !== first + checkDigit(digits.slice(0, 12) + first)) {
    throw new HttpError(503, 'Dígitos verificadores do CNPJ da mantenedora inválidos.');
  }
  return digits;
}

export function platformMaintainer(env: MaintainerEnv = process.env): PlatformMaintainer | null {
  if (typeof window !== 'undefined') throw new Error('Configuração da mantenedora exclusiva do backend.');
  const legalName = env.PSYWRITE_MAINTAINER_LEGAL_NAME?.trim() || '';
  const rawCnpj = env.PSYWRITE_MAINTAINER_CNPJ?.trim() || '';
  if (!legalName && !rawCnpj) return null;
  if (legalName.length < 2 || legalName.length > 180 || /[\x00-\x1f\x7f]/.test(legalName)) {
    throw new HttpError(503, 'Configure a razão social da mantenedora no backend.');
  }
  return Object.freeze({legalName, cnpj: normalizeMaintainerCnpj(rawCnpj), regulatoryStatus: 'unverified' as const});
}

// Manual SNCR, 3ª edição, §§ 2.3.2.3 e 2.3.2.5.ii (pp. 13–14).
// Somente projeção de dados; não envia HTTP, não obtém token nem remove bloqueios.
// Não adicionar este campo a outros recursos sem confirmação de seu contrato.
export function rceRetMaintainerFields(env: MaintainerEnv = process.env): {cnpj: string} {
  const maintainer = platformMaintainer(env);
  if (!maintainer) throw new HttpError(503, 'Mantenedora da plataforma ainda não configurada.');
  return {cnpj: maintainer.cnpj};
}
