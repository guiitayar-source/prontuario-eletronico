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

export function validCpf(cpf: string) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;
  for (let n = 9; n < 11; n++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(cpf[i]) * (n + 1 - i);
    let digit = (sum * 10) % 11;
    if (digit === 10) digit = 0;
    if (digit !== Number(cpf[n])) return false;
  }
  return true;
}

export function validate(data: Record<string, unknown>) {
  const p = emptyPatient(),
    errors: Record<string, string> = {};
  for (const f of fields) {
    if (data[f] != null && typeof data[f] !== 'string') {
      errors[f] = 'Informe um texto.';
      continue;
    }
    p[f] = String(data[f] || '').trim();
    if (p[f].length > (f === 'admin_notes' ? 2000 : 180))
      errors[f] = 'Texto muito longo.';
  }
  if (p.name.length < 2) errors.name = 'Informe o nome completo.';
  if (p.dob) {
    const parsed = new Date(p.dob + 'T12:00:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(p.dob) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== p.dob ||
      p.dob > new Date().toISOString().slice(0, 10) ||
      Number(p.dob.slice(0, 4)) < 1850
    )
      errors.dob = 'Informe uma data de nascimento válida.';
  }
  p.cpf = p.cpf.replace(/[.\-\s]/g, '');
  if (p.cpf && !validCpf(p.cpf))
    errors.cpf = 'CPF inválido. Você também pode deixar este campo vazio.';
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email))
    errors.email = 'Confira o e-mail.';
  for (const f of [
    'phone',
    'secondary_phone',
    'guardian_phone',
    'emergency_phone',
  ] as const) {
    if (p[f] && !/^[+\d() .-]{7,30}$/.test(p[f]))
      errors[f] = 'Confira o número de telefone.';
  }
  p.state = p.state.toUpperCase();
  if (
    p.state &&
    ![
      'AC',
      'AL',
      'AP',
      'AM',
      'BA',
      'CE',
      'DF',
      'ES',
      'GO',
      'MA',
      'MT',
      'MS',
      'MG',
      'PA',
      'PB',
      'PR',
      'PE',
      'PI',
      'RJ',
      'RN',
      'RS',
      'RO',
      'RR',
      'SC',
      'SP',
      'SE',
      'TO',
    ].includes(p.state)
  )
    errors.state = 'Use a sigla da UF.';
  p.zip_code = p.zip_code.replace(/[-\s]/g, '');
  if (p.zip_code && !/^\d{8}$/.test(p.zip_code))
    errors.zip_code = 'Informe os 8 dígitos do CEP.';
  return { p, errors };
}
