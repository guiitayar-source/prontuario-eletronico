import {
  sncrAuthConfig,
  AUTH_COOKIE,
  TRANSFER_COOKIE,
  authCookie,
  cookieValue,
} from '@/lib/sncr/auth-config';
import { captureSncrCallback } from '@/lib/sncr/sessions';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ state: string }> },
) {
  const headers = new Headers({
    Location: '/sncr/connect',
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  try {
    const config = sncrAuthConfig(),
      { state } = await params;
    const transfer = captureSncrCallback(
      request,
      state,
      cookieValue(request, AUTH_COOKIE),
      config,
    );
    headers.append(
      'Set-Cookie',
      authCookie(TRANSFER_COOKIE, transfer, config.origin, 30),
    );
  } catch {
    headers.set('Location', '/sncr/connect?result=invalid');
    headers.append(
      'Set-Cookie',
      authCookie(TRANSFER_COOKIE, '', new URL(request.url).origin, 0),
    );
  }
  return new Response(null, { status: 303, headers });
}
