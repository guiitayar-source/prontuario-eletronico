import { fields, DEMO_ID, validate, type Patient } from '../patient-fields.ts';
import { body, check, handle, HttpError, json, writeGuard, type Context } from './server.ts';
const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function present(row: Record<string, unknown>, clinic: string): Patient {
  return {
    ...Object.fromEntries(fields.map(f => [f, row[f] || ''])), id: row.id,
    version: row.version, created_at: Date.parse(String(row.created_at)), updated_at: Date.parse(String(row.updated_at)),
    archived_at: typeof row.archived_at === 'string' ? Date.parse(row.archived_at) : null,
    draft_key: `${clinic}:${String(row.id)}`,
  } as Patient;
}
export async function patient(ctx: Context, id: unknown) {
  if (typeof id !== 'string' || id.length > 180) throw new HttpError(400, 'Identificador inválido.');
  const row = check(await ctx.db.from('patients').select('*').eq('clinic_id', ctx.clinic).eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Paciente não encontrado.');
  return row;
}
export const patients = handle(async (request, ctx) => {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) return json({ patient: present(await patient(ctx, id), ctx.clinic) });
    const page = Math.max(0, Math.min(10000, parseInt(url.searchParams.get('page') || '0') || 0));
    let q = normalize((url.searchParams.get('q') || '').slice(0, 180));
    if (/^[+\d\s().-]+$/.test(q)) q = q.replace(/\D/g, '');
    // Arquivados só aparecem na lista própria do proprietário.
    const archived = url.searchParams.get('archived') === '1';
    if (archived && ctx.role !== 'owner') throw new HttpError(403, 'Sua conta não tem acesso a esta operação.');
    const base = ctx.db.from('patients').select('*', { count: 'exact' }).eq('clinic_id', ctx.clinic);
    const query = (archived ? base.not('archived_at', 'is', null) : base.is('archived_at', null))
      .ilike('search_text', `%${q.replace(/[\\%_]/g, '\\$&')}%`).order('name').order('id').range(page * 50, page * 50 + 49);
    const result = await query; const rows = check(result);
    return json({ patients: rows.map(r => present(r, ctx.clinic)), total: result.count || 0 });
  }
  writeGuard(request, 'x-patient-action');
  const data = await body(request), action = url.searchParams.get('action');
  if (action === 'archive' || action === 'restore') {
    if (ctx.role !== 'owner') throw new HttpError(403, 'Somente o proprietário arquiva ou restaura pacientes.');
    if (typeof data.id !== 'string' || !Number.isInteger(data.version)) throw new HttpError(400, 'Identificador inválido.');
    const row = check(await ctx.db.from('patients')
      .update({ archived_at: action === 'archive' ? new Date().toISOString() : null, version: Number(data.version) + 1 })
      .eq('clinic_id', ctx.clinic).eq('id', data.id).eq('version', data.version).select().maybeSingle());
    if (!row) return json({ error: 'Cadastro alterado em outra janela. Reabra o cadastro.', conflict: true }, 409);
    return json({ patient: present(row, ctx.clinic) });
  }
  if (!['create', 'update'].includes(action || '')) throw new HttpError(400, 'Ação inválida.');
  if (typeof data.id !== 'string' || (data.id !== DEMO_ID && !/^[a-f0-9-]{36}$/.test(data.id))) throw new HttpError(400, 'Identificador inválido.');
  const { p, errors } = validate(data);
  if (Object.keys(errors).length) return json({ error: 'Confira os campos destacados.', fields: errors }, 422);
  const values = Object.fromEntries(fields.map(f => [f, p[f] || null]));
  const search_text = normalize([p.name, p.social_name, p.cpf, p.phone, p.phone.replace(/\D/g, ''), p.email].join(' '));
  if (action === 'create') {
    const old = check(await ctx.db.from('patients').select('*').eq('clinic_id', ctx.clinic).eq('id', data.id).maybeSingle());
    if (old) return json({ patient: present(old, ctx.clinic) });
    const row = check(await ctx.db.from('patients').insert({ ...values, search_text, id: data.id, clinic_id: ctx.clinic }).select().single());
    return json({ patient: present(row, ctx.clinic) }, 201);
  }
  if (!Number.isInteger(data.version)) throw new HttpError(400, 'Versão ausente.');
  const row = check(await ctx.db.from('patients').update({ ...values, search_text, version: Number(data.version) + 1 })
    .eq('clinic_id', ctx.clinic).eq('id', data.id).eq('version', data.version).select().maybeSingle());
  if (!row) return json({ error: 'Cadastro alterado em outra janela. Reabra o cadastro.', conflict: true }, 409);
  return json({ patient: present(row, ctx.clinic) });
});
