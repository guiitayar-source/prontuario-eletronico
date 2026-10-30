// RCE e RET com fluxos próprios (30/10/2026). Sem banco e sem rede.
// - RCE eletrônica: modelo oficial da Anvisa, CPF ou passaporte, sem numeração SNCR na transição,
//   consulta pela assinatura no ITI (RDC 1.000/2025, arts. 8º, 12 e 13; Portaria 344, art. 55).
// - RET: duas vias com nome, idade e sexo do paciente (RDC 471/2021); assinatura qualificada aceita.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFRawStream, PDFName } from 'pdf-lib';

import { documentPdf, patientAge } from '../lib/document-pdf.ts';
import { prescriptionSignatureRequirement } from '../lib/sncr/policy.ts';
import { rceTransitionSnapshot } from '../lib/sncr/rce-transition.ts';
import { rcePdf, RCE_TRANSITION_NUMBER_TEXT } from '../lib/sncr/rce-pdf.ts';

const base = {
  id: '00000000-0000-4000-8000-00000000b001',
  kind: 'Receita',
  patient_id: 'sintetico',
  patient_name: 'Paciente Sintético',
  physician_name: 'Dr. Médico Sintético',
  physician_registration: 'CRM 12345 SP',
  document_date: '2026-10-30',
  text: 'Amoxicilina 500 mg - 1 cápsula de 8/8 h por 7 dias',
  version: 1,
  patient_address: 'Rua Sintética, nº 100',
  patient_address_number: '100',
  patient_city: 'São Paulo',
  patient_state: 'SP',
  patient_zip_code: '01000-000',
  patient_cpf: '111.444.777-35',
  patient_birth_date: '1990-11-15',
  patient_gender: 'Feminino',
  letterhead_address: 'Av. Sintética, 200 - São Paulo - SP',
  letterhead_phone: '(11) 0000-0000',
  prescriber_cpf: '52998224725',
};
const rceFields = {
  crm: '12345',
  uf: 'SP',
  passport: '',
  medicine: 'Clonazepam',
  concentration: '2 mg',
  pharmaceuticalForm: 'Comprimido',
  quantity: '30 (trinta) comprimidos',
  dosage: 'Tomar 1 comprimido à noite.',
};
const rce = { ...base, prescription_category: 'RCE', rce_fields: rceFields };
const ret = { ...base, prescription_category: 'RET' };

const load = async (bytes) => PDFDocument.load(bytes);
// Texto desenhado com fonte padrão (Helvetica, WinAnsi) aparece como hexadecimal no fluxo.
async function pdfContains(bytes, text) {
  const pdf = await load(bytes);
  const hex = Buffer.from(text, 'latin1').toString('hex');
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let content = Buffer.from(obj.contents);
    if (obj.dict.get(PDFName.of('Filter')) === PDFName.of('FlateDecode'))
      try {
        content = inflateSync(content);
      } catch {
        continue;
      }
    const latin = content.toString('latin1');
    if (latin.toLowerCase().includes(hex) || latin.includes(text)) return true;
  }
  return false;
}

describe('assinatura exigida por categoria', () => {
  it('RCE qualificada; RET avançada ou qualificada', () => {
    assert.equal(prescriptionSignatureRequirement.RCE, 'QUALIFICADA');
    assert.equal(prescriptionSignatureRequirement.RET, 'AVANCADA_OU_QUALIFICADA');
  });
});

describe('idade do paciente na data de emissão', () => {
  it('anos completos, com aniversário ainda não ocorrido', () => {
    assert.equal(patientAge({ patient_birth_date: '1990-11-15', document_date: '2026-10-30' }), 35);
    assert.equal(patientAge({ patient_birth_date: '1990-10-30', document_date: '2026-10-30' }), 36);
    assert.equal(patientAge({ patient_birth_date: '', document_date: '2026-10-30' }), null);
    assert.equal(patientAge({ patient_birth_date: '2030-01-01', document_date: '2026-10-30' }), null);
  });
});

describe('RET', () => {
  it('duas vias com título próprio; impressão admite campos em branco', async () => {
    const printed = await load(await documentPdf({ ...ret, patient_birth_date: '', patient_gender: '' }));
    assert.equal(printed.getPageCount(), 2);
    assert.equal(printed.getTitle(), 'Receituário sujeito à retenção');
  });
  it('emissão eletrônica bloqueada sem idade, sexo ou dados do emitente', async () => {
    const electronic = (doc) => documentPdf(doc, { isDraft: false, electronic: true });
    await assert.rejects(electronic({ ...ret, patient_birth_date: '' }), /data de nascimento/);
    await assert.rejects(electronic({ ...ret, patient_gender: ' ' }), /sexo do paciente/);
    await assert.rejects(electronic({ ...ret, letterhead_phone: '' }), /endereço completo e telefone/);
    const pdf = await load(await electronic(ret));
    assert.equal(pdf.getPageCount(), 2);
    assert.equal(pdf.getTitle(), 'Receituário sujeito à retenção');
  });
});

describe('RCE eletrônica no modelo oficial (transição, sem número SNCR)', () => {
  const electronic = (doc) =>
    documentPdf(doc, { isDraft: false, electronic: true, issuedAt: new Date('2026-10-30T15:00:00Z') });

  it('usa o modelo oficial com CPF, endereço, ITI e sem marca de homologação', async () => {
    const bytes = await electronic(rce);
    const pdf = await load(bytes);
    assert.equal(pdf.getTitle(), 'Receita de Controle Especial');
    assert.equal(pdf.getPageCount(), 1);
    assert.ok(await pdfContains(bytes, RCE_TRANSITION_NUMBER_TEXT));
    assert.ok(await pdfContains(bytes, '11144477735'));
    assert.ok(await pdfContains(bytes, 'Verifique a assinatura digital em validar.iti.gov.br'));
    assert.ok(await pdfContains(bytes, 'Clonazepam'));
    assert.ok(await pdfContains(bytes, '30/10/2026'));
    assert.equal(await pdfContains(bytes, 'HOMOLOGACAO'), false);
  });

  it('passaporte só quando não há CPF', async () => {
    const snapshot = rceTransitionSnapshot({
      ...rce,
      patient_cpf: '',
      rce_fields: { ...rceFields, passport: 'AB123456' },
    });
    assert.equal(snapshot.patient.identifier, 'Passaporte AB123456');
    assert.equal(rceTransitionSnapshot(rce).patient.identifier, '11144477735');
  });

  it('emissão bloqueada se faltar campo obrigatório', async () => {
    await assert.rejects(electronic({ ...rce, rce_fields: null }), /preencha CRM\/UF, medicamento/);
    await assert.rejects(electronic({ ...rce, patient_cpf: '' }), /CPF do paciente/);
    await assert.rejects(electronic({ ...rce, patient_address_number: '' }), /logradouro, número, cidade e UF/);
    await assert.rejects(electronic({ ...rce, letterhead_address: '' }), /endereço completo e telefone/);
    await assert.rejects(electronic({ ...rce, prescriber_cpf: '' }), /CPF do prescritor/);
    await assert.rejects(
      electronic({ ...rce, rce_fields: { ...rceFields, medicine: '' } }),
      /nome do medicamento/,
    );
  });

  it('o modelo de transição nunca recebe número, e o de homologação exige o formato SNCR', async () => {
    const snapshot = rceTransitionSnapshot(rce);
    await assert.rejects(rcePdf(snapshot, '2602.6-53.0000001', new Date(), 'transition'), /numeração/);
    await assert.rejects(rcePdf(snapshot, null, new Date(), 'hmg'), /numeração/);
    const training = await rcePdf(snapshot, '2602.6-53.0000001', new Date(), 'hmg');
    assert.ok(await pdfContains(training, 'HOMOLOGACAO'));
  });

  it('impressão para assinatura manual continua no desenho de duas vias', async () => {
    const printed = await load(await documentPdf(rce));
    assert.equal(printed.getPageCount(), 2);
    assert.equal(printed.getTitle(), 'Receituário de controle especial');
  });
});

describe('notificações', () => {
  it('continuam sem PDF eletrônico', async () => {
    for (const prescription_category of ['NRA', 'NRB', 'NRB2', 'NRR', 'NRT'])
      await assert.rejects(
        documentPdf({ ...base, prescription_category }, { electronic: true }),
        /Receita de Controle Especial, receita sujeita à retenção e receita simples/,
      );
  });
});
