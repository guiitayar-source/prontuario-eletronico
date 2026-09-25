import {
  handle,
  HttpError,
  json,
  writeGuard,
  body,
} from '@/lib/supabase/server';
import { documentSigningService } from '@/lib/signature/document-signing-service';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request, ctx) => {
  writeGuard(request, 'x-signature-action');

  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos podem assinar documentos clínicos.'
    );
  }

  const payload = await body(request);
  const documentId = payload.documentId;

  if (typeof documentId !== 'string' || !documentId.trim()) {
    throw new HttpError(400, 'Informe o ID do documento a ser assinado.');
  }

  const result = await documentSigningService.signClinicalDocument({
    db: ctx.db,
    clinicId: ctx.clinic,
    userId: ctx.user,
    documentId: documentId.trim(),
  });

  return json(result);
});
