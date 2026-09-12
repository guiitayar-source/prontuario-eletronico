'use client';
import { getSupabaseBrowserClient } from './client';
let clinicId = '';
export function setClinicId(value: string) { clinicId = value; }
export async function apiFetch(input: string, init: RequestInit = {}) {
  const { data: { session } } = await getSupabaseBrowserClient().auth.getSession();
  if (!session) throw new Error('Entre com sua conta do prontuário.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.access_token}`);
  if (clinicId) headers.set('X-Clinic-Id', clinicId);
  return fetch(input, { ...init, headers, cache: 'no-store' });
}
