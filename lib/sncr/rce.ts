import { validCpf } from '../patient-fields.ts';
import { validateNumberingInput } from './client.ts';

export type RceFields = {
  crm: string;
  uf: string;
  passport: string;
  medicine: string;
  concentration: string;
  pharmaceuticalForm: string;
  quantity: string;
  dosage: string;
};
export const emptyRceFields = (): RceFields => ({
  crm: '',
  uf: '',
  passport: '',
  medicine: '',
  concentration: '',
  pharmaceuticalForm: '',
  quantity: '',
  dosage: '',
});
export type RceSnapshot = {
  schema: 1;
  patient: { name: string; identifier: string; address: string };
  prescriber: {
    name: string;
    cpf: string;
    crm: string;
    uf: string;
    address: string;
    phone: string;
  };
  medicine: {
    name: string;
    concentration: string;
    pharmaceuticalForm: string;
    quantity: string;
    dosage: string;
  };
  platform: string;
};
function required(v: unknown, label: string, max: number) {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[<>]/.test(v))
    throw new Error(`Confira ${label}.`);
  return v.trim().normalize('NFC');
}
export function validateRceFields(value: unknown): RceFields {
  const v = value as RceFields | null;
  if (!v) throw new Error('Preencha a RCE.');
  const identity = validateNumberingInput({
    category: 'RCE',
    conselho: 'CRM',
    documento: v.crm,
    uf: v.uf,
  });
  return {
    crm: identity.documento,
    uf: identity.uf,
    passport:
      typeof v.passport === 'string' && /^[A-Za-z0-9 -]{0,30}$/.test(v.passport)
        ? v.passport.trim()
        : '',
    medicine: required(v.medicine, 'o nome do medicamento', 200),
    concentration: required(v.concentration, 'a concentração', 100),
    pharmaceuticalForm: required(
      v.pharmaceuticalForm,
      'a forma farmacêutica',
      100,
    ),
    quantity: required(v.quantity, 'a quantidade', 120),
    dosage: required(v.dosage, 'a posologia', 10000),
  };
}
export function rceClinicalText(fields: RceFields) {
  // Same layout as the handwritten prescriptions: one item line, then the dosage.
  return `1) ${fields.medicine} ${fields.concentration} · ${fields.pharmaceuticalForm} · Quantidade: ${fields.quantity}\nPosologia: ${fields.dosage}`;
}
export function validateRceSnapshot(v: RceSnapshot): RceSnapshot {
  if (v?.schema !== 1) throw new Error('Versão da RCE inválida.');
  const fields = validateRceFields({
    crm: v.prescriber?.crm,
    uf: v.prescriber?.uf,
    passport: '',
    medicine: v.medicine?.name,
    concentration: v.medicine?.concentration,
    pharmaceuticalForm: v.medicine?.pharmaceuticalForm,
    quantity: v.medicine?.quantity,
    dosage: v.medicine?.dosage,
  });
  if (!validCpf(v.prescriber?.cpf || ''))
    throw new Error(
      'Conecte seu certificado Bird ID ou VIDaaS para vincular o CPF do prescritor.',
    );
  const identifier = required(
    v.patient?.identifier,
    'o CPF ou passaporte do paciente',
    40,
  );
  if (
    !validCpf(identifier) &&
    !/^Passaporte [A-Za-z0-9][A-Za-z0-9 -]{0,29}$/.test(identifier)
  )
    throw new Error('Confira o CPF ou passaporte do paciente.');
  return {
    schema: 1,
    patient: {
      name: required(v.patient?.name, 'o nome do paciente', 180),
      identifier,
      address: required(
        v.patient?.address,
        'o endereço completo do paciente',
        350,
      ),
    },
    prescriber: {
      name: required(v.prescriber?.name, 'o nome profissional', 180),
      cpf: v.prescriber.cpf,
      crm: fields.crm,
      uf: fields.uf,
      address: required(v.prescriber?.address, 'o endereço profissional', 350),
      phone: required(v.prescriber?.phone, 'o telefone profissional', 80),
    },
    medicine: {
      name: fields.medicine,
      concentration: fields.concentration,
      pharmaceuticalForm: fields.pharmaceuticalForm,
      quantity: fields.quantity,
      dosage: fields.dosage,
    },
    platform: required(v.platform, 'a identificação da plataforma', 180),
  };
}
export const rceStateLabels: Record<string, string> = {
  AWAITING_REVIEW:
    'Número reservado. Revise o PDF e confira o vínculo no SNCR antes de assinar.',
  PREPARING: 'Preparando o documento para assinatura.',
  SIGNING: 'Assinatura em andamento. Aguarde; não solicite outro número.',
  SIGNATURE_UNCERTAIN:
    'A assinatura precisa de conferência. O número foi preservado e não será reutilizado.',
  FINALIZING: 'Assinatura recebida. A recuperação do arquivo está pendente.',
  SIGNED:
    'RCE de teste assinada. Original disponível para baixar; sem validade para dispensação.',
  BLOCKED:
    'A verificação do documento falhou. O número foi bloqueado para impedir reutilização.',
  CANCELLED: 'Preparação descartada. O número não será reutilizado.',
};
