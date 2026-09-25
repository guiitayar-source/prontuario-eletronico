import { handle, HttpError, json } from '@/lib/supabase/server';
import { documentSigningService } from '@/lib/signature/document-signing-service';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos têm permissão para assinar documentos.'
    );
  }

  const result = await documentSigningService.signTestDocument({
    clinicId: ctx.clinic,
    userId: ctx.user,
  });

  return json(result);
});

export const GET = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos têm acesso aos testes de assinatura.'
    );
  }

  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  if (!path) {
    throw new HttpError(400, 'Informe o caminho do documento.');
  }

  const bucket = ctx.db.storage.from('clinical-files');
  const { data, error } = await bucket.download(path);
  if (error || !data) {
    throw new HttpError(404, 'Arquivo não encontrado.');
  }

  const arrayBuf = await data.arrayBuffer();
  return new Response(new Uint8Array(arrayBuf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="teste_assinado_pades.pdf"',
      'Cache-Control': 'private, no-store',
    },
  });
});
