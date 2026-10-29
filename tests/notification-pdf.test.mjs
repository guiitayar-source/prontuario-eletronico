import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { notificationSimulationPdf, NOTIFICATION_TEMPLATES, NOTIFICATION_CONSULTATION_URL, notificationConsultationUrl } from '../lib/sncr/notification-pdf.ts';
import { notificationApiType, parseNotificationFields } from '../lib/sncr/notification-fields.ts';
import { syntheticRce, syntheticRceText } from './helpers/rce-fixture.mjs';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { padesService } from '../lib/signature/pades-service.ts';

const dir = 'output/pdf/lote5b';
await mkdir(dir, { recursive: true });
const modalities = ['notificacao_a','notificacao_b','notificacao_b2'];
const fixture = modality => ({ ...syntheticRce,
  text: `Modalidade: Notificação de Receita ${notificationApiType[modality].slice(2)}\n${syntheticRceText}`,
  prescription_modality: modality,
  sncr_number: `SIMULADO.5b.${notificationApiType[modality]}.0000001`,
});
const textOf = path => execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
const streams = p => {
  const contents = p.node.Contents();
  return (contents instanceof PDFArray ? contents.asArray() : [contents])
    .map(ref => Buffer.from(decodePDFRawStream(p.doc.context.lookup(ref)).decode()));
};

test('identificadores separados e URL oficial preserva a numeração exata', () => {
  assert.deepEqual(modalities.map(m => notificationApiType[m]), ['NRA','NRB','NRB2']);
  assert.equal(NOTIFICATION_CONSULTATION_URL, 'https://sncr.anvisa.gov.br/receita/consultar');
  assert.equal(notificationConsultationUrl('0000.0-00.0000000'), `${NOTIFICATION_CONSULTATION_URL}?numero=0000.0-00.0000000`);
  assert.equal(notificationConsultationUrl('SIMULADO.001'), `${NOTIFICATION_CONSULTATION_URL}?numero=SIMULADO.001`);
  for (const number of ['00000000000000', '0000.0-00.000000', ' 0000.0-00.0000000', '0000.0-00.0000000&x=1', 'MANUAL.001'])
    assert.throws(() => notificationConsultationUrl(number), /Formato/);
});

for (const modality of modalities) {
  test(`${notificationApiType[modality]} preserva seu PDF oficial e gera amostra sintética`, async () => {
    const d = fixture(modality);
    const original = await PDFDocument.load(await readFile(NOTIFICATION_TEMPLATES[modality].path));
    const bytes = await notificationSimulationPdf(d);
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
    assert.deepEqual(pdf.getPage(0).getSize(), original.getPage(0).getSize());
    const generated = streams(pdf.getPage(0));
    for (const source of streams(original.getPage(0))) assert.ok(generated.some(s => s.equals(source)), 'desenho oficial alterado');
    const path = `${dir}/${notificationApiType[modality].toLowerCase()}-sintetica.pdf`;
    await writeFile(path, bytes);
    const text = textOf(path);
    for (const term of [notificationApiType[modality].slice(2), d.sncr_number, 'MED001', '10 mg (teste)', 'Comprimido de teste', '30 (trinta)', 'Uso oral', 'SIMULACAO LOCAL'])
      assert.ok(text.includes(term), `ausente: ${term}`);
    assert.doesNotMatch(text, /1ª via|2ª via|IDENTIFICAÇÃO DO COMPRADOR/);
    const png = `${dir}/${notificationApiType[modality].toLowerCase()}-sintetica`;
    execFileSync('pdftoppm', ['-f','1','-singlefile','-scale-to','1400','-png',path,png]);
    const qr = execFileSync('zbarimg', ['--quiet','--raw',`${png}.png`], { encoding: 'utf8' }).trim();
    assert.equal(qr, `${NOTIFICATION_CONSULTATION_URL}?numero=${encodeURIComponent(d.sncr_number)}`);
    const prepared = await padesService.preparePdfForSignature(bytes, { signerName: 'SIMULACAO LOCAL', drawVisualBox: false });
    const signed = await new MockBirdIdProvider({ doctorName: 'SIMULACAO LOCAL' }).signHash({ accessToken: 'synthetic', certificateAlias: 'synthetic', hashHex: prepared.digestHex, documentAlias: modality });
    const signedBytes = padesService.embedSignature(prepared, signed.cmsSignatureBase64);
    assert.equal((await padesService.verifyPadesSignature(signedBytes)).isValid, true);
    await writeFile(`${dir}/${notificationApiType[modality].toLowerCase()}-assinada-sintetica.pdf`, signedBytes);
  });
  test(`${notificationApiType[modality]} bloqueia ausência, divergência e excesso`, async () => {
    const d = fixture(modality);
    assert.equal(parseNotificationFields(d.text, modality).medication.startsWith('MED001'), true);
    for (const changed of [
      { sncr_number: undefined }, { sncr_number: 'MANUAL.001' },
      { prescription_modality: 'notificacao_b' === modality ? 'notificacao_b2' : 'notificacao_b' },
      { text: d.text.replace('Concentração: 10 mg (teste)\n', '') },
      { text: d.text.replace('Posologia: Instrução sintética:', 'Posologia: ' + 'Linha de teste\n'.repeat(30)) },
      { patient_name: '' }, { physician_registration: '' },
      { patient_cpf: '' }, { document_date: '' },
    ]) await assert.rejects(notificationSimulationPdf({ ...d, ...changed }));
    await assert.rejects(notificationSimulationPdf({ ...d, sncr_number: '0000.0-00.0000000' }), /sintético/);
  });
}

test('B2 nunca passa pelo parser ou modelo B', async () => {
  const b2 = fixture('notificacao_b2');
  assert.throws(() => parseNotificationFields(b2.text, 'notificacao_b'));
  await assert.rejects(notificationSimulationPdf({ ...b2, prescription_modality: 'notificacao_b' }));
});
