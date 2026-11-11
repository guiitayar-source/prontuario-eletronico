import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  type PDFFont,
} from 'pdf-lib';
import QRCode from 'qrcode';
import {
  numberedLabels,
  snapshotCategory,
  validateRceSnapshot,
  type NumberedCategory,
  type RceSnapshot,
} from './rce.ts';
import { rangeNumberPattern } from './client.ts';

// Original official models, unchanged. Source/hash are documented in assets/sncr/README.md.
// The three electronic models have the same fields. The notifications add a colored band on the
// left, so each block sits a few points away from the RCE position. Every coordinate below is
// the RCE one plus the block offset measured on the official file (pdftotext -bbox of the labels
// and the QR placeholder; tests/sncr-notificacoes.test.mjs checks them against the files). The
// pinned hash makes sure the server only fills the exact file those offsets came from.
type Offset = { dx: number; dy: number };
export type TemplateLayout = {
  emitter: Offset;
  patient: Offset;
  prescription: Offset & { width: number };
  footer: Offset & { width: number };
  // White box over the placeholder, then the QR image (left/top from the top of the page).
  qr: { x: number; top: number; boxX: number; boxTop: number };
};
const rceLayout: TemplateLayout = {
  emitter: { dx: 0, dy: 0 },
  patient: { dx: 0, dy: 0 },
  prescription: { dx: 0, dy: 0, width: 527 },
  footer: { dx: 0, dy: 0, width: 450 },
  qr: { x: 492, top: 710, boxX: 489, boxTop: 697 },
};
// Notificações: quadros mais estreitos (63–588 pt) por causa da faixa colorida.
const notificationLayout = (footerDx: number, qr: TemplateLayout['qr']): TemplateLayout => ({
  emitter: { dx: 38.3, dy: 0 },
  patient: { dx: 27.3, dy: 5.15 },
  prescription: { dx: 35.5, dy: -1.25, width: 507 },
  footer: { dx: footerDx, dy: 5.25, width: 430 },
  qr,
});
export const numberedTemplates: Record<
  NumberedCategory,
  { file: string; sha256: string | null; layout: TemplateLayout }
> = {
  RCE: {
    file: 'rce-eletronica-anvisa.pdf',
    sha256: '112946ead832ec07f9343f81b35b3571065eb51dea5526cf5c949e0259c11fde',
    layout: rceLayout,
  },
  // Recebidos do titular em 11/11/2026 (baixados da página de modelos eletrônicos da Anvisa).
  NRA: {
    file: 'notificacao-receita-a-eletronica.pdf',
    sha256: 'e72ddb49831615c4b4c652ee9ca0d4f01f131a3896e43512494b16dca6b9f001',
    layout: notificationLayout(36.6, { x: 502, top: 722, boxX: 499, boxTop: 709 }),
  },
  NRB: {
    file: 'notificacao-receita-b-eletronica.pdf',
    sha256: '8c7db7622ef8eda963684409da4e0c70ebd7090d5834b7ed7b6f2c05d1f5c7c4',
    layout: notificationLayout(38.6, { x: 506, top: 711, boxX: 503, boxTop: 698 }),
  },
};
async function officialTemplate(category: NumberedCategory) {
  const t = numberedTemplates[category];
  const name = numberedLabels[category].full;
  if (!t.sha256)
    throw new Error(
      `O modelo eletrônico oficial da ${name} ainda não foi conferido neste servidor. A emissão eletrônica fica indisponível até lá; use o talonário físico.`,
    );
  let bytes: Uint8Array;
  try {
    // Same filesystem asset convention as document-pdf.ts. A relative
    // import.meta URL is rewritten to /_next/ by the server webpack bundle.
    bytes = await readFile(process.cwd() + '/assets/sncr/' + t.file);
  } catch {
    throw new Error(`O modelo oficial da ${name} não está instalado neste servidor.`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== t.sha256)
    throw new Error(`O modelo oficial da ${name} diverge do arquivo conferido.`);
  return bytes;
}
// 'hmg': RCE de treinamento com número de homologação. 'prd': RCE com número real do SNCR,
// sem marca de teste. 'transition': RCE eletrônica sem
// numeração SNCR, admitida no período de transição (RDC 1.000/2025 alterada; ver
// sncrTransitionEnd), assinada com certificado ICP-Brasil e verificável no ITI.
export const RCE_TRANSITION_NUMBER_TEXT = 'Sem numeração SNCR (período de transição)';
export const ITI_VALIDATOR_URL = 'https://validar.iti.gov.br/';
// Produção: formato que a Anvisa define para o QR da Notificação de Receita (página "Receituário
// eletrônico" do SNCR), aplicado à RCE por analogia até a Anvisa confirmar (e-mail de 31/10/2026).
export function rceConsultUrl(
  environment: 'hmg' | 'prd' | 'transition',
  number: string | null,
) {
  if (environment === 'hmg') return 'https://sncr-treinamento.anvisa.gov.br/';
  if (environment === 'prd' && number)
    return `https://sncr.anvisa.gov.br/receita/consultar?numero=${encodeURIComponent(number)}`;
  return ITI_VALIDATOR_URL;
}
export async function rcePdf(
  snapshot: RceSnapshot,
  number: string | null,
  issuedAt: Date,
  environment: 'hmg' | 'prd' | 'transition',
  templateBytes?: Uint8Array,
) {
  const s = validateRceSnapshot(snapshot);
  const category = snapshotCategory(s);
  const label = numberedLabels[category].full;
  if (environment !== 'hmg' && environment !== 'prd' && environment !== 'transition')
    throw new Error('Ambiente de emissão desconhecido.');
  // Só a RCE tem período de transição sem número; a notificação sempre leva o da Visa.
  if (environment === 'transition' && category !== 'RCE')
    throw new Error('A Notificação de Receita eletrônica exige numeração SNCR.');
  const training = environment === 'hmg';
  if (
    environment === 'transition'
      ? number !== null
      : !rangeNumberPattern.test(number || '')
  )
    throw new Error('Formato da numeração ainda não validado.');
  const template = await PDFDocument.load(
    templateBytes || (await officialTemplate(category)),
  );
  const result = await PDFDocument.create();
  const font = await result.embedFont(StandardFonts.Helvetica),
    bold = await result.embedFont(StandardFonts.HelveticaBold);
  function lines(text: string, width: number, size: number, f: PDFFont) {
    const out: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      let line = '';
      for (const word of raw.split(/\s+/).filter(Boolean)) {
        if (f.widthOfTextAtSize(word, size) > width)
          throw new Error(
            'Uma palavra não cabe no modelo da RCE. Revise o texto.',
          );
        if (line && f.widthOfTextAtSize(line + ' ' + word, size) > width) {
          out.push(line);
          line = word;
        } else line = line ? line + ' ' + word : word;
      }
      out.push(line);
    }
    return out;
  }
  const L = numberedTemplates[category].layout;
  const P = L.prescription;
  const dosage = lines(s.medicine.dosage, P.width, 9, font);
  const chunks = Array.from({ length: Math.ceil(dosage.length / 12) }, (_, i) =>
    dosage.slice(i * 12, (i + 1) * 12),
  );
  if (chunks.length > 12)
    throw new Error(
      'Posologia extensa demais. Revise ou divida em novas receitas.',
    );
  // Treinamento e produção usam o portal de cada ambiente (docs/SNCR.md). Sem número SNCR,
  // a conferência disponível é a da assinatura no ITI (RDC 1.000/2025, art. 13, I).
  const consultUrl = rceConsultUrl(environment, number);
  const qr = await result.embedPng(
    await QRCode.toBuffer(consultUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 200,
    }),
  );
  for (const [index, part] of chunks.entries()) {
    const [page] = await result.copyPages(template, [0]);
    result.addPage(page);
    // The official file's crop starts at y=7.83, rather than zero. Include
    // that origin so added fields align with the visible template labels.
    const height = page.getCropBox().y + page.getHeight();
    const field = (
      text: string,
      x: number,
      top: number,
      width: number,
      maxLines = 2,
      size = 9,
      strong = false,
    ) => {
      const f = strong ? bold : font;
      const wrapped = lines(text, width, size, f);
      if (wrapped.length > maxLines)
        throw new Error(
          'Um campo excede o espaço do modelo da RCE. Revise os dados.',
        );
      wrapped.forEach((line, i) =>
        page.drawText(line, {
          x,
          y: height - top - size - i * 11,
          size,
          font: f,
        }),
      );
    };
    // RCE coordinates on the unmodified official A4 template, moved by each block's offset.
    const E = L.emitter,
      Pt = L.patient,
      F = L.footer;
    // A narrower prescription box shortens every line of it by the same amount.
    const narrow = (width: number) => width - (527 - P.width);
    field(number ?? RCE_TRANSITION_NUMBER_TEXT, 398, 34, 180, number ? 1 : 2, number ? 12 : 8, true);
    field(s.prescriber.name, 31 + E.dx, 166 + E.dy, 246, 2);
    field(`CRM ${s.prescriber.crm}/${s.prescriber.uf}`, 31 + E.dx, 208 + E.dy, 246, 1);
    field(s.prescriber.address, 31 + E.dx, 248 + E.dy, 246, 2, 8);
    field(s.prescriber.phone, 31 + E.dx, 286 + E.dy, 246, 1);
    field(s.patient.name, 307 + Pt.dx, 166 + Pt.dy, 246, 2);
    field(s.patient.identifier, 307 + Pt.dx, 208 + Pt.dy, 246, 1);
    field(s.patient.address, 307 + Pt.dx, 249 + Pt.dy, 246, 4, 8);
    // Values sit on the label's baseline; a long name goes below its label.
    if (font.widthOfTextAtSize(s.medicine.name, 10) <= narrow(270))
      field(s.medicine.name, 285 + P.dx, 379 + P.dy, narrow(270), 1, 10);
    else field(s.medicine.name, 36 + P.dx, 394 + P.dy, P.width, 1, 8);
    field(s.medicine.concentration, 145 + P.dx, 410 + P.dy, narrow(410), 1, 10);
    field(s.medicine.pharmaceuticalForm, 181 + P.dx, 440 + P.dy, narrow(375), 1, 10);
    field(s.medicine.quantity, 125 + P.dx, 470 + P.dy, narrow(430), 1, 10);
    part.forEach((line, i) =>
      page.drawText(line, {
        x: 36 + P.dx,
        y: height - 530 - P.dy - i * 11,
        size: 9,
        font,
      }),
    );
    // Replace the QR placeholder, preserving the official footer's text.
    page.drawRectangle({
      x: L.qr.boxX,
      y: height - L.qr.boxTop - 90,
      width: 76,
      height: 90,
      color: rgb(1, 1, 1),
    });
    page.drawImage(qr, { x: L.qr.x, y: height - L.qr.top - 70, width: 70, height: 70 });
    field(s.platform, 26 + F.dx, 716 + F.dy, F.width, 1, 7);
    field(
      `${s.prescriber.name} - ${issuedAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
      26 + F.dx,
      738 + F.dy,
      F.width,
      1,
      7,
    );
    field(
      training
        ? 'Consulta de teste: sncr-treinamento.anvisa.gov.br'
        : environment === 'prd'
          ? 'Verifique a numeração em sncr.anvisa.gov.br e a assinatura em validar.iti.gov.br'
          : 'Verifique a assinatura digital em validar.iti.gov.br',
      26 + F.dx,
      780 + F.dy,
      F.width,
      1,
      7,
    );
    if (training)
      page.drawText(
        `HOMOLOGACAO - SEM VALIDADE PARA DISPENSACAO - ${index + 1}/${chunks.length}`,
        {
          x: 72,
          y: 405,
          size: 15,
          font: bold,
          color: rgb(0.75, 0.1, 0.1),
          opacity: 0.32,
          rotate: degrees(35),
        },
      );
    else if (chunks.length > 1)
      field(`Página ${index + 1}/${chunks.length}`, L.qr.boxX, L.qr.boxTop - 7, 76, 1, 7);
  }
  result.setTitle(
    training ? `${label} de teste - sem validade para dispensação` : label,
  );
  return result.save({ useObjectStreams: false });
}
