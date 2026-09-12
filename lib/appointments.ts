import { ensureDemo, findPatient } from './patients.ts';

type AppointmentRow = {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_social_name: string | null;
  starts_at: number;
  ends_at: number;
  modality: string;
  status: string;
  admin_notes: string | null;
  version: number;
};

const validModalities = new Set(['presencial', 'teleconsulta']);
const validStatuses = new Set(['scheduled', 'cancelled']);
const response = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

const dayRange = (day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const local = new Date(year, month - 1, date);
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== date
  )
    return null;
  const start = local.getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return Number.isFinite(start) ? { start, end } : null;
};

const listSql = `SELECT a.*, p.name AS patient_name, p.social_name AS patient_social_name
  FROM appointments a JOIN patients p ON p.owner = a.owner AND p.id = a.patient_id
  WHERE a.owner = ? AND a.starts_at >= ? AND a.starts_at < ?
  ORDER BY a.starts_at, a.id`;

export function appointmentsHandler(db: D1Database) {
  return async (request: Request) => {
    try {
      const owner = request.headers.get('oai-authenticated-user-id');
      if (!owner)
        return response({ error: 'Entre com sua conta autorizada.' }, 401);
      await ensureDemo(db, owner);
      const url = new URL(request.url);

      if (request.method === 'GET') {
        const range = dayRange(url.searchParams.get('day') || '');
        if (!range) return response({ error: 'Informe uma data válida.' }, 400);
        const result = await db
          .prepare(listSql)
          .bind(owner, range.start, range.end)
          .all<AppointmentRow>();
        return response({ appointments: result.results });
      }

      if (request.method !== 'POST')
        return response({ error: 'Método não permitido.' }, 405);
      if (
        request.headers.get('x-appointment-action') !== '1' ||
        (request.headers.get('origin') &&
          request.headers.get('origin') !== url.origin)
      )
        return response({ error: 'Origem não autorizada.' }, 403);

      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!body || Array.isArray(body))
        return response({ error: 'Solicitação inválida.' }, 400);
      const action = url.searchParams.get('action');
      const id = body.id;
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
        return response({ error: 'Identificador inválido.' }, 400);

      if (action === 'cancel') {
        if (!Number.isInteger(body.version))
          return response({ error: 'Versão do horário ausente.' }, 400);
        const changed = await db
          .prepare(
            "UPDATE appointments SET status = 'cancelled', version = version + 1, updated_at = ? WHERE owner = ? AND id = ? AND version = ? AND status = 'scheduled'",
          )
          .bind(Date.now(), owner, id, body.version)
          .run();
        if (!changed.meta.changes)
          return response(
            {
              error:
                'Este horário foi alterado em outra janela. Atualize a agenda.',
              conflict: true,
            },
            409,
          );
        return response({ ok: true });
      }

      if (action !== 'create' && action !== 'update')
        return response({ error: 'Ação inválida.' }, 400);
      if (typeof body.patient_id !== 'string')
        return response({ error: 'Selecione um paciente.' }, 422);
      const patient = await findPatient(db, owner, body.patient_id);
      if (!patient) return response({ error: 'Paciente não encontrado.' }, 404);
      const startsAt = Number(body.starts_at);
      const endsAt = Number(body.ends_at);
      const modality = String(body.modality || 'presencial');
      const notes = String(body.admin_notes || '').trim();
      if (
        !Number.isSafeInteger(startsAt) ||
        !Number.isSafeInteger(endsAt) ||
        endsAt <= startsAt
      )
        return response(
          { error: 'Informe horário de início e término válidos.' },
          422,
        );
      if (
        endsAt - startsAt < 10 * 60 * 1000 ||
        endsAt - startsAt > 8 * 60 * 60 * 1000
      )
        return response(
          { error: 'O atendimento deve durar entre 10 minutos e 8 horas.' },
          422,
        );
      if (!validModalities.has(modality))
        return response({ error: 'Modalidade inválida.' }, 422);
      if (notes.length > 1000)
        return response({ error: 'A observação é muito longa.' }, 422);

      const existing = await db
        .prepare(
          'SELECT id, version FROM appointments WHERE owner = ? AND id = ?',
        )
        .bind(owner, id)
        .first<{ id: string; version: number }>();
      const now = Date.now();
      if (action === 'create') {
        if (existing) return response({ error: 'Horário já existe.' }, 409);
        await db
          .prepare(
            'INSERT INTO appointments (id, owner, patient_id, starts_at, ends_at, modality, status, admin_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            id,
            owner,
            patient.id,
            startsAt,
            endsAt,
            modality,
            'scheduled',
            notes || null,
            now,
            now,
          )
          .run();
      } else {
        if (!existing)
          return response({ error: 'Horário não encontrado.' }, 404);
        if (!Number.isInteger(body.version))
          return response({ error: 'Versão do horário ausente.' }, 400);
        const changed = await db
          .prepare(
            'UPDATE appointments SET patient_id = ?, starts_at = ?, ends_at = ?, modality = ?, admin_notes = ?, version = version + 1, updated_at = ? WHERE owner = ? AND id = ? AND version = ? AND status = ? ',
          )
          .bind(
            patient.id,
            startsAt,
            endsAt,
            modality,
            notes || null,
            now,
            owner,
            id,
            body.version,
            'scheduled',
          )
          .run();
        if (!changed.meta.changes)
          return response(
            {
              error:
                'Este horário foi alterado em outra janela. Atualize a agenda.',
              conflict: true,
            },
            409,
          );
      }
      const appointment = await db
        .prepare(`SELECT a.*, p.name AS patient_name, p.social_name AS patient_social_name
          FROM appointments a JOIN patients p ON p.owner = a.owner AND p.id = a.patient_id
          WHERE a.owner = ? AND a.id = ?`)
        .bind(owner, id)
        .first<AppointmentRow>();
      return response({ appointment }, action === 'create' ? 201 : 200);
    } catch {
      return response(
        { error: 'Não foi possível acessar a agenda. Tente novamente.' },
        500,
      );
    }
  };
}
