export const documentKinds = [
  'Declaração de comparecimento',
  'Atestado',
  'Relatório',
  'Receita',
  'Pedido de exames',
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
        'Documento livre': '',
      } as Record<string, string>
    )[kind] || ''
  );
}
