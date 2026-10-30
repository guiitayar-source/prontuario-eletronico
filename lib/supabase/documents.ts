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
import { isPrescriptionCategory } from '../sncr/policy.ts';

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
      if (doc.kind === 'Receita') {
        const electronic = await adminClient().from('sncr_rce_emissions').select('id').eq('clinic_id', clinic)
          .eq('document_id', doc.id).neq('state', 'CANCELLED').maybeSingle();
        // Keep printing available on checkouts whose RCE migration is not yet
        // applied, but do not hide other database failures behind a new PDF.
        if (electronic.error && !['42P01', 'PGRST205'].includes(electronic.error.code)) check(electronic);
        if (electronic.data) throw new HttpError(409, 'Esta receita possui uma RCE eletrônica. Abra a emissão para revisar ou recuperar o original.');
      }

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
        throw new HttpError(503, 'O PDF assinado não está disponível. Tente novamente ou solicite a recuperação do arquivo original.');
      }
      if (doc.status === 'SIGNED') throw new HttpError(503, 'O arquivo original assinado precisa ser recuperado.');
      if (doc.status === 'SIGNING') throw new HttpError(409, 'Aguarde a conclusão da assinatura antes de abrir o PDF.');
      if (doc.kind === 'Receita' && doc.prescription_category && doc.prescription_category !== 'RCE' && doc.prescription_category !== 'SIMPLES')
        throw new HttpError(422, 'O PDF atual é exclusivo de Receita de Controle Especial ou receita simples. Utilize o receituário físico adequado para a categoria selecionada.');

      await withPdfData(adminClient(), clinic, doc);
      let bytes;
      try {
        bytes = await documentPdf(doc, { isDraft: true });
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
    const rows = check(
        await db
          .from('clinical_documents')
          .select('*')
          .eq('clinic_id', clinic)
          .eq('patient_id', pid)
          .order('updated_at', { ascending: false }),
      );
    const electronic = await adminClient().from('sncr_rce_emissions').select('id,document_id,state,number,environment')
      .eq('clinic_id', clinic).neq('state', 'CANCELLED').in('document_id', rows.map(r => r.id));
    if (electronic.error && !['42P01', 'PGRST205'].includes(electronic.error.code)) check(electronic);
    return json({
      documents: rows.map(r => ({ ...r, rce_emission: electronic.data?.find(e => e.document_id === r.id) || null })),
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
    (d.kind === 'Receita' && d.prescription_category != null && !isPrescriptionCategory(d.prescription_category)) ||
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
  if (d.kind === 'Receita') {
    // An older RPC silently ignores unknown JSON fields. Check schema BEFORE
    // writing so an undeployed migration cannot turn an NRB/RET into an RCE.
    const schema = await db.from('clinical_documents').select(d.rce_fields ? 'prescription_category,rce_fields' : 'prescription_category').eq('clinic_id', clinic).limit(0);
    if (schema.error) throw new HttpError(503, 'A atualização de receitas ainda não foi aplicada ao banco. Seu rascunho foi mantido nesta tela.');
  }
  return json({
    document: check(await db.rpc('document_write', { c: clinic, d })),
  });
});
