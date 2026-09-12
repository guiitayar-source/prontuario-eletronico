import { ensureDemo, findPatient } from './patients.ts';
// Authentication headers are trusted only behind the private Sites dispatcher.
// Clinical records are not supported by this demonstration.
export const PATIENT = { id: 'demo-helena-0001', name: 'Helena Costa' };
export const MAX_FILE = 12 * 1024 * 1024;
const SESSION_MS = 2 * 60 * 60 * 1000;
const REQUEST_MS = 15 * 60 * 1000;
const categories = ['exam', 'report', 'other'];
type Pair = {
  id: string;
  owner: string;
  token_hash: string;
  expires_at: number;
  revoked: number;
  last_seen: number | null;
};
type Ticket = {
  id: string;
  session_id: string;
  owner: string;
  patient_id: string;
  patient_name: string;
  category: string;
  expires_at: number;
  state: string;
};
type Attachment = {
  id: string;
  owner: string;
  object_key: string;
  name: string;
  mime: string;
  size: number;
  request_id: string;
};
class Problem extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const ensure = (ok: unknown, status: number, message: string) => {
  if (!ok) throw new Problem(status, message);
};
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
async function hash(token: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function uid(value: unknown): string {
  ensure(
    typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value),
    400,
    'Identificador inválido.',
  );
  return value as string;
}
function category(value: unknown): string {
  ensure(
    typeof value === 'string' && categories.includes(value),
    400,
    'Selecione exame, relatório externo ou outro documento.',
  );
  return value as string;
}
export function fileType(data: Uint8Array): string | null {
  const prefix = (...n: number[]) => n.every((v, i) => data[i] === v);
  if (prefix(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (prefix(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (prefix(37, 80, 68, 70, 45)) return 'application/pdf';
  if (
    prefix(82, 73, 70, 70) &&
    new TextDecoder().decode(data.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}
async function boundedBody(request: Request, max: number) {
  ensure(
    Number(request.headers.get('content-length') || 0) <= max,
    413,
    'Arquivo acima do limite permitido.',
  );
  const reader = request.body?.getReader();
  ensure(reader, 400, 'Envio vazio.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader!.read();
    if (part.done) break;
    size += part.value.length;
    if (size > max) {
      await reader!.cancel();
      throw new Problem(413, 'Arquivo acima do limite permitido.');
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export function captureHandler(db: D1Database, bucket: R2Bucket) {
  async function pair(id: unknown, owner: string, token?: string | null) {
    const row = await db
      .prepare('SELECT * FROM device_sessions WHERE id = ? AND owner = ?')
      .bind(uid(id), owner)
      .first<Pair>();
    ensure(
      row && !row.revoked && row.expires_at > Date.now(),
      410,
      'Conexão encerrada ou expirada. Conecte novamente pelo computador.',
    );
    if (token !== undefined)
      ensure(
        token && token.length === 64 && (await hash(token)) === row!.token_hash,
        403,
        'Conexão não autorizada. Leia o QR code novamente.',
      );
    return row!;
  }
  async function ticket(id: unknown, owner: string, token: string | null) {
    const row = await db
      .prepare('SELECT * FROM capture_requests WHERE id = ? AND owner = ?')
      .bind(uid(id), owner)
      .first<Ticket>();
    ensure(row, 404, 'Solicitação não encontrada.');
    await pair(row!.session_id, owner, token);
    ensure(
      row!.state === 'pending' && row!.expires_at > Date.now(),
      409,
      'Esta solicitação foi encerrada ou expirou. Solicite um novo envio no computador.',
    );
    return row!;
  }
  async function createTicket(
    sessionId: string,
    owner: string,
    kind: string,
    patient: { id: string; name: string },
  ) {
    const id = crypto.randomUUID(),
      now = Date.now();
    await db.batch([
      db
        .prepare(
          "UPDATE capture_requests SET state = 'cancelled' WHERE session_id = ? AND owner = ? AND state = 'pending'",
        )
        .bind(sessionId, owner),
      db
        .prepare(
          'INSERT INTO capture_requests (id, session_id, owner, patient_id, patient_name, category, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          sessionId,
          owner,
          patient.id,
          patient.name,
          kind,
          now,
          now + REQUEST_MS,
        ),
    ]);
    return {
      id,
      patient_name: patient.name,
      patient_id: patient.id,
      expires_at: now + REQUEST_MS,
      state: 'pending',
    };
  }
  return async function handle(request: Request): Promise<Response> {
    try {
      const owner = request.headers.get('oai-authenticated-user-id');
      ensure(
        owner && owner.length < 256,
        401,
        'Entre com sua conta autorizada para continuar.',
      );
      const user = owner!;
      await ensureDemo(db, user);
      const url = new URL(request.url),
        action = url.searchParams.get('action');
      if (request.method === 'GET') {
        if (action === 'list') {
          const selected = await findPatient(
            db,
            user,
            url.searchParams.get('patientId') || PATIENT.id,
          );
          ensure(selected, 404, 'Paciente não encontrado.');
          const result = await db
            .prepare(
              'SELECT id, request_id, name, mime, size, category, created_at FROM attachments WHERE owner = ? AND patient_id = ? ORDER BY created_at, id',
            )
            .bind(user, selected!.id)
            .all();
          return json({ attachments: result.results });
        }
        if (action === 'pair' || action === 'mobile') {
          const p = await pair(
            url.searchParams.get('id'),
            user,
            action === 'mobile'
              ? request.headers.get('x-device-token')
              : undefined,
          );
          if (action === 'mobile')
            await db
              .prepare(
                'UPDATE device_sessions SET last_seen = ? WHERE id = ? AND owner = ?',
              )
              .bind(Date.now(), p.id, user)
              .run();
          const current = await db
            .prepare(
              'SELECT id, patient_id, patient_name, category, expires_at, state FROM capture_requests WHERE session_id = ? AND owner = ? ORDER BY created_at DESC LIMIT 1',
            )
            .bind(p.id, user)
            .first();
          return json({
            id: p.id,
            expires_at: p.expires_at,
            connected: Boolean(p.last_seen && p.last_seen > Date.now() - 15000),
            request: current,
          });
        }
        if (action === 'file') {
          const record = await db
            .prepare(
              'SELECT * FROM attachments WHERE id = ? AND owner = ? AND patient_id = ?',
            )
            .bind(
              uid(url.searchParams.get('id')),
              user,
              url.searchParams.get('patientId') || PATIENT.id,
            )
            .first<Attachment>();
          ensure(record, 404, 'Anexo não encontrado.');
          const object = await bucket.get(record!.object_key);
          ensure(object, 404, 'Arquivo não encontrado.');
          return new Response(object!.body as BodyInit, {
            headers: {
              'Content-Type': record!.mime,
              'Content-Length': String(record!.size),
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record!.name)}`,
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'; sandbox",
            },
          });
        }
        throw new Problem(404, 'Ação não encontrada.');
      }
      ensure(request.method === 'POST', 405, 'Método não permitido.');
      const origin = request.headers.get('origin');
      ensure(!origin || origin === url.origin, 403, 'Origem não autorizada.');
      ensure(
        request.headers.get('x-capture-action') === '1',
        403,
        'Solicitação não autorizada.',
      );
      if (action === 'upload') {
        const raw = await boundedBody(request, MAX_FILE + 65536);
        const form = await new Response(raw, {
          headers: {
            'Content-Type': request.headers.get('content-type') || '',
          },
        }).formData();
        const req = await ticket(
          form.get('requestId'),
          user,
          request.headers.get('x-device-token'),
        );
        const id = uid(form.get('uploadId'));
        const existing = await db
          .prepare(
            'SELECT id FROM attachments WHERE id = ? AND owner = ? AND request_id = ?',
          )
          .bind(id, user, req.id)
          .first();
        if (existing) return json({ id, alreadyReceived: true });
        const file = form.get('file');
        ensure(
          file instanceof File && file.size > 0 && file.size <= MAX_FILE,
          400,
          'Selecione um arquivo de até 12 MB.',
        );
        const f = file as File,
          bytes = new Uint8Array(await f.arrayBuffer()),
          mime = fileType(bytes);
        ensure(
          mime &&
            (f.type === mime ||
              f.type === '' ||
              f.type === 'application/octet-stream'),
          415,
          'Formato não aceito. Use JPG, PNG, WebP ou PDF.',
        );
        const count = await db
          .prepare('SELECT COUNT(*) AS n FROM attachments WHERE request_id = ?')
          .bind(req.id)
          .first<{ n: number }>();
        ensure(
          count!.n < 10,
          409,
          'Limite de 10 arquivos por solicitação. Inicie outra no computador.',
        );
        const name =
          f.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 160) || 'anexo';
        // A unique object key prevents concurrent retries from overwriting accepted bytes.
        const key = `captures/${crypto.randomUUID()}`;
        await bucket.put(key, bytes, { httpMetadata: { contentType: mime! } });
        try {
          const result = await db
            .prepare(`INSERT OR IGNORE INTO attachments (id, owner, request_id, patient_id, name, mime, size, object_key, category, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
            WHERE EXISTS (SELECT 1 FROM capture_requests r JOIN device_sessions s ON s.id = r.session_id WHERE r.id = ? AND r.owner = ? AND r.state = 'pending' AND r.expires_at > ? AND s.revoked = 0 AND s.expires_at > ?)
            AND (SELECT COUNT(*) FROM attachments WHERE request_id = ?) < 10`)
            .bind(
              id,
              user,
              req.id,
              req.patient_id,
              name,
              mime,
              f.size,
              key,
              Date.now(),
              req.id,
              user,
              Date.now(),
              Date.now(),
              req.id,
            )
            .run();
          if (!result.meta.changes) {
            await bucket.delete(key);
            const duplicate = await db
              .prepare(
                'SELECT id FROM attachments WHERE id = ? AND owner = ? AND request_id = ?',
              )
              .bind(id, user, req.id)
              .first();
            if (duplicate) return json({ id, alreadyReceived: true });
            throw new Problem(
              409,
              'Solicitação encerrada ou limite atingido. O arquivo não foi anexado.',
            );
          }
        } catch (error) {
          await bucket.delete(key);
          throw error;
        }
        return json({ id }, 201);
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(
          new TextDecoder().decode(await boundedBody(request, 16384)),
        );
      } catch (e) {
        if (e instanceof Problem) throw e;
        throw new Problem(400, 'Solicitação inválida.');
      }
      ensure(
        data && typeof data === 'object' && !Array.isArray(data),
        400,
        'Solicitação inválida.',
      );
      if (action === 'connect') {
        const selected = await findPatient(
          db,
          user,
          data.patientId ?? PATIENT.id,
        );
        ensure(selected, 404, 'Paciente não encontrado.');
        const kind = category(data.category),
          id = crypto.randomUUID();
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((n) => n.toString(16).padStart(2, '0'))
          .join('');
        const expires = Date.now() + SESSION_MS;
        await db
          .prepare(
            'INSERT INTO device_sessions (id, owner, token_hash, expires_at) VALUES (?, ?, ?, ?)',
          )
          .bind(id, user, await hash(token), expires)
          .run();
        const req = await createTicket(id, user, kind, selected!);
        return json({ id, token, expires_at: expires, request: req }, 201);
      }
      if (action === 'request') {
        const selected = await findPatient(
          db,
          user,
          data.patientId ?? PATIENT.id,
        );
        ensure(selected, 404, 'Paciente não encontrado.');
        const p = await pair(data.id, user);
        return json({
          request: await createTicket(
            p.id,
            user,
            category(data.category),
            selected!,
          ),
        });
      }
      if (action === 'disconnect') {
        await db
          .prepare(
            'UPDATE device_sessions SET revoked = 1 WHERE id = ? AND owner = ?',
          )
          .bind(uid(data.id), user)
          .run();
        return json({ ok: true });
      }
      if (action === 'complete') {
        const existing = await db
          .prepare('SELECT * FROM capture_requests WHERE id = ? AND owner = ?')
          .bind(uid(data.id), user)
          .first<Ticket>();
        ensure(existing, 404, 'Solicitação não encontrada.');
        await pair(
          existing!.session_id,
          user,
          request.headers.get('x-device-token'),
        );
        if (existing!.state === 'complete') return json({ ok: true });
        const req = await ticket(
          data.id,
          user,
          request.headers.get('x-device-token'),
        );
        await db
          .prepare(
            "UPDATE capture_requests SET state = 'complete' WHERE id = ? AND owner = ?",
          )
          .bind(req.id, user)
          .run();
        return json({ ok: true });
      }
      if (action === 'classify' || action === 'delete') {
        const record = await db
          .prepare(
            'SELECT * FROM attachments WHERE id = ? AND owner = ? AND patient_id = ?',
          )
          .bind(uid(data.id), user, data.patientId ?? PATIENT.id)
          .first<Attachment>();
        ensure(record, 404, 'Anexo não encontrado.');
        if (action === 'classify')
          await db
            .prepare(
              'UPDATE attachments SET category = ? WHERE id = ? AND owner = ?',
            )
            .bind(category(data.category), record!.id, user)
            .run();
        else {
          await bucket.delete(record!.object_key);
          await db
            .prepare('DELETE FROM attachments WHERE id = ? AND owner = ?')
            .bind(record!.id, user)
            .run();
        }
        return json({ ok: true });
      }
      throw new Problem(404, 'Ação não encontrada.');
    } catch (error) {
      // Do not log document names, tokens or request bodies.
      return json(
        {
          error:
            error instanceof Problem
              ? error.message
              : 'Não foi possível concluir. Tente novamente; os arquivos recebidos continuam disponíveis.',
        },
        error instanceof Problem ? error.status : 500,
      );
    }
  };
}
