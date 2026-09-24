'use client';
import { getSupabaseBrowserClient } from './client';
let clinicId = '';
export function setClinicId(value: string) { clinicId = value; }
export async function apiFetch(input: string, init: RequestInit = {}) {
  const supabase = getSupabaseBrowserClient();
  let { data: { session } } = await supabase.auth.getSession();
  if (session && session.expires_at && session.expires_at * 1000 < Date.now() + 60000) {
    const refreshed = await supabase.auth.refreshSession().catch(() => null);
    if (refreshed?.data?.session) {
      session = refreshed.data.session;
    }
  }
  if (!session) throw new Error('Entre com sua conta do prontuário.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.access_token}`);
  if (clinicId) headers.set('X-Clinic-Id', clinicId);
  const response = await fetch(input, { ...init, headers, cache: 'no-store' });
  if (response.status === 401) {
    const refreshed = await supabase.auth.refreshSession().catch(() => null);
    if (refreshed?.data?.session) {
      headers.set('Authorization', `Bearer ${refreshed.data.session.access_token}`);
      return fetch(input, { ...init, headers, cache: 'no-store' });
    }
  }
  return response;
}
