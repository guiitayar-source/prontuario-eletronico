import crypto from 'node:crypto';
import { adminClient } from '@/lib/supabase/admin';
import { documentSigningService } from '@/lib/signature/document-signing-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam =
    url.searchParams.get('error_description') || url.searchParams.get('error');

  const redirectBase = `${url.origin}/`;

  if (errorParam) {
    return Response.redirect(
      `${redirectBase}?signature_error=${encodeURIComponent(errorParam)}`,
      302
    );
  }

  if (!code || !state) {
    return Response.redirect(
      `${redirectBase}?signature_error=${encodeURIComponent('Parâmetros de autorização ausentes.')}`,
      302
    );
  }

  try {
    const admin = adminClient();
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');

    const { data: stateRecord } = await admin
      .from('signature_oauth_states')
      .select('clinic_id, user_id')
      .eq('state_hash', stateHash)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!stateRecord) {
      return Response.redirect(
        `${redirectBase}?signature_error=${encodeURIComponent('Sessão de autorização expirada ou inválida. Tente novamente.')}`,
        302
      );
    }

    await documentSigningService.handleOAuthCallback({
      db: admin,
      clinicId: stateRecord.clinic_id,
      userId: stateRecord.user_id,
      code,
      state,
    });

    return Response.redirect(
      `${redirectBase}?signature_status=connected`,
      302
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Erro desconhecido na autorização Bird ID.';
    return Response.redirect(
      `${redirectBase}?signature_error=${encodeURIComponent(message)}`,
      302
    );
  }
}
