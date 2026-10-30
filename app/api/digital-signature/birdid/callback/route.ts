import {
  captureOAuthCallback,
  oauthCookie,
} from '@/lib/signature/oauth-context';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  let location = '/signature/connect?result=invalid';
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
  });
  try {
    const { attempt, transfer } = captureOAuthCallback(request);
    headers.append(
      'Set-Cookie',
      oauthCookie(attempt, 'transfer', transfer, request.url, 60),
    );
    location = `/signature/connect?attempt=${attempt}`;
  } catch {
    /* Nunca refletir mensagens, códigos ou identidade recebidos do provedor. */
  }
  headers.set('Location', location);
  return new Response(null, { status: 303, headers });
}
