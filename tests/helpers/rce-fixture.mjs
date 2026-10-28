// Exclusivamente sintético. Não representa prescrição, pessoa ou mantenedora real.
export const syntheticRceText = `Via de administração: Uso oral

Nome do medicamento ou substância: MED001 - Substância sintética para teste
Concentração: 10 mg (teste)
Forma farmacêutica: Comprimido de teste
Quantidade: 30 (trinta) comprimidos de teste
Posologia: Instrução sintética: usar conforme cenário de teste.
Orientações complementares: Não utilizar clinicamente. Retorno de teste em 30 dias.`;
export const syntheticRceData = {
  patient_cpf: '52998224725',
  patient_address: 'Rua Sintética, 100, Centro',
  patient_city: 'Cidade de Teste',
  patient_state: 'SP',
  letterhead_address: 'Rua do Teste, 200 - Cidade de Teste - SP',
  letterhead_phone: '(11) 0000-0000',
};
export const syntheticRce = {
  id: 'rce-synthetic-only', patient_id: 'synthetic-patient', consultation_id: null,
  kind: 'Receita', patient_name: 'Paciente Sintético', physician_name: 'Prescritora Sintética',
  physician_registration: 'CRM 12345 SP', document_date: '2026-10-28', version: 1,
  text: syntheticRceText, sncr_number: 'SIMULADO.5a.0000001', ...syntheticRceData,
};
