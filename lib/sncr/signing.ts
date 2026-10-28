// Orquestração local explícita. Reutiliza PAdES/Bird simulado; nunca acessa o provedor real.
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { documentPdf } from '../document-pdf.ts';
import { padesService } from '../signature/pades-service.ts';
import { MockBirdIdProvider } from '../signature/mock-birdid-provider.ts';
import { HttpError } from '../supabase/server.ts';
import {
  actorArgs,
  assertSynthetic,
  getNumberingContext,
  requireLocalSimulation,
  sncrRpc,
  type SncrDb,
  type SncrActor,
  type NumberingContext,
} from './numbering.ts';
import type { ClinicalDocument } from '../document-fields.ts';
import { parsePrescriptionText } from '../document-fields.ts';
import { rceSimulationPdf } from './rce-pdf.ts';

export interface ArtifactStore {
  put(path: string, bytes: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array>;
}
export const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export async function simulationPdf(doc: ClinicalDocument) {
  if (doc.kind === 'Receita' && parsePrescriptionText(doc.text).modality === 'controle_especial')
    return rceSimulationPdf(doc);
  const bytes = await documentPdf(doc, { isDraft: true });
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const page of pdf.getPages())
    page.drawText('SIMULACAO LOCAL - SEM VALIDADE CLINICA', {
      x: 48,
      y: page.getHeight() - 20,
      size: 11,
      font,
      color: rgb(0.7, 0, 0),
    });
  return pdf.save({ useObjectStreams: false });
}
export async function recoverSimulation(
  store: ArtifactStore,
  ctx: NumberingContext,
) {
  assertSynthetic(ctx);
  const meta = ctx.reservation!.artifact_metadata;
  if (
    !meta ||
    typeof meta.signed_pdf_storage_path !== 'string' ||
    typeof meta.signed_pdf_hash !== 'string'
  )
    throw new HttpError(
      409,
      'Assinatura em andamento ou incerta; exige reconciliação, sem nova assinatura.',
    );
  let bytes;
  try {
    bytes = await store.get(meta.signed_pdf_storage_path);
  } catch {
    throw new HttpError(
      503,
      'Artefato original não pôde ser recuperado. Não será regenerado.',
    );
  }
  if (sha256(bytes) !== meta.signed_pdf_hash)
    throw new HttpError(
      503,
      'Artefato original inconsistente; operação bloqueada.',
    );
  const verification = await padesService.verifyPadesSignature(
    Buffer.from(bytes),
  );
  if (!verification.isValid)
    throw new HttpError(
      503,
      'Assinatura simulada do artefato original inválida.',
    );
  return { bytes, verification };
}
export async function signReservedSimulation(
  db: SncrDb,
  actor: SncrActor,
  documentId: string,
  store: ArtifactStore,
  options: {
    enrich?: (doc: ClinicalDocument) => Promise<unknown>;
    // Injeção apenas no teste local de falha externa, nunca exposta pela rota.
    provider?: Pick<MockBirdIdProvider, 'signHash'>;
  } = {},
) {
  requireLocalSimulation();
  let ctx = await getNumberingContext(db, actor, documentId);
  assertSynthetic(ctx);
  const r = ctx.reservation!;
  if (
    r.state === 'signed' ||
    ((r.state === 'signing' || r.state === 'uncertain') && r.artifact_metadata)
  ) {
    const recovered = await recoverSimulation(store, ctx);
    if (r.state !== 'signed')
      ctx = await sncrRpc(db, 'sncr_finish_signing', {
        ...actorArgs(actor, documentId),
        p_attempt: r.attempt_id,
      });
    return {
      success: true,
      simulation: true,
      documentId,
      signedPdfPath: ctx.document.signed_pdf_path!,
      document: ctx.document,
      verification: recovered.verification,
    };
  }
  ctx = await sncrRpc(db, 'sncr_begin_signing', actorArgs(actor, documentId));
  if (!ctx.claimed)
    throw new HttpError(
      409,
      'Operação já concluída. Consulte o artefato original.',
    );
  const attempt = ctx.reservation!.attempt_id!;
  try {
    const doc = { ...ctx.document, sncr_number: r.number };
    await options.enrich?.(doc);
    const unsigned = await simulationPdf(doc);
    const prepared = await padesService.preparePdfForSignature(unsigned, {
      signerName: 'SIMULACAO LOCAL',
      drawVisualBox: false,
      reason: 'SIMULACAO LOCAL - SEM VALIDADE CLINICA',
    });
    const provider =
      options.provider ||
      new MockBirdIdProvider({ doctorName: 'SIMULACAO LOCAL' });
    const signed = await provider.signHash({
      accessToken: 'synthetic-local-only',
      certificateAlias: 'synthetic-local-only',
      hashHex: prepared.digestHex,
      documentAlias: documentId,
    });
    const bytes = padesService.embedSignature(
      prepared,
      signed.cmsSignatureBase64,
    );
    const verification = await padesService.verifyPadesSignature(bytes);
    if (!verification.isValid) throw new Error('Assinatura simulada inválida.');
    const path = `${actor.clinicId}/sncr-simulations/${documentId}_v${doc.version}_${attempt}.pdf`;
    const metadata = {
      provider: 'local_simulation',
      signed_pdf_storage_path: path,
      signed_pdf_hash: sha256(bytes),
      unsigned_pdf_hash: sha256(unsigned),
      document_hash: prepared.digestHex,
      certificate_subject: verification.certificateSubject || 'SIMULACAO LOCAL',
      certificate_issuer: verification.certificateIssuer || 'SIMULACAO LOCAL',
      certificate_serial: verification.certificateSerial || '',
      certificate_fingerprint: verification.certificateFingerprint || '',
      cpf_from_certificate: verification.signerCpf || '',
      signature_algorithm: 'SHA256withRSA',
      digest_algorithm: 'SHA-256',
    };
    await sncrRpc(db, 'sncr_save_artifact', {
      ...actorArgs(actor, documentId),
      p_attempt: attempt,
      p_metadata: metadata,
    });
    await store.put(path, bytes); // Sem overwrite; caminho exclusivo da tentativa persistida.
    await recoverSimulation(store, {
      ...ctx,
      reservation: { ...ctx.reservation!, artifact_metadata: metadata },
    });
    ctx = await sncrRpc(db, 'sncr_finish_signing', {
      ...actorArgs(actor, documentId),
      p_attempt: attempt,
    });
    return {
      success: true,
      simulation: true,
      documentId,
      signedPdfPath: path,
      document: ctx.document,
      verification,
    };
  } catch (error) {
    // Se o banco estiver indisponível, SIGNING já persistido bloqueia uma segunda tentativa.
    try {
      await sncrRpc(db, 'sncr_mark_uncertain', {
        ...actorArgs(actor, documentId),
        p_attempt: attempt,
      });
    } catch {}
    throw error;
  }
}
