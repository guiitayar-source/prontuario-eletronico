import type { DocumentPrescriptionCategory } from './sncr/policy.ts';
import type { RceFields } from './sncr/rce.ts';
export const documentKinds = [
  'Declaração de comparecimento',
  'Atestado',
  'Relatório',
  'Receita',
  'Pedido de exames',
  'Encaminhamento',
  'Documento livre',
];
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
  patient_address?: string;
  patient_city?: string;
  patient_state?: string;
  letterhead_title?: string;
  letterhead_address?: string;
  letterhead_phone?: string;
  status?: 'DRAFT' | 'FINALIZED' | 'SIGNING' | 'SIGNED' | 'SIGNATURE_FAILED' | 'SUPERSEDED';
  signed_pdf_path?: string | null;
  prescription_category?: DocumentPrescriptionCategory | null;
  rce_fields?: RceFields | null;
  rce_emission?: { id: string; state: string; number: string; environment: 'hmg' } | null;
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
