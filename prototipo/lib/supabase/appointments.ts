import { patient } from './patients.ts';
import { body, check, handle, HttpError, json, writeGuard } from './server.ts';
export const appointments = handle(async (request, ctx) => {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const day = url.searchParams.get('day') || '';
    const start = new Date(`${day}T00:00:00-03:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(start.getTime()) || start.toISOString().slice(0,10) !== day) throw new HttpError(400, 'Informe uma data válida.');
    const rows = check(await ctx.db.from('appointments').select('*,patients(name,social_name)').eq('clinic_id', ctx.clinic)
      .gte('starts_at', start.toISOString()).lt('starts_at', new Date(+start + 86400000).toISOString()).order('starts_at').order('id'));
    return json({ appointments: rows.map(r => ({ ...r, starts_at: Date.parse(r.starts_at), ends_at: Date.parse(r.ends_at),
      patient_name: r.patients?.name, patient_social_name: r.patients?.social_name, patients: undefined })) });
  }
  writeGuard(request, 'x-appointment-action');
  const data = await body(request), action = url.searchParams.get('action');
  if (!['create', 'update', 'cancel'].includes(action || '')) throw new HttpError(400, 'Ação inválida.');
  if (typeof data.id !== 'string' || !/^[a-f0-9-]{36}$/.test(data.id)) throw new HttpError(400, 'Identificador inválido.');
  let values: Record<string, unknown> = { status: 'cancelled' };
  if (action !== 'cancel') {
    await patient(ctx, data.patient_id);
    const start = Number(data.starts_at), end = Number(data.ends_at);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > 4102444800000 || end - start < 600000 || end - start > 28800000) throw new HttpError(422, 'O atendimento deve durar entre 10 minutos e 8 horas, com datas válidas.');
    if (!['presencial', 'teleconsulta'].includes(String(data.modality))) throw new HttpError(422, 'Modalidade inválida.');
    if (typeof data.admin_notes !== 'string' || data.admin_notes.length > 1000) throw new HttpError(422, 'Observação inválida.');
    values = { patient_id: data.patient_id, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), modality: data.modality, admin_notes: data.admin_notes.trim() || null };
  }
  if (action === 'create') {
    const old = check(await ctx.db.from('appointments').select('id').eq('clinic_id', ctx.clinic).eq('id', data.id).maybeSingle());
    if (!old) check(await ctx.db.from('appointments').insert({ ...values, id: data.id, clinic_id: ctx.clinic }));
    return json({ ok: true }, old ? 200 : 201);
  }
  if (!Number.isInteger(data.version)) throw new HttpError(400, 'Versão ausente.');
  const changed = check(await ctx.db.from('appointments').update({ ...values, version: Number(data.version) + 1 })
    .eq('clinic_id', ctx.clinic).eq('id', data.id).eq('version', data.version).eq('status', 'scheduled').select('id').maybeSingle());
  if (!changed) return json({ error: 'Horário alterado em outra janela. Atualize a agenda.', conflict: true }, 409);
  return json({ ok: true });
});
