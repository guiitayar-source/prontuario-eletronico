import {
  handle,
  check,
  json,
  HttpError,
  boundedBody,
  writeGuard,
} from './server.ts';
import { adminClient } from './admin.ts';
import { documentKinds, type ClinicalDocument } from '../document-fields.ts';
import { documentPdf } from '../document-pdf.ts';
import { withPdfData } from './document-pdf-data.ts';

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

      // If document is signed and storage path exists, serve official signed PDF
      if (doc.status === 'SIGNED' && doc.signed_pdf_path) {
        let fileData = null;
        const bucket = db.storage.from('clinical-files');
        const { data, error } = await bucket.download(doc.signed_pdf_path);
        if (!error && data) {
          fileData = data;
        } else {
          const { data: adminData } = await adminClient()
            .storage.from('clinical-files')
            .download(doc.signed_pdf_path);
          if (adminData) {
            fileData = adminData;
          }
        }

        if (fileData) {
          const arrayBuf = await fileData.arrayBuffer();
          return new Response(new Uint8Array(arrayBuf), {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'inline; filename="documento_assinado.pdf"',
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        }
      }

      await withPdfData(adminClient(), clinic, doc);
      let bytes;
      try {
        bytes = await documentPdf(doc, { isDraft: doc.status !== 'SIGNED' });
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
          d: { id: t.id, name, text: body },
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
