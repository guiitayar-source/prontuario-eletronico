import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import {
  PDFDocument,
  PDFName,
  StandardFonts,
} from 'pdf-lib';
import { padesService } from '../lib/signature/pades-service.ts';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { documentPdf } from '../lib/document-pdf.ts';

const provider = new MockBirdIdProvider({
  mockCpf: '52998224725',
  doctorName: 'DR. MEDICO SINTETICO',
});

async function createSampleSignedPdf(text = 'Prescricao Medica Original - Uso Oral') {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 50, y: 760, size: 12, font });
  const unsignedBytes = await pdfDoc.save({ useObjectStreams: false });

  const prepared = await padesService.preparePdfForSignature(unsignedBytes, {
    signerName: 'DR. MEDICO SINTETICO',
    signerCpf: '529.982.247-25',
    doctorCrm: 'CRM 12345 SP',
    reason: 'Teste de integridade PAdES 6F.1',
  });

  const signResult = await provider.signHash({
    accessToken: 'synthetic-token',
    certificateAlias: 'e-CPF',
    hashHex: prepared.digestHex,
    documentAlias: 'Doc 6F.1',
  });

  const signedPdf = padesService.embedSignature(
    prepared,
    signResult.cmsSignatureBase64,
  );
  return { unsignedBytes, prepared, signResult, signedPdf };
}

/**
 * Builds a syntactically valid PDF incremental update appended after `basePdf`.
 */
function appendIncrementalRevision(
  basePdf,
  {
    objects,
    rootRefStr,
    size,
  },
) {
  const baseStr = basePdf.toString('latin1');
  const prevMatch = [...baseStr.matchAll(/startxref\s+(\d+)\s*%%EOF/g)].pop();
  assert.ok(prevMatch, 'Base PDF must contain startxref');
  const prevXrefOffset = Number(prevMatch[1]);

  const chunks = [basePdf];
  let currentOffset = basePdf.length;
  const pushAscii = (str) => {
    const buf = Buffer.from(str, 'latin1');
    chunks.push(buf);
    currentOffset += buf.length;
  };

  if (basePdf[basePdf.length - 1] !== 0x0a) {
    pushAscii('\n');
  }

  const xrefEntries = [{ objNum: 0, offset: 0, gen: 65535, type: 'f' }];
  for (const obj of objects) {
    const offset = currentOffset;
    pushAscii(`${obj.objNum} ${obj.gen ?? 0} obj\n${obj.body}\nendobj\n`);
    xrefEntries.push({
      objNum: obj.objNum,
      offset,
      gen: obj.gen ?? 0,
      type: 'n',
    });
  }

  xrefEntries.sort((a, b) => a.objNum - b.objNum);
  const xrefOffset = currentOffset;
  pushAscii('xref\n');
  for (const entry of xrefEntries) {
    const offStr = String(entry.offset).padStart(10, '0');
    const genStr = String(entry.gen).padStart(5, '0');
    pushAscii(`${entry.objNum} 1\n${offStr} ${genStr} ${entry.type} \n`);
  }
  pushAscii(
    `trailer\n<< /Size ${size} /Root ${rootRefStr} /Prev ${prevXrefOffset} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}

async function inspectPdfStructureRefs(pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const rootRef = doc.context.trailerInfo.Root;
  const page = doc.getPage(0);
  const pageRef = page.ref;
  let maxObjNum = 0;
  for (const [ref] of doc.context.enumerateIndirectObjects()) {
    if (ref.objectNumber > maxObjNum) maxObjNum = ref.objectNumber;
  }
  return {
    doc,
    rootRefStr: `${rootRef.objectNumber} ${rootRef.generationNumber} R`,
    rootObjNum: rootRef.objectNumber,
    pageRefStr: `${pageRef.objectNumber} ${pageRef.generationNumber} R`,
    pageObjNum: pageRef.objectNumber,
    pagesRefStr: page.node.get(PDFName.of('Parent')).toString(),
    maxObjNum,
  };
}

describe('Lote 6F.1 — Integridade Estrutural PAdES, ByteRange, Revisões Incrementais e CMS', () => {
  it('1. aceita PDF legítimo de revisão única e expõe estrutura explícita de integridade', async () => {
    const { signedPdf, prepared } = await createSampleSignedPdf();
    const res = await padesService.verifyPadesSignature(signedPdf);

    assert.equal(res.cryptographicIntegrity, true);
    assert.equal(res.cmsIntegrity.valid, true);
    assert.equal(res.cmsIntegrity.digestMatches, true);
    assert.equal(res.cmsIntegrity.signedAttrsPresent, true);
    assert.equal(res.cmsIntegrity.contentTypeValid, true);
    assert.equal(res.cmsIntegrity.messageDigestAttrHex, prepared.digestHex);
    assert.equal(res.cmsIntegrity.calculatedDigestHex, prepared.digestHex);

    assert.equal(res.pdfIntegrity.valid, true);
    assert.equal(res.pdfIntegrity.coversWholeDocument, true);
    assert.equal(res.pdfIntegrity.unsignedTrailingBytes, 0);
    assert.equal(res.pdfIntegrity.contentsPaddingValid, true);
    assert.equal(res.pdfIntegrity.hasUnauthorizedPostSignatureUpdate, false);
    assert.equal(res.pdfIntegrity.signatureRevisionsCount, 1);

    // Sem cadeia ICP-Brasil completa nem revogação, não pode ser VALID nem isTrusted
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.persistenceStatus, 'UNVERIFIED');
    assert.equal(res.isTrusted, false);
  });

  it('2. rejeita PDF assinado com revisão incremental posterior que modifica o conteúdo da página (Problema A)', async () => {
    const { signedPdf } = await createSampleSignedPdf();
    const info = await inspectPdfStructureRefs(signedPdf);
    const newStreamObjNum = info.maxObjNum + 1;

    // Cria revisão incremental posterior redefinindo a página para apontar para novo stream de texto
    const tamperedStream = 'BT /F1 14 Tf 50 700 Td (RECEITA ADULTERADA APOS ASSINATURA) Tj ET';
    const incrementallyModifiedPdf = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: newStreamObjNum + 1,
      objects: [
        {
          objNum: newStreamObjNum,
          body: `<< /Length ${tamperedStream.length} >>\nstream\n${tamperedStream}\nendstream`,
        },
        {
          objNum: info.pageObjNum,
          body: `<< /Type /Page /Parent ${info.pagesRefStr} /MediaBox [0 0 595.28 841.89] /Resources << >> /Contents ${newStreamObjNum} 0 R >>`,
        },
      ],
    });

    const res = await padesService.verifyPadesSignature(incrementallyModifiedPdf);
    assert.equal(res.pdfIntegrity.valid, false);
    assert.equal(res.pdfIntegrity.hasUnauthorizedPostSignatureUpdate, true);
    assert.equal(res.cryptographicIntegrity, false);
    assert.equal(res.status, 'INVALID');
    assert.equal(res.persistenceStatus, 'INVALID');
    assert.equal(res.isValid, false);
  });

  it('3. rejeita revisão incremental posterior que adiciona anotação visual na página sem alterar o stream original', async () => {
    const { signedPdf } = await createSampleSignedPdf();
    const info = await inspectPdfStructureRefs(signedPdf);
    const pageDict = info.doc.getPage(0).node;
    const origContents = pageDict.get(PDFName.of('Contents')).toString();
    const origResources = pageDict.get(PDFName.of('Resources')).toString();
    const annotObjNum = info.maxObjNum + 1;

    const tamperedWithAnnot = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: annotObjNum + 1,
      objects: [
        {
          objNum: annotObjNum,
          body: '<< /Type /Annot /Subtype /FreeText /Rect [50 700 400 780] /Contents (Sobreposicao maliciosa) >>',
        },
        {
          objNum: info.pageObjNum,
          body: `<< /Type /Page /Parent ${info.pagesRefStr} /MediaBox [0 0 595.28 841.89] /Resources ${origResources} /Contents ${origContents} /Annots [${annotObjNum} 0 R] >>`,
        },
      ],
    });

    const res = await padesService.verifyPadesSignature(tamperedWithAnnot);
    assert.equal(res.pdfIntegrity.valid, false);
    assert.equal(res.pdfIntegrity.hasUnauthorizedPostSignatureUpdate, true);
    assert.equal(res.cryptographicIntegrity, false);
    assert.equal(res.status, 'INVALID');
    assert.equal(res.isValid, false);
  });

  it('4. aceita PDF com revisão incremental ANTERIOR à assinatura (coberta pelo ByteRange)', async () => {
    // Revisão 1: PDF base
    const baseDoc = await PDFDocument.create();
    const page = baseDoc.addPage([595.28, 841.89]);
    const font = await baseDoc.embedFont(StandardFonts.Helvetica);
    page.drawText('Revisao 1 antes da assinatura', { x: 50, y: 760, size: 12, font });
    const rev1Bytes = Buffer.from(await baseDoc.save({ useObjectStreams: false }));

    // Revisão 2 (anterior à assinatura): revisão incremental real adicionando objeto de metadados
    const info = await inspectPdfStructureRefs(rev1Bytes);
    const dummyObjNum = info.maxObjNum + 1;
    const multiRevBeforeSign = appendIncrementalRevision(rev1Bytes, {
      rootRefStr: info.rootRefStr,
      size: dummyObjNum + 1,
      objects: [
        {
          objNum: dummyObjNum,
          body: '<< /Type /Metadata /Subtype /XML /Length 0 >>\nstream\n\nendstream',
        },
      ],
    });

    // Revisão 3: assinatura PAdES adicionada como revisão incremental cobrindo [0, total] (incluindo Revisões 1 e 2)
    const catalogDict = info.doc.catalog;
    const pagesEntry = catalogDict.get(PDFName.of('Pages')).toString();
    const sigObjNum = dummyObjNum + 1;
    const widgetObjNum = dummyObjNum + 2;
    const brPlaceholder = '/ByteRange [0 /********** /********** /**********]';
    const sigHexLen = 16384;
    const emptyContents = `<${'0'.repeat(sigHexLen)}>`;

    const draftRev3 = appendIncrementalRevision(multiRevBeforeSign, {
      rootRefStr: info.rootRefStr,
      size: widgetObjNum + 1,
      objects: [
        {
          objNum: sigObjNum,
          body: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached ${brPlaceholder} /Contents ${emptyContents} /Reason (Assinatura cobrindo revisoes anteriores) >>`,
        },
        {
          objNum: widgetObjNum,
          body: `<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /T (Signature1) /V ${sigObjNum} 0 R /P ${info.pageRefStr} >>`,
        },
        {
          objNum: info.rootObjNum,
          body: `<< /Type /Catalog /Pages ${pagesEntry} /AcroForm << /SigFlags 3 /Fields [${widgetObjNum} 0 R] >> >>`,
        },
      ],
    });

    const brPos = draftRev3.indexOf(brPlaceholder, multiRevBeforeSign.length);
    assert.ok(brPos > multiRevBeforeSign.length);
    const contentsPos = draftRev3.indexOf('/Contents <', brPos);
    const ltPos = draftRev3.indexOf('<', contentsPos);
    const gtPos = draftRev3.indexOf('>', ltPos);
    const byteRange = [0, ltPos, gtPos + 1, draftRev3.length - (gtPos + 1)];
    const actualBr = `/ByteRange [${byteRange.join(' ')}]`.padEnd(
      brPlaceholder.length,
      ' ',
    );

    const actualPdf = Buffer.concat([
      draftRev3.subarray(0, brPos),
      Buffer.from(actualBr, 'latin1'),
      draftRev3.subarray(brPos + brPlaceholder.length),
    ]);
    const contentToSign = Buffer.concat([
      actualPdf.subarray(byteRange[0], byteRange[0] + byteRange[1]),
      actualPdf.subarray(byteRange[2], byteRange[2] + byteRange[3]),
    ]);
    const digestHex = crypto.createHash('sha256').update(contentToSign).digest('hex');
    const sig = await provider.signHash({
      accessToken: 'x',
      certificateAlias: 'e-CPF',
      hashHex: digestHex,
      documentAlias: 'PreRev',
    });
    const signedMultiPre = padesService.embedSignature(
      {
        pdfWithPlaceholder: draftRev3,
        byteRange,
        contentToSign,
        digestHex,
        actualByteRangePdf: actualPdf,
      },
      sig.cmsSignatureBase64,
    );

    const res = await padesService.verifyPadesSignature(signedMultiPre);
    assert.equal(res.pdfIntegrity.valid, true, res.pdfIntegrity.error);
    assert.equal(res.pdfIntegrity.preSignatureRevisionsCount, 2);
    assert.equal(res.pdfIntegrity.signatureRevisionsCount, 1);
    assert.equal(res.pdfIntegrity.hasUnauthorizedPostSignatureUpdate, false);
    assert.equal(res.cryptographicIntegrity, true);
  });

  it('5. aceita atualização incremental PAdES LTV legítima (/DSS no /Catalog) sob política padrão e rejeita sob política estrita de emissão', async () => {
    const { signedPdf } = await createSampleSignedPdf();
    const info = await inspectPdfStructureRefs(signedPdf);
    const catalogDict = info.doc.catalog;
    const pagesEntry = catalogDict.get(PDFName.of('Pages')).toString();
    const acroFormEntry = catalogDict.get(PDFName.of('AcroForm'))?.toString();
    const dssObjNum = info.maxObjNum + 1;
    const certsArrObjNum = info.maxObjNum + 2;

    const catalogBody = `<< /Type /Catalog /Pages ${pagesEntry}${acroFormEntry ? ` /AcroForm ${acroFormEntry}` : ''} /DSS ${dssObjNum} 0 R >>`;
    const pdfWithDss = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: certsArrObjNum + 1,
      objects: [
        {
          objNum: certsArrObjNum,
          body: '[]',
        },
        {
          objNum: dssObjNum,
          body: `<< /Type /DSS /Certs ${certsArrObjNum} 0 R /OCSPs [] /CRLs [] >>`,
        },
        {
          objNum: info.rootObjNum,
          body: catalogBody,
        },
      ],
    });

    // Política padrão (PADES_LTV_ALLOWED): aceita revisão incremental que adiciona apenas /DSS
    const resDefault = await padesService.verifyPadesSignature(pdfWithDss);
    assert.equal(resDefault.pdfIntegrity.valid, true, resDefault.pdfIntegrity.error);
    assert.equal(resDefault.pdfIntegrity.postSignatureLtvRevisionsCount, 1);
    assert.equal(resDefault.pdfIntegrity.hasUnauthorizedPostSignatureUpdate, false);
    assert.equal(resDefault.cryptographicIntegrity, true);

    // Política estrita de emissão (STRICT_SINGLE_REVISION_AT_SIGNING): rejeita bytes após a assinatura
    const resStrict = await padesService.verifyPadesSignature(pdfWithDss, {
      pdfRevisionPolicy: 'STRICT_SINGLE_REVISION_AT_SIGNING',
    });
    assert.equal(resStrict.pdfIntegrity.valid, false);
    assert.equal(resStrict.cryptographicIntegrity, false);
    assert.equal(resStrict.status, 'INVALID');
    assert.equal(resStrict.isValid, false);
  });

  it('6. suporta PDF com múltiplas assinaturas em revisões incrementais sucessivas (cada CMS com 1 SignerInfo)', async () => {
    const { signedPdf } = await createSampleSignedPdf('Documento com coassinatura incremental');
    const info = await inspectPdfStructureRefs(signedPdf);
    const catalogDict = info.doc.catalog;
    const pagesEntry = catalogDict.get(PDFName.of('Pages')).toString();
    const acroFormDict = info.doc.context.lookup(catalogDict.get(PDFName.of('AcroForm')));
    const existingFieldsArr = info.doc.context.lookup(acroFormDict.get(PDFName.of('Fields')));
    const firstWidgetRefStr = existingFieldsArr.get(0).toString();
    const sig2ObjNum = info.maxObjNum + 1;
    const widget2ObjNum = info.maxObjNum + 2;

    const brPlaceholder = '/ByteRange [0 /********** /********** /**********]';
    const sigHexLen = 16384;
    const emptyContents = `<${'0'.repeat(sigHexLen)}>`;

    const draftRev2 = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: widget2ObjNum + 1,
      objects: [
        {
          objNum: sig2ObjNum,
          body: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached ${brPlaceholder} /Contents ${emptyContents} /Reason (Segunda assinatura) >>`,
        },
        {
          objNum: widget2ObjNum,
          body: `<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /T (Signature2) /V ${sig2ObjNum} 0 R /P ${info.pageRefStr} >>`,
        },
        {
          objNum: info.rootObjNum,
          body: `<< /Type /Catalog /Pages ${pagesEntry} /AcroForm << /SigFlags 3 /Fields [${firstWidgetRefStr} ${widget2ObjNum} 0 R] >> >>`,
        },
      ],
    });

    const brPos = draftRev2.indexOf(brPlaceholder, signedPdf.length);
    assert.ok(brPos > signedPdf.length);
    const contentsPos = draftRev2.indexOf('/Contents <', brPos);
    const ltPos = draftRev2.indexOf('<', contentsPos);
    const gtPos = draftRev2.indexOf('>', ltPos);
    const br2 = [0, ltPos, gtPos + 1, draftRev2.length - (gtPos + 1)];
    const actualBr2 = `/ByteRange [${br2.join(' ')}]`.padEnd(brPlaceholder.length, ' ');

    const pdfWithBr2 = Buffer.concat([
      draftRev2.subarray(0, brPos),
      Buffer.from(actualBr2, 'latin1'),
      draftRev2.subarray(brPos + brPlaceholder.length),
    ]);
    const dataToSign2 = Buffer.concat([
      pdfWithBr2.subarray(0, br2[1]),
      pdfWithBr2.subarray(br2[2], br2[2] + br2[3]),
    ]);
    const digest2 = crypto.createHash('sha256').update(dataToSign2).digest('hex');
    const secondProvider = new MockBirdIdProvider({
      mockCpf: '11144477735',
      doctorName: 'DR. SEGUNDO SIGNATARIO',
    });
    const sig2Result = await secondProvider.signHash({
      accessToken: 'x',
      certificateAlias: 'e-CPF',
      hashHex: digest2,
      documentAlias: 'Sig 2',
    });
    const rawCms2 = Buffer.from(sig2Result.cmsSignatureBase64, 'base64').toString('hex');
    const paddedCms2 = rawCms2.padEnd(sigHexLen, '0');
    const multiSignedPdf = Buffer.concat([
      pdfWithBr2.subarray(0, br2[1]),
      Buffer.from(`<${paddedCms2}>`, 'latin1'),
      pdfWithBr2.subarray(br2[2]),
    ]);

    const res = await padesService.verifyPadesSignature(multiSignedPdf);
    assert.equal(res.pdfIntegrity.valid, true, res.pdfIntegrity.error);
    assert.equal(res.pdfIntegrity.signatureRevisionsCount, 2);
    assert.equal(res.pdfIntegrity.signatures.length, 2);
    assert.equal(res.pdfIntegrity.signatures[0].valid, true);
    assert.equal(res.pdfIntegrity.signatures[1].valid, true);
    assert.equal(res.cryptographicIntegrity, true);
  });

  it('7. rejeita bytes não-zero ocultos no padding decodificado de /Contents (Ajuste 5)', async () => {
    const { signedPdf, prepared } = await createSampleSignedPdf();
    const tamperedPadding = Buffer.from(signedPdf);
    // Altera bytes no meio do padding (mas mantendo 00 nos últimos 8 caracteres para enganar regex de sufixo)
    const injectOffset = prepared.byteRange[2] - 24;
    tamperedPadding.write('deadbeef', injectOffset, 'latin1');

    const res = await padesService.verifyPadesSignature(tamperedPadding);
    assert.equal(res.pdfIntegrity.contentsPaddingValid, false);
    assert.equal(res.pdfIntegrity.valid, false);
    assert.equal(res.cryptographicIntegrity, false);
    assert.equal(res.status, 'INVALID');
    assert.equal(res.isValid, false);
  });

  it('8. preserva octeto 0x00 final legítimo pertencente à estrutura ASN.1 DER dentro de /Contents (Ajuste 5)', async () => {
    const { prepared, signResult } = await createSampleSignedPdf();
    const rawCms = Buffer.from(signResult.cmsSignatureBase64, 'base64');
    const info = new pkijs.ContentInfo({
      schema: asn1js.fromBER(
        rawCms.buffer.slice(rawCms.byteOffset, rawCms.byteOffset + rawCms.byteLength),
      ).result,
    });
    const signedData = new pkijs.SignedData({ schema: info.content });
    // Adiciona um atributo não assinado legítimo cujo valor termina exatamente no byte 0x00
    signedData.signerInfos[0].unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [
        new pkijs.Attribute({
          type: '1.2.840.113549.1.9.16.2.99',
          values: [
            new asn1js.OctetString({
              valueHex: new Uint8Array([0x01, 0x02, 0x00]).buffer,
            }),
          ],
        }),
      ],
    });
    info.content = signedData.toSchema();
    const derEndingWithZero = Buffer.from(info.toSchema().toBER());
    assert.equal(
      derEndingWithZero[derEndingWithZero.length - 1],
      0x00,
      'DER deve terminar com 0x00 para exercitar o corte por offset ASN.1',
    );

    const embedded = padesService.embedSignature(
      prepared,
      derEndingWithZero.toString('base64'),
    );
    const res = await padesService.verifyPadesSignature(embedded);
    assert.equal(res.pdfIntegrity.contentsPaddingValid, true);
    assert.equal(res.pdfIntegrity.valid, true, res.pdfIntegrity.error);
    assert.equal(res.cmsIntegrity.valid, true, res.cmsIntegrity.error);
    assert.equal(res.cryptographicIntegrity, true);
  });

  it('9. rejeita PDF truncado, ByteRange não iniciando em 0 e segunda revisão embutida dentro do próprio ByteRange', async () => {
    const { signedPdf, prepared } = await createSampleSignedPdf();

    // 9a. PDF truncado
    const truncated = signedPdf.subarray(0, signedPdf.length - 12);
    const resTruncated = await padesService.verifyPadesSignature(truncated);
    assert.equal(resTruncated.pdfIntegrity.valid, false);
    assert.equal(resTruncated.status, 'INVALID');
    assert.equal(resTruncated.isValid, false);

    // 9b. ByteRange iniciando em offset > 0
    const brStr = `/ByteRange [${prepared.byteRange.join(' ')}]`;
    const badBrStr = `/ByteRange [4 ${prepared.byteRange[1] - 4} ${prepared.byteRange[2]} ${prepared.byteRange[3]}]`.padEnd(
      brStr.length,
      ' ',
    );
    const badBrPdf = Buffer.from(signedPdf);
    const brIdx = badBrPdf.indexOf(brStr);
    badBrPdf.write(badBrStr, brIdx, 'latin1');
    const resBadBr = await padesService.verifyPadesSignature(badBrPdf);
    assert.equal(resBadBr.pdfIntegrity.valid, false);
    assert.equal(resBadBr.status, 'INVALID');
    assert.equal(resBadBr.isValid, false);

    // 9c. Segunda revisão %%EOF embutida dentro do segundo trecho do próprio ByteRange [b2, b2 + b3)
    const info = await inspectPdfStructureRefs(signedPdf);
    const extraObjNum = info.maxObjNum + 1;
    const expandedWithSecondEof = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: extraObjNum + 1,
      objects: [
        {
          objNum: extraObjNum,
          body: '<< /Type /Metadata /Subtype /XML /Length 0 >>\nstream\n\nendstream',
        },
      ],
    });
    const newB3 = expandedWithSecondEof.length - prepared.byteRange[2];
    const stretchedBrStr = `/ByteRange [0 ${prepared.byteRange[1]} ${prepared.byteRange[2]} ${newB3}]`.padEnd(
      brStr.length,
      ' ',
    );
    const stretchedPdf = Buffer.from(expandedWithSecondEof);
    stretchedPdf.write(stretchedBrStr, stretchedPdf.indexOf(brStr), 'latin1');
    const resStretched = await padesService.verifyPadesSignature(stretchedPdf);
    assert.equal(resStretched.pdfIntegrity.valid, false);
    assert.equal(resStretched.status, 'INVALID');
    assert.equal(resStretched.isValid, false);
  });

  it('10. rejeita CMS com 2 SignerInfos ou com atributo signingCertificateV2 divergente do certificado signatário', async () => {
    const { prepared, signResult } = await createSampleSignedPdf();
    const rawCms = Buffer.from(signResult.cmsSignatureBase64, 'base64');
    const info = new pkijs.ContentInfo({
      schema: asn1js.fromBER(
        rawCms.buffer.slice(rawCms.byteOffset, rawCms.byteOffset + rawCms.byteLength),
      ).result,
    });
    const signedData = new pkijs.SignedData({ schema: info.content });

    // 10a. Duplica o SignerInfo dentro do mesmo CMS
    signedData.signerInfos.push(signedData.signerInfos[0]);
    info.content = signedData.toSchema();
    const twoSignersPdf = padesService.embedSignature(
      prepared,
      Buffer.from(info.toSchema().toBER()).toString('base64'),
    );
    const resTwoSigners = await padesService.verifyPadesSignature(twoSignersPdf);
    assert.equal(resTwoSigners.cmsIntegrity.valid, false);
    assert.equal(resTwoSigners.status, 'INVALID');
    assert.equal(resTwoSigners.isValid, false);

    // 10b. Atributo signingCertificateV2 (RFC 5035) assinado criptograficamente, mas com hash de outro certificado
    const keyPair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: { name: 'SHA-256' },
      },
      true,
      ['sign', 'verify'],
    );
    const cert = new pkijs.Certificate();
    cert.version = 2;
    cert.serialNumber = new asn1js.Integer({ value: 98765 });
    const dn = new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: 'DR. TESTE ESSCERTID:52998224725' }),
    });
    cert.issuer.typesAndValues.push(dn);
    cert.subject.typesAndValues.push(dn);
    cert.notBefore.value = new Date(Date.now() - 60_000);
    cert.notAfter.value = new Date(Date.now() + 3600_000);
    await cert.subjectPublicKeyInfo.importKey(keyPair.publicKey);
    await cert.sign(keyPair.privateKey, 'SHA-256');

    const wrongCertHash = new Uint8Array(32).fill(0xaa);
    const cmsSigned = new pkijs.SignedData({
      version: 1,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: '1.2.840.113549.1.7.1',
      }),
      certificates: [cert],
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: cert.issuer,
            serialNumber: cert.serialNumber,
          }),
          digestAlgorithm: new pkijs.AlgorithmIdentifier({
            algorithmId: '2.16.840.1.101.3.4.2.1',
          }),
          signatureAlgorithm: new pkijs.AlgorithmIdentifier({
            algorithmId: '1.2.840.113549.1.1.11',
          }),
          signedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 0,
            attributes: [
              new pkijs.Attribute({
                type: '1.2.840.113549.1.9.3',
                values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })],
              }),
              new pkijs.Attribute({
                type: '1.2.840.113549.1.9.4',
                values: [
                  new asn1js.OctetString({
                    valueHex: Buffer.from(prepared.digestHex, 'hex'),
                  }),
                ],
              }),
              new pkijs.Attribute({
                type: '1.2.840.113549.1.9.16.2.47',
                values: [
                  new asn1js.Sequence({
                    value: [
                      new asn1js.Sequence({
                        value: [
                          new asn1js.Sequence({
                            value: [
                              new asn1js.OctetString({ valueHex: wrongCertHash.buffer }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        }),
      ],
    });
    const dataView = prepared.contentToSign.buffer.slice(
      prepared.contentToSign.byteOffset,
      prepared.contentToSign.byteOffset + prepared.contentToSign.byteLength,
    );
    await cmsSigned.sign(keyPair.privateKey, 0, 'SHA-256', dataView);
    const wrapped = new pkijs.ContentInfo({
      contentType: '1.2.840.113549.1.7.2',
      content: cmsSigned.toSchema(true),
    });
    const badSigCertV2Pdf = padesService.embedSignature(
      prepared,
      Buffer.from(wrapped.toSchema().toBER()).toString('base64'),
    );
    const resBadSigCertV2 = await padesService.verifyPadesSignature(badSigCertV2Pdf);
    assert.equal(resBadSigCertV2.cmsIntegrity.signatureVerified, true);
    assert.equal(resBadSigCertV2.cmsIntegrity.signingCertificateAttrPresent, true);
    assert.equal(resBadSigCertV2.cmsIntegrity.signingCertificateAttrValid, false);
    assert.equal(resBadSigCertV2.cmsIntegrity.valid, false);
    assert.equal(resBadSigCertV2.status, 'INVALID');
    assert.equal(resBadSigCertV2.isValid, false);
  });

  it('12. rejeita objeto /Type /Sig órfão não referenciado por /AcroForm e redefinição de recurso /Resources pós-assinatura (Ajuste 3)', async () => {
    const { signedPdf } = await createSampleSignedPdf();
    const info = await inspectPdfStructureRefs(signedPdf);

    // 12a. Adiciona um dicionário /Type /Sig órfão não referenciado no /AcroForm
    const orphanObjNum = info.maxObjNum + 1;
    const pdfWithOrphanSig = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: orphanObjNum + 1,
      objects: [
        {
          objNum: orphanObjNum,
          body: '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached >>',
        },
      ],
    });
    const resOrphan = await padesService.verifyPadesSignature(pdfWithOrphanSig);
    assert.equal(resOrphan.pdfIntegrity.valid, false);
    assert.match(resOrphan.pdfIntegrity.error || '', /órfão|não referenciado/i);
    assert.equal(resOrphan.status, 'INVALID');
    assert.equal(resOrphan.isValid, false);

    // 12b. Redefine um objeto de fonte dentro da subárvore /Resources da página sem tocar no /Contents da página
    const pageDict = info.doc.getPage(0).node;
    const resourcesDict = info.doc.context.lookup(pageDict.get(PDFName.of('Resources')));
    const fontDict = info.doc.context.lookup(resourcesDict.get(PDFName.of('Font')));
    let fontObjNum = null;
    for (const [, val] of fontDict.entries()) {
      const m = val.toString().match(/^(\d+)\s+\d+\s+R$/);
      if (m) {
        fontObjNum = Number(m[1]);
        break;
      }
    }
    assert.ok(fontObjNum, 'Página deve possuir objeto indireto de fonte em /Resources');

    const dssObjNum = info.maxObjNum + 1;
    const catalogDict = info.doc.catalog;
    const pagesEntry = catalogDict.get(PDFName.of('Pages')).toString();
    const acroFormEntry = catalogDict.get(PDFName.of('AcroForm'))?.toString();

    const pdfWithTamperedFont = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: dssObjNum + 1,
      objects: [
        {
          objNum: fontObjNum,
          body: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
        },
        {
          objNum: dssObjNum,
          body: '<< /Type /DSS /Certs [] >>',
        },
        {
          objNum: info.rootObjNum,
          body: `<< /Type /Catalog /Pages ${pagesEntry}${acroFormEntry ? ` /AcroForm ${acroFormEntry}` : ''} /DSS ${dssObjNum} 0 R >>`,
        },
      ],
    });
    const resTamperedFont = await padesService.verifyPadesSignature(pdfWithTamperedFont);
    assert.equal(resTamperedFont.pdfIntegrity.valid, false);
    assert.equal(resTamperedFont.pdfIntegrity.hasUnauthorizedPostSignatureUpdate, true);
    assert.equal(resTamperedFont.status, 'INVALID');
    assert.equal(resTamperedFont.isValid, false);
  });

  it('11. preserva compatibilidade com os PDFs da aplicação (receita RCE e atestado)', async () => {
    const base = {
      id: '00000000-0000-4000-8000-0000000006f1',
      patient_id: 'sintetico',
      patient_name: 'Paciente Sintético',
      physician_name: 'Dr. Médico Sintético',
      physician_registration: 'CRM 12345 SP',
      document_date: '2026-10-29',
      version: 1,
      status: 'FINALIZED',
    };
    const pdfBuffers = [
      await documentPdf(
        { ...base, kind: 'Receita', prescription_category: 'RCE', text: 'MED001 10mg - 1 cp ao dia' },
        { isDraft: false },
      ),
      await documentPdf(
        { ...base, kind: 'Atestado', text: 'Atesto, para os devidos fins, comparecimento.' },
        { isDraft: false },
      ),
    ];

    for (const rawPdf of pdfBuffers) {
      const prep = await padesService.preparePdfForSignature(rawPdf, {
        signerName: 'DR. MEDICO SINTETICO',
        drawVisualBox: false,
      });
      const sig = await provider.signHash({
        accessToken: 'x',
        certificateAlias: 'e-CPF',
        hashHex: prep.digestHex,
        documentAlias: 'Compat 6F.1',
      });
      const signed = padesService.embedSignature(prep, sig.cmsSignatureBase64);
      const ver = await padesService.verifyPadesSignature(signed, {
        pdfRevisionPolicy: 'STRICT_SINGLE_REVISION_AT_SIGNING',
      });
      assert.equal(ver.cryptographicIntegrity, true);
      assert.equal(ver.pdfIntegrity.valid, true);
      assert.equal(ver.cmsIntegrity.valid, true);
      assert.equal(ver.status, 'INDETERMINATE');
      assert.equal(ver.persistenceStatus, 'UNVERIFIED');
      assert.equal(ver.isTrusted, false);
    }
  });

  it('13. falha com segurança e tempo limitado diante de PDFs malformados: referências circulares, estruturas profundas, muitas revisões incrementais e conteúdo excessivo', async () => {
    const { signedPdf } = await createSampleSignedPdf();
    const info = await inspectPdfStructureRefs(signedPdf);

    // 13a. Referência circular na árvore /Pages -> /Kids (2 -> 3 -> 2)
    const pagesMatch = info.pagesRefStr.match(/^(\d+)\s+\d+\s+R$/);
    assert.ok(pagesMatch);
    const pagesObjNum = Number(pagesMatch[1]);
    const cycleNodeObjNum = info.maxObjNum + 1;
    const pdfWithCircularPages = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: cycleNodeObjNum + 1,
      objects: [
        {
          objNum: cycleNodeObjNum,
          body: `<< /Type /Pages /Kids [${pagesObjNum} 0 R] /Count 1 >>`,
        },
        {
          objNum: pagesObjNum,
          body: `<< /Type /Pages /Kids [${cycleNodeObjNum} 0 R] /Count 1 >>`,
        },
      ],
    });
    const t0 = performance.now();
    const resCircularPages = await padesService.verifyPadesSignature(pdfWithCircularPages);
    const elapsedCircularPages = performance.now() - t0;
    assert.equal(resCircularPages.pdfIntegrity.valid, false);
    assert.match(resCircularPages.pdfIntegrity.error || '', /circular|ciclo/i);
    assert.equal(resCircularPages.status, 'INVALID');
    assert.ok(elapsedCircularPages < 500, `Ciclo em /Pages demorou demais: ${elapsedCircularPages}ms`);

    // 13b. Referência circular em /AcroForm -> /Fields -> /Kids
    const cycleFieldA = info.maxObjNum + 1;
    const cycleFieldB = info.maxObjNum + 2;
    const pagesEntry = info.doc.catalog.get(PDFName.of('Pages')).toString();
    const pdfWithCircularFields = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: cycleFieldB + 1,
      objects: [
        {
          objNum: cycleFieldA,
          body: `<< /T (NodeA) /Kids [${cycleFieldB} 0 R] >>`,
        },
        {
          objNum: cycleFieldB,
          body: `<< /T (NodeB) /Kids [${cycleFieldA} 0 R] >>`,
        },
        {
          objNum: info.rootObjNum,
          body: `<< /Type /Catalog /Pages ${pagesEntry} /AcroForm << /Fields [${cycleFieldA} 0 R] >> >>`,
        },
      ],
    });
    const t1 = performance.now();
    const resCircularFields = await padesService.verifyPadesSignature(pdfWithCircularFields);
    const elapsedCircularFields = performance.now() - t1;
    assert.equal(resCircularFields.pdfIntegrity.valid, false);
    assert.match(resCircularFields.pdfIntegrity.error || '', /circular/i);
    assert.equal(resCircularFields.status, 'INVALID');
    assert.ok(elapsedCircularFields < 500);

    // 13c. Estrutura profundamente aninhada (> MAX_TRAVERSAL_DEPTH = 48 níveis de arrays/dicts)
    const deepNestingDepth = 60;
    const deepArrayBody = `${'['.repeat(deepNestingDepth)} 1 ${']'.repeat(deepNestingDepth)}`;
    const deepObjNum = info.maxObjNum + 1;
    const pdfWithDeepStructure = appendIncrementalRevision(signedPdf, {
      rootRefStr: info.rootRefStr,
      size: deepObjNum + 1,
      objects: [
        {
          objNum: deepObjNum,
          body: `<< /Type /DSS /Certs ${deepArrayBody} >>`,
        },
      ],
    });
    const t2 = performance.now();
    const resDeep = await padesService.verifyPadesSignature(pdfWithDeepStructure);
    const elapsedDeep = performance.now() - t2;
    assert.equal(resDeep.pdfIntegrity.valid, false);
    assert.match(resDeep.pdfIntegrity.error || '', /profundidade/i);
    assert.equal(resDeep.status, 'INVALID');
    assert.ok(elapsedDeep < 500);

    // 13d. Excesso de revisões incrementais (> MAX_PDF_REVISIONS = 32)
    let manyRevsPdf = signedPdf;
    for (let r = 0; r < 35; r += 1) {
      const nextObj = info.maxObjNum + 1 + r;
      manyRevsPdf = appendIncrementalRevision(manyRevsPdf, {
        rootRefStr: info.rootRefStr,
        size: nextObj + 1,
        objects: [
          {
            objNum: nextObj,
            body: `<< /Type /DSS /Certs [] >>`,
          },
        ],
      });
    }
    const t3 = performance.now();
    const resManyRevs = await padesService.verifyPadesSignature(manyRevsPdf);
    const elapsedManyRevs = performance.now() - t3;
    assert.equal(resManyRevs.pdfIntegrity.valid, false);
    assert.match(resManyRevs.pdfIntegrity.error || '', /revisões incrementais.*limite/i);
    assert.equal(resManyRevs.status, 'INVALID');
    assert.ok(elapsedManyRevs < 200, `Rejeição de excesso de revisões demorou: ${elapsedManyRevs}ms`);

    // 13e. Conteúdo excessivamente grande (> MAX_PDF_BYTES = 25 MiB)
    const oversizedPdf = Buffer.alloc(25 * 1024 * 1024 + 1024, 0x20);
    signedPdf.copy(oversizedPdf, 0, 0, 64);
    const t4 = performance.now();
    const resOversized = await padesService.verifyPadesSignature(oversizedPdf);
    const elapsedOversized = performance.now() - t4;
    assert.equal(resOversized.pdfIntegrity.valid, false);
    assert.match(resOversized.pdfIntegrity.error || '', /excede o limite máximo de segurança/i);
    assert.equal(resOversized.status, 'INVALID');
    assert.ok(elapsedOversized < 100, `Rejeição de PDF gigante demorou: ${elapsedOversized}ms`);
  });
});
