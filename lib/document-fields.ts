export const documentKinds = [
  'Declaração de comparecimento',
  'Atestado',
  'Relatório',
  'Receita',
  'Pedido de exames',
  'Encaminhamento',
  'Documento livre',
];

export type PrescriptionModality =
  | 'controle_especial'
  | 'retencao'
  | 'notificacao_b'
  | 'notificacao_b2'
  | 'notificacao_a'
  | 'simples';

export const prescriptionModalities: {
  id: PrescriptionModality;
  label: string;
  pdfTitle: string;
  twoCopies: boolean;
  buyerSupplierBoxes: boolean;
  requiresSncrWhenSigned: boolean;
}[] = [
  {
    id: 'controle_especial',
    label: 'Receituário de controle especial (Listas C1/C5 — 2 vias)',
    pdfTitle: 'Receituário de controle especial',
    twoCopies: true,
    buyerSupplierBoxes: true,
    requiresSncrWhenSigned: false,
  },
  {
    id: 'retencao',
    label: 'Receita sujeita a retenção (Antimicrobiano / GLP-1 — 2 vias)',
    pdfTitle: 'Receituário sujeito a retenção',
    twoCopies: true,
    buyerSupplierBoxes: true,
    requiresSncrWhenSigned: false,
  },
  {
    id: 'notificacao_b',
    label: 'Notificação de Receita B (SNCR digital)',
    pdfTitle: 'Notificação de Receita B — Controle Especial',
    twoCopies: true,
    buyerSupplierBoxes: true,
    requiresSncrWhenSigned: true,
  },
  {
    id: 'notificacao_a',
    label: 'Notificação de Receita A (Entorpecentes/Psicotrópicos — SNCR digital)',
    pdfTitle: 'Notificação de Receita A — Controle Especial',
    twoCopies: true,
    buyerSupplierBoxes: true,
    requiresSncrWhenSigned: true,
  },
  {
    id: 'notificacao_b2',
    label: 'Notificação de Receita B2 (SNCR digital)',
    pdfTitle: 'Notificação de Receita B2',
    twoCopies: false,
    buyerSupplierBoxes: false,
    requiresSncrWhenSigned: true,
  },
  {
    id: 'simples',
    label: 'Receita simples (Sem retenção — 1 via)',
    pdfTitle: 'Receituário',
    twoCopies: false,
    buyerSupplierBoxes: false,
    requiresSncrWhenSigned: false,
  },
];

export type ParsedPrescriptionMetadata = {
  modality: PrescriptionModality;
  sncrNumber: string;
  viaAdmin: string;
  bodyText: string;
};

const MODALITY_BY_HEADER: Record<string, PrescriptionModality> = {
  'controle especial': 'controle_especial',
  'receituario de controle especial': 'controle_especial',
  'receituário de controle especial': 'controle_especial',
  controle_especial: 'controle_especial',
  retencao: 'retencao',
  'retenção': 'retencao',
  'receita sujeita a retencao': 'retencao',
  'receita sujeita a retenção': 'retencao',
  'receituario sujeito a retencao': 'retencao',
  'receituário sujeito a retenção': 'retencao',
  notificacao_b: 'notificacao_b',
  notificacao_b2: 'notificacao_b2',
  'notificação de receita b2': 'notificacao_b2',
  'notificacao de receita b2': 'notificacao_b2',
  'notificação b2': 'notificacao_b2',
  'notificação de receita b': 'notificacao_b',
  'notificacao de receita b': 'notificacao_b',
  'notificação b': 'notificacao_b',
  notificacao_a: 'notificacao_a',
  'notificação de receita a': 'notificacao_a',
  'notificacao de receita a': 'notificacao_a',
  'notificação a': 'notificacao_a',
  simples: 'simples',
  'receita simples': 'simples',
  receituario: 'simples',
  'receituário': 'simples',
};

const MODALITY_HEADER_VALUE: Record<PrescriptionModality, string> = {
  controle_especial: 'Controle especial',
  retencao: 'Retenção',
  notificacao_b: 'Notificação de Receita B',
  notificacao_b2: 'Notificação de Receita B2',
  notificacao_a: 'Notificação de Receita A',
  simples: 'Receita simples',
};

/**
 * Extrai metadados opcionais (Modalidade, SNCR e Via de administração) das linhas
 * iniciais do texto da receita, mantendo total compatibilidade com receitas existentes.
 */
export function parsePrescriptionText(rawText: string): ParsedPrescriptionMetadata {
  const normalized = (rawText || '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let modality: PrescriptionModality = 'controle_especial';
  let sncrNumber = '';
  let viaAdmin = 'Uso oral';
  let idx = 0;

  while (idx < lines.length) {
    const trimmed = lines[idx].trim();
    if (!trimmed) {
      idx++;
      continue;
    }
    const modMatch = trimmed.match(/^modalidade:\s*(.+)$/i);
    if (modMatch) {
      const key = modMatch[1].trim().toLowerCase();
      if (MODALITY_BY_HEADER[key]) {
        modality = MODALITY_BY_HEADER[key];
      }
      idx++;
      continue;
    }
    const sncrMatch = trimmed.match(/^(?:n[º°o]?\s*)?sncr:\s*(.+)$/i);
    if (sncrMatch) {
      sncrNumber = sncrMatch[1].trim();
      idx++;
      continue;
    }
    const viaMatch = trimmed.match(/^via\s+de\s+administra[cç][aã]o:\s*(.+)$/i);
    if (viaMatch) {
      viaAdmin = viaMatch[1].trim();
      idx++;
      continue;
    }
    break;
  }

  const bodyText = lines.slice(idx).join('\n').trim();
  return { modality, sncrNumber, viaAdmin, bodyText };
}

/**
 * Reconstrói o texto da receita preservando exatamente o formato padrão quando
 * a modalidade é 'controle_especial' e não há número SNCR.
 */
export function buildPrescriptionText(params: {
  modality?: PrescriptionModality;
  sncrNumber?: string;
  viaAdmin?: string;
  bodyText: string;
}): string {
  const modality = params.modality || 'controle_especial';
  const sncr = (params.sncrNumber || '').trim();
  const via = (params.viaAdmin ?? 'Uso oral').trim() || 'Uso oral';
  const headers: string[] = [];

  if (modality !== 'controle_especial') {
    headers.push(`Modalidade: ${MODALITY_HEADER_VALUE[modality]}`);
  }
  if (sncr) {
    headers.push(`SNCR: ${sncr}`);
  }
  headers.push(`Via de administração: ${via}`);

  const body = (params.bodyText || '').trim();
  return body ? `${headers.join('\n')}\n\n${body}` : `${headers.join('\n')}\n\n`;
}

export type ClinicalDocument = {
  id: string;
  patient_id: string;
  consultation_id: string | null;
  kind: string;
  patient_name: string;
  physician_name: string;
  physician_registration: string;
  document_date: string | null;
  text: string;
  version: number;
  updated_at?: string;
  author_id?: string;
  patient_cpf?: string;
  patient_address?: string;
  patient_city?: string;
  patient_state?: string;
  sncr_number?: string;
  prescription_modality?: PrescriptionModality;
  letterhead_title?: string;
  letterhead_address?: string;
  letterhead_phone?: string;
  status?: 'DRAFT' | 'FINALIZED' | 'SIGNING' | 'SIGNED' | 'SIGNATURE_FAILED' | 'SUPERSEDED';
  signed_pdf_path?: string | null;
};
export type DocumentProfile = {
  physician_name: string;
  physician_registration: string;
  letterhead_title: string;
  letterhead_address: string;
  letterhead_phone: string;
  cpf?: string | null;
};
export type PrescriptionTemplate = {
  id: string;
  name: string;
  text: string;
  updated_at?: string;
};
export function documentTemplate(kind: string) {
  return (
    (
      {
        'Declaração de comparecimento':
          'Declaro o comparecimento do(a) paciente acima identificado(a) ao atendimento em [data], das [horário inicial] às [horário final].',
        Atestado:
          'Atesto, para os devidos fins, que o(a) paciente acima identificado(a) necessita de [descrever a recomendação e o período, quando aplicável].',
        Relatório:
          'Finalidade do relatório: [informar]\n\nHistórico e acompanhamento:\n[Descrever]\n\nAvaliação e recomendações:\n[Descrever]',
        Receita:
          'Via de administração: Uso oral\n\n1) [Medicamento, forma farmacêutica e concentração] — [Quantidade]\n   Tomar [dose, posologia, horários e duração do tratamento]\n\nOrientações gerais:\n[Instruções de uso, cuidados e retorno]',
        'Pedido de exames':
          'Solicito:\n\n[Exames]\n\nIndicação clínica, quando necessária:\n[Preencher]',
        Encaminhamento:
          'Ao(À) [profissional, especialidade ou serviço de destino]\n\nEncaminho o(a) paciente acima identificado(a) para [avaliação, acompanhamento ou outra finalidade].\n\nMotivo do encaminhamento:\n[Descrever]\n\nResumo clínico e informações relevantes:\n[Preencher]\n\nSolicitação ao profissional ou serviço:\n[Descrever]',
        'Documento livre': '',
      } as Record<string, string>
    )[kind] || ''
  );
}

// Modelos e duplicações nunca transferem a identidade de uma numeração anterior.
export function stripSncrNumbers(text: string): string {
  return text.replace(/\r\n?/g,'\n').split('\n').filter(line=>!/^\s*(?:n[º°o]?\s*)?sncr\s*:/i.test(line)).join('\n');
}
