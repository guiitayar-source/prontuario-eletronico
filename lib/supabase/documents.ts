import {
  handle,
  check,
  json,
  HttpError,
  boundedBody,
  writeGuard,
} from './server.ts';
import { adminClient } from './admin.ts';
import { documentKinds, stripSncrNumbers, type ClinicalDocument } from '../document-fields.ts';
import { documentPdf } from '../document-pdf.ts';
import { withPdfData } from './document-pdf-data.ts';
import { getNumberingContext, localSimulationEnabled, assertSynthetic } from '../sncr/numbering.ts';
import { simulationPdf } from '../sncr/signing.ts';
import { createHash } from 'node:crypto';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const profileColumns =
  'physician_name,physician_registration,letterhead_title,letterhead_address,letterhead_phone,cpf';
async function jsonBody(request: Request, max: number) {
  try {
    return JSON.parse(
      new TextDecoder().decode(await boundedBody(request, max)),
    ) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Solicitação inválida.');
  }
}
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.length <= max ? v : null;
export const documents = handle(async (request, { db, clinic, role, user }) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(
      403,
      'Documentos clínicos são exclusivos da equipe médica.',
    );
  const u = new URL(request.url),
    pid = u.searchParams.get('patientId');
  const action = u.searchParams.get('action');
  const profile = async () =>
    check(
      await db
        .from('document_profiles')
        .select(profileColumns)
        .eq('clinic_id', clinic)
        .eq('user_id', user)
        .maybeSingle(),
    );
  if (request.method === 'GET') {
    if (action === 'profile') return json({ profile: await profile() });
    if (!pid) throw new HttpError(400, 'Informe o paciente.');
    if (action === 'pdf') {
      const d = check(
        await db
          .from('clinical_documents')
          .select('*')
          .eq('clinic_id', clinic)
          .eq('patient_id', pid)
          .eq('id', u.searchParams.get('id') || '')
          .maybeSingle(),
      );
      if (!d) throw new HttpError(404, 'Documento não encontrado.');
      const doc = d as ClinicalDocument;

      // Um documento assinado só pode ser entregue a partir do arquivo original.
      if (doc.status === 'SIGNED' || doc.status === 'SUPERSEDED') {
        const unavailable = () => new HttpError(503, 'Não foi possível recuperar o documento assinado original.');
        if (!doc.signed_pdf_path) throw unavailable();

        try {
          // Registros antigos podem não ter metadados de assinatura. Quando há
          // hash para esta versão e caminho, confira os bytes antes de entregá-los.
          const { data: signature, error: signatureError } = await db
            .from('digital_signatures')
            .select('signed_pdf_hash,signed_pdf_storage_path')
            .eq('clinic_id', clinic)
            .eq('document_id', doc.id)
            .eq('document_version', doc.version)
            .eq('status', 'SIGNED')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (signatureError || (signature && signature.signed_pdf_storage_path !== doc.signed_pdf_path)) throw unavailable();

          let fileData = null;
          try {
            const result = await db.storage.from('clinical-files').download(doc.signed_pdf_path);
            if (!result.error) fileData = result.data;
          } catch { /* Tenta o acesso de servidor usado pelo fluxo existente. */ }
          if (!fileData) {
            const result = await adminClient().storage.from('clinical-files').download(doc.signed_pdf_path);
            if (!result.error) fileData = result.data;
          }
          if (!fileData) throw unavailable();
          const bytes = new Uint8Array(await fileData.arrayBuffer());
          const storedHash = signature?.signed_pdf_hash;
          if (storedHash != null && (
            typeof storedHash !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(storedHash) ||
            createHash('sha256').update(bytes).digest('hex') !== storedHash.toLowerCase()
          )) throw unavailable();

          return new Response(bytes, {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'inline; filename="documento_assinado.pdf"',
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        } catch {
          throw unavailable();
        }
      }

      await withPdfData(adminClient(), clinic, doc);
      let bytes;
      try {
        if (doc.kind==='Receita' && localSimulationEnabled()) {
          const ctx=await getNumberingContext(adminClient(),{clinicId:clinic,userId:user},doc.id);
          if (ctx.reservation) { assertSynthetic(ctx); doc.sncr_number=ctx.reservation.number; bytes=await simulationPdf(doc); }
          else bytes=await documentPdf(doc,{isDraft:true});
        } else bytes = await documentPdf(doc, { isDraft: true });
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline; filename="documento.pdf"',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    return json({
      documents: check(
        await db
          .from('clinical_documents')
          .select('*')
          .eq('clinic_id', clinic)
          .eq('patient_id', pid)
          .order('updated_at', { ascending: false }),
      ),
      profile: await profile(),
      templates: check(
        await db
          .from('prescription_templates')
          .select('id,name,text,updated_at')
          .eq('clinic_id', clinic)
          .eq('user_id', user)
          .order('name'),
      ),
    });
  }
  writeGuard(request, 'X-Document-Action');
  if (action === 'profile') {
    const p = await jsonBody(request, 4096);
    const fields = {
      physician_name: text(p.physician_name, 180),
      physician_registration: text(p.physician_registration, 120),
      letterhead_title: text(p.letterhead_title, 120),
      letterhead_address: text(p.letterhead_address, 200),
      letterhead_phone: text(p.letterhead_phone, 80),
    };
    if (Object.values(fields).some((v) => v === null))
      throw new HttpError(422, 'Confira os dados profissionais.');
    return json({
      profile: check(
        await db.rpc('document_profile_write', { c: clinic, d: fields }),
      ),
    });
  }
  if (action === 'save-template' || action === 'delete-template') {
    const t = await jsonBody(request, 90000);
    if (typeof t.id !== 'string' || !uuid.test(t.id))
      throw new HttpError(422, 'Identificador do modelo inválido.');
    if (action === 'delete-template') {
      check(
        await db.rpc('prescription_template_write', {
          c: clinic,
          action: 'delete',
          d: { id: t.id },
        }),
      );
      return json({ deleted: true });
    }
    const name = text(t.name, 80)?.trim(),
      body = text(t.text, 20000);
    if (!name || !body?.trim())
      throw new HttpError(422, 'Preencha o nome e o texto do modelo.');
    return json({
      template: check(
        await db.rpc('prescription_template_write', {
          c: clinic,
          action: 'save',
          d: { id: t.id, name, text: stripSncrNumbers(body) },
        }),
      ),
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (await jsonBody(request, 450000)) as any;
  if (
    !d ||
    !documentKinds.includes(d.kind) ||
    typeof d.text !== 'string' ||
    d.text.length > 100000 ||
    !Number.isInteger(d.version) ||
    d.version < 0 ||
    typeof d.physician_name !== 'string' ||
    d.physician_name.length > 180 ||
    typeof d.physician_registration !== 'string' ||
    d.physician_registration.length > 120 ||
    !(
      (d.kind === 'Receita' && (d.document_date == null || d.document_date === '')) ||
      (typeof d.document_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.document_date))
    )
  )
    throw new HttpError(422, 'Confira os campos do documento.');
  return json({
    document: check(await db.rpc('document_write', { c: clinic, d })),
  });
});
