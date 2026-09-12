import { createClient } from '@supabase/supabase-js';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
});
export function check<T>(result: { data: T; error: { code?: string; message: string } | null }): NonNullable<T> {
  if (result.error) {
    const code = result.error.code;
    if (code === '23505') throw new HttpError(409, 'Registro duplicado. Confira o CPF e atualize a lista.');
    if (code === '42501') throw new HttpError(403, 'Sua conta não tem acesso a esta operação.');
    if (code === 'P0001') throw new HttpError(409, result.error.message);
    if (code?.startsWith('22') || code?.startsWith('23')) throw new HttpError(422, 'Confira os dados informados.');
    throw new HttpError(503, 'Não foi possível acessar o banco. Tente novamente.');
  }
  return result.data as NonNullable<T>;
}
export async function boundedBody(request: Request, max = 16384) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Solicitação vazia.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > max) { await reader.cancel(); throw new HttpError(413, 'Envio acima do limite permitido.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return bytes;
}
export async function body(request: Request) {
  const bytes = await boundedBody(request);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, 'Solicitação inválida.'); }
}
export function writeGuard(request: Request, header: string) {
  if (request.method !== 'POST') throw new HttpError(405, 'Método não permitido.');
  const origin = request.headers.get('origin');
  if (request.headers.get(header) !== '1' || (origin && origin !== new URL(request.url).origin)) {
    throw new HttpError(403, 'Origem não autorizada.');
  }
}
export async function context(request: Request) {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'Entre com sua conta do prontuário.');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new HttpError(503, 'Supabase não configurado.');
  const db = createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.auth.getUser(authorization.slice(7));
  if (error || !data.user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
  const memberships = check(await db.from('clinic_members').select('clinic_id,role').eq('user_id', data.user.id));
  const clinic = request.headers.get('x-clinic-id');
  const member = clinic ? memberships.find(m => m.clinic_id === clinic) : memberships[0];
  if (!member) throw new HttpError(403, 'Sua conta ainda não está vinculada a uma clínica.');
  return { db, clinic: member.clinic_id as string, role: member.role as string, user: data.user.id };
}
export type Context = Awaited<ReturnType<typeof context>>;
export const handle = (fn: (request: Request, ctx: Context) => Promise<Response>) => async (request: Request) => {
  try { return await fn(request, await context(request)); }
  catch (error) { return json({ error: error instanceof HttpError ? error.message : 'Não foi possível concluir a operação.' }, error instanceof HttpError ? error.status : 500); }
};
