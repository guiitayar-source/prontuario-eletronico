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
export const documents = handle(async (request, { db, clinic, role, user }) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(
      403,
      'Documentos clínicos são exclusivos da equipe médica.',
    );
  const u = new URL(request.url),
    pid = u.searchParams.get('patientId');
  if (request.method === 'GET') {
    if (!pid) throw new HttpError(400, 'Informe o paciente.');
    if (u.searchParams.get('action') === 'pdf') {
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

      if (doc.kind === 'Receita') {
        const patientData = check(
          await db
            .from('patients')
            .select('street,address_number,complement,neighborhood,city,state')
            .eq('clinic_id', clinic)
            .eq('id', pid)
            .maybeSingle(),
        ) as {
          street?: string;
          address_number?: string;
          complement?: string;
          neighborhood?: string;
          city?: string;
          state?: string;
        } | null;
        if (patientData) {
          const parts = [
            patientData.street,
            patientData.address_number ? `nº ${patientData.address_number}` : '',
            patientData.complement,
            patientData.neighborhood,
          ].filter(Boolean);
          doc.patient_address = parts.join(', ');
          doc.patient_city = patientData.city || '';
          doc.patient_state = patientData.state || '';
        }
      }
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
      profile: check(
        await db
          .from('document_profiles')
          .select('physician_name,physician_registration,cpf')
          .eq('clinic_id', clinic)
          .eq('user_id', user)
          .maybeSingle(),
      ),
    });
  }
  writeGuard(request, 'X-Document-Action');
  let d;
  const bytes = await boundedBody(request, 450000);
  try {
    d = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'Solicitação inválida.');
  }
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
