import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { documentPdf } from '../lib/document-pdf.ts';
import { documentKinds } from '../lib/document-fields.ts';

const base = {
  id: 'synthetic',
  patient_id: 'patient',
  patient_name: 'Paciente Exemplo',
  physician_name: 'Médica Exemplo',
  physician_registration: 'CRM 12345 SP',
  document_date: '2026-11-03',
  version: 1,
  status: 'DRAFT',
  letterhead_title: 'CONSULTÓRIO EXEMPLO',
  letterhead_address: 'Rua Exemplo, nº 1 · Sala 2',
  letterhead_phone: 'Tel.: (00) 0000-0000',
};

describe('layout timbrado dos documentos (exceto receitas)', () => {
  for (const kind of documentKinds.filter((k) => k !== 'Receita'))
    for (const electronic of [false, true])
      it(`${kind}${electronic ? ' (eletrônico)' : ''} gera A4 em uma página`, async () => {
        const pdf = await PDFDocument.load(
          await documentPdf(
            { ...base, kind, text: 'Solicito:\n\nHemograma completo' },
            { electronic },
          ),
        );
        assert.equal(pdf.getPageCount(), 1);
        assert.deepEqual(pdf.getPage(0).getSize(), {
          width: 595.28,
          height: 841.89,
        });
        assert.equal(pdf.getTitle(), kind);
      });
  it('texto longo continua em páginas seguintes', async () => {
    const text =
      'Parágrafo de acompanhamento com acentuação e revisão clínica.\n\n'.repeat(
        80,
      );
    const pdf = await PDFDocument.load(
      await documentPdf({ ...base, kind: 'Relatório', text }),
    );
    assert.ok(pdf.getPageCount() >= 3);
  });
});
