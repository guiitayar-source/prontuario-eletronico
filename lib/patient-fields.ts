export const DEMO_ID = 'demo-helena-0001';
export const fieldGroups = [
  {
    title: 'Identificação',
    fields: [
      ['name', 'Nome completo', 'text'],
      ['social_name', 'Nome social', 'text'],
      ['dob', 'Data de nascimento', 'date'],
      ['cpf', 'CPF', 'text'],
      ['rg', 'RG', 'text'],
      ['gender', 'Gênero (como informado)', 'text'],
      ['occupation', 'Profissão', 'text'],
      ['marital_status', 'Estado civil', 'text'],
      ['schooling', 'Escolaridade', 'text'],
      ['nationality', 'Nacionalidade', 'text'],
    ],
  },
  {
    title: 'Contatos',
    fields: [
      ['phone', 'Telefone principal', 'tel'],
      ['secondary_phone', 'Telefone alternativo', 'tel'],
      ['email', 'E-mail', 'email'],
      ['preferred_contact', 'Contato preferencial', 'text'],
    ],
  },
  {
    title: 'Endereço',
    fields: [
      ['zip_code', 'CEP', 'text'],
      ['street', 'Logradouro', 'text'],
      ['address_number', 'Número', 'text'],
      ['complement', 'Complemento', 'text'],
      ['neighborhood', 'Bairro', 'text'],
      ['city', 'Cidade', 'text'],
      ['state', 'UF', 'text'],
    ],
  },
  {
    title: 'Responsável e contato de emergência',
    fields: [
      ['guardian_name', 'Nome do responsável', 'text'],
      ['guardian_relationship', 'Vínculo do responsável', 'text'],
      ['guardian_phone', 'Telefone do responsável', 'tel'],
      ['emergency_name', 'Contato de emergência', 'text'],
      ['emergency_relationship', 'Vínculo do contato de emergência', 'text'],
      ['emergency_phone', 'Telefone de emergência', 'tel'],
    ],
  },
  {
    title: 'Informações administrativas',
    fields: [
      ['insurance', 'Convênio', 'text'],
      ['insurance_number', 'Número da carteirinha', 'text'],
      ['referral_source', 'Como chegou ao consultório', 'text'],
      ['admin_notes', 'Observações administrativas', 'textarea'],
    ],
  },
] as const;
export type Field = (typeof fieldGroups)[number]['fields'][number][0];
export type PatientInput = Record<Field, string>;
export type Patient = PatientInput & {
  id: string;
  version: number;
  created_at: number;
  updated_at: number;
  draft_key: string;
};
export const fields = fieldGroups.flatMap((group) =>
  group.fields.map((f) => f[0]),
);
export function emptyPatient(): PatientInput {
  return Object.fromEntries(fields.map((f) => [f, ''])) as PatientInput;
}
export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0])
    .filter((_, i, a) => i === 0 || i === a.length - 1)
    .join('')
    .toUpperCase();
export function age(dob: string) {
  if (!dob) return 'Nascimento não informado';
  const [y, m, d] = dob.split('-').map(Number),
    today = new Date();
  let years = today.getFullYear() - y;
  if (
    today.getMonth() + 1 < m ||
    (today.getMonth() + 1 === m && today.getDate() < d)
  )
    years--;
  return `${years} anos`;
}
