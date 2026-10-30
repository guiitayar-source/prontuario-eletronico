// Receita simples: assinatura eletrônica independente da integração SNCR (decisão do titular,
// 30/10/2026). Sem banco e sem rede.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';

import {
  isPrescriptionCategory,
  prescriptionCategories,
  prescriptionSigningBlock,
} from '../lib/sncr/policy.ts';
import { validateNumberingInput } from '../lib/sncr/client.ts';
import { documentPdf } from '../lib/document-pdf.ts';

const T = (s) => new Date(s);

describe('receita simples na política', () => {
  it('nunca é bloqueada, antes ou depois do marco SNCR de 30/10/2026', () => {
    for (const now of [
      T('2026-10-29T12:00:00Z'),
      T('2026-10-30T03:00:00Z'), // 00:00 em Brasília
      T('2027-06-01T12:00:00Z'),
    ])
      assert.equal(prescriptionSigningBlock('SIMPLES', now), null);
  });

  it('RCE e RET seguem a transição SNCR; notificações continuam bloqueadas', () => {
    for (const category of ['RCE', 'RET']) {
      assert.equal(prescriptionSigningBlock(category, T('2026-10-30T12:00:00Z')), null);
      assert.equal(prescriptionSigningBlock(category, T('2027-03-04T02:59:59Z')), null);
      assert.match(prescriptionSigningBlock(category, T('2027-03-04T03:00:00Z')), /SNCR/);
    }
    assert.match(prescriptionSigningBlock('NRA', T('2026-10-29T12:00:00Z')), /SNCR/);
  });

  it('é categoria do documento, mas nunca entra num pedido de numeração SNCR', () => {
    assert.equal(isPrescriptionCategory('SIMPLES'), true);
    assert.equal(isPrescriptionCategory('outra'), false);
    assert.ok(prescriptionCategories.SIMPLES);
    assert.throws(() =>
      validateNumberingInput({ category: 'SIMPLES', conselho: 'CRM', documento: '12345', uf: 'SP' }),
    );
  });
});

describe('receita simples no PDF', () => {
  const base = {
    id: '00000000-0000-4000-8000-00000000a001',
    kind: 'Receita',
    patient_id: 'sintetico',
    patient_name: 'Paciente Sintético',
    physician_name: 'Dr. Médico Sintético',
    physician_registration: 'CRM 12345 SP',
    document_date: '2026-10-30',
    text: 'MED001 10mg - 1 cp ao dia',
    version: 1,
  };
  const pages = async (doc) =>
    (await PDFDocument.load(await documentPdf(doc, { isDraft: false }))).getPageCount();

  it('uma via, sem os quadros do controle especial; RCE continua em duas vias', async () => {
    const simple = await PDFDocument.load(
      await documentPdf({ ...base, prescription_category: 'SIMPLES' }, { isDraft: false }),
    );
    assert.equal(simple.getPageCount(), 1);
    assert.equal(simple.getTitle(), 'Receituário');
    assert.equal(await pages({ ...base, prescription_category: 'RCE' }), 2);
    assert.equal(await pages({ ...base, prescription_category: null }), 2);
  });

  it('notificação continua sem PDF eletrônico', async () => {
    await assert.rejects(
      () => documentPdf({ ...base, prescription_category: 'NRA' }, { isDraft: false }),
      /Receita de Controle Especial, receita sujeita à retenção e receita simples/,
    );
  });
});
