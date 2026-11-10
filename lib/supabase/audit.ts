import { check, handle, HttpError, json } from './server.ts';

export function auditFilters(params: URLSearchParams) {
  const read = (key: string, max: number) => {
    const value = params.get(key)?.trim() || null;
    if (value && value.length > max)
      throw new HttpError(400, 'Filtro acima do limite permitido.');
    return value;
  };
  const actor = read('actor', 36),
    before = read('before', 19);
  if (
    actor &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      actor,
    )
  )
    throw new HttpError(400, 'Informe o ID completo da conta do profissional.');
  if (
    before &&
    (!/^[1-9]\d*$/.test(before) ||
      BigInt(before) > BigInt('9223372036854775807'))
  )
    throw new HttpError(400, 'Página inválida.');
  function day(key: string, next = false) {
    const value = read(key, 10);
    if (!value) return null;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw new HttpError(400, 'Data inválida.');
    const start = Date.parse(`${value}T00:00:00-03:00`);
    return new Date(start + (next ? 86400000 : 0)).toISOString();
  }
  const from = day('from'),
    to = day('to', true),
    category = read('category', 20) || 'all';
  if (from && to && from >= to)
    throw new HttpError(400, 'Confira o período informado.');
  if (!['all', 'imports', 'clinical', 'security'].includes(category))
    throw new HttpError(400, 'Categoria inválida.');
  return {
    before_id: before,
    from_at: from,
    to_at: to,
    actor,
    patient: read('patient', 180),
    operation: read('operation', 80),
    category,
    search: read('q', 180),
  };
}

export const audit = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role))
    throw new HttpError(403, 'Auditoria restrita a médicos.');
  const result = await ctx.db.rpc('audit_search', {
    c: ctx.clinic,
    ...auditFilters(new URL(request.url).searchParams),
  });
  if (result.error?.code === 'PGRST202')
    throw new HttpError(
      503,
      'A pesquisa da auditoria aguarda atualização do banco.',
    );
  const rows = check(result) as {
    id: number | string;
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    occurred_at: string;
  }[];
  const events = rows
    .slice(0, 100)
    .map(({ id, actor_id, action, entity_type, entity_id, occurred_at }) => ({
      id,
      actor_id,
      action,
      entity_type,
      entity_id,
      occurred_at,
    }));
  return json({
    events,
    next: rows.length > 100 ? String(events[99].id) : null,
  });
});
