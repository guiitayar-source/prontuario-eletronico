import {
  DEMO_ID,
  fields,
  emptyPatient,
  type PatientInput,
  type Patient,
} from './patient-fields.ts';
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
export async function ensureDemo(db: D1Database, owner: string) {
  await db
    .prepare(
      'INSERT OR IGNORE INTO patients (id,owner,name,dob,search_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .bind(
      DEMO_ID,
      owner,
      'Helena Costa',
      '1992-03-15',
      'helena costa',
      1788836400000,
      1788836400000,
    )
    .run();
}
export async function findPatient(db: D1Database, owner: string, id: unknown) {
  if (typeof id !== 'string' || (id !== DEMO_ID && !/^[a-f0-9-]{36}$/.test(id)))
    return null;
  return db
    .prepare('SELECT * FROM patients WHERE owner = ? AND id = ?')
    .bind(owner, id)
    .first<Patient & { owner: string }>();
}
async function present(row: Patient & { owner: string }) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(row.owner + ':' + row.id),
  );
  const draft_key = Array.from(new Uint8Array(bytes))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
  return {
    ...Object.fromEntries(fields.map((f) => [f, row[f] || ''])),
    id: row.id,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    draft_key,
  } as Patient;
}
function validCpf(cpf: string) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;
  for (let n = 9; n < 11; n++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(cpf[i]) * (n + 1 - i);
    let digit = (sum * 10) % 11;
    if (digit === 10) digit = 0;
    if (digit !== Number(cpf[n])) return false;
  }
  return true;
}
export function validate(data: Record<string, unknown>) {
  const p = emptyPatient(),
    errors: Record<string, string> = {};
  for (const f of fields) {
    if (data[f] != null && typeof data[f] !== 'string') {
      errors[f] = 'Informe um texto.';
      continue;
    }
    p[f] = String(data[f] || '').trim();
    if (p[f].length > (f === 'admin_notes' ? 2000 : 180))
      errors[f] = 'Texto muito longo.';
  }
  if (p.name.length < 2) errors.name = 'Informe o nome completo.';
  if (p.dob) {
    const parsed = new Date(p.dob + 'T12:00:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(p.dob) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== p.dob ||
      p.dob > new Date().toISOString().slice(0, 10) ||
      Number(p.dob.slice(0, 4)) < 1850
    )
      errors.dob = 'Informe uma data de nascimento válida.';
  }
  p.cpf = p.cpf.replace(/[.\-\s]/g, '');
  if (p.cpf && !validCpf(p.cpf))
    errors.cpf = 'CPF inválido. Você também pode deixar este campo vazio.';
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email))
    errors.email = 'Confira o e-mail.';
  for (const f of [
    'phone',
    'secondary_phone',
    'guardian_phone',
    'emergency_phone',
  ] as const) {
    if (p[f] && !/^[+\d() .-]{7,30}$/.test(p[f]))
      errors[f] = 'Confira o número de telefone.';
  }
  p.state = p.state.toUpperCase();
  if (
    p.state &&
    ![
      'AC',
      'AL',
      'AP',
      'AM',
      'BA',
      'CE',
      'DF',
      'ES',
      'GO',
      'MA',
      'MT',
      'MS',
      'MG',
      'PA',
      'PB',
      'PR',
      'PE',
      'PI',
      'RJ',
      'RN',
      'RS',
      'RO',
      'RR',
      'SC',
      'SP',
      'SE',
      'TO',
    ].includes(p.state)
  )
    errors.state = 'Use a sigla da UF.';
  p.zip_code = p.zip_code.replace(/[-\s]/g, '');
  if (p.zip_code && !/^\d{8}$/.test(p.zip_code))
    errors.zip_code = 'Informe os 8 dígitos do CEP.';
  return { p, errors };
}
export function patientsHandler(db: D1Database) {
  return async (request: Request) => {
    const reply = (x: unknown, status = 200) =>
      Response.json(x, {
        status,
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    try {
      const owner = request.headers.get('oai-authenticated-user-id');
      if (!owner)
        return reply({ error: 'Entre com sua conta autorizada.' }, 401);
      const url = new URL(request.url);
      if (request.method === 'GET') {
        await ensureDemo(db, owner);
        const id = url.searchParams.get('id');
        if (id) {
          const row = await findPatient(db, owner, id);
          return row
            ? reply({ patient: await present(row) })
            : reply({ error: 'Paciente não encontrado.' }, 404);
        }
        const q = normalize((url.searchParams.get('q') || '').slice(0, 180)),
          page = Math.max(
            0,
            Math.min(
              10000,
              Number.parseInt(url.searchParams.get('page') || '0', 10) || 0,
            ),
          );
        const searchQuery = /^[+\d\s().-]+$/.test(q) ? q.replace(/\D/g, '') : q;
        const like = '%' + searchQuery.replace(/[\\%_]/g, '\\$&') + '%';
        const where =
          "owner = ? AND (search_text LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
        const result = await db
          .prepare(
            `SELECT * FROM patients WHERE ${where} ORDER BY name COLLATE NOCASE,id LIMIT 50 OFFSET ?`,
          )
          .bind(owner, like, like, page * 50)
          .all<Patient & { owner: string }>();
        const count = await db
          .prepare(`SELECT COUNT(*) AS total FROM patients WHERE ${where}`)
          .bind(owner, like, like)
          .first<{ total: number }>();
        return reply({
          patients: await Promise.all(result.results.map(present)),
          total: count?.total || 0,
        });
      }
      if (request.method !== 'POST')
        return reply({ error: 'Método não permitido.' }, 405);
      if (
        request.headers.get('x-patient-action') !== '1' ||
        (request.headers.get('origin') &&
          request.headers.get('origin') !== url.origin)
      )
        return reply({ error: 'Origem não autorizada.' }, 403);
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: 'Solicitação vazia.' }, 400);
      let size = 0,
        body = '';
      const decoder = new TextDecoder();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 16384) {
          await reader.cancel();
          return reply({ error: 'Cadastro excede o tamanho permitido.' }, 413);
        }
        body += decoder.decode(part.value, { stream: true });
      }
      body += decoder.decode();
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(body);
      } catch {
        return reply({ error: 'Solicitação inválida.' }, 400);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        return reply({ error: 'Solicitação inválida.' }, 400);
      const { p, errors } = validate(data);
      if (Object.keys(errors).length)
        return reply(
          { error: 'Confira os campos destacados.', fields: errors },
          422,
        );
      if (
        typeof data.id !== 'string' ||
        (data.id !== DEMO_ID && !/^[a-f0-9-]{36}$/.test(data.id))
      )
        return reply({ error: 'Identificador inválido.' }, 400);
      const action = url.searchParams.get('action');
      if (!['create', 'update'].includes(action || ''))
        return reply({ error: 'Ação inválida.' }, 400);
      const existing = await findPatient(db, owner, data.id);
      if (action === 'update' && !existing)
        return reply({ error: 'Paciente não encontrado.' }, 404);
      if (action === 'create' && existing)
        return reply({ patient: await present(existing) });
      if (p.cpf) {
        const duplicate = await db
          .prepare(
            'SELECT id FROM patients WHERE owner = ? AND cpf = ? AND id <> ?',
          )
          .bind(owner, p.cpf, data.id)
          .first();
        if (duplicate)
          return reply(
            {
              error: 'Já existe um paciente com este CPF.',
              fields: { cpf: 'CPF já cadastrado nesta conta.' },
            },
            409,
          );
      }
      const search = normalize(
        [
          p.name,
          p.social_name,
          p.cpf,
          p.phone,
          p.phone.replace(/\D/g, ''),
          p.email,
        ].join(' '),
      );
      const values = fields.map((f) => p[f] || null),
        now = Date.now();
      try {
        if (action === 'create') {
          await db
            .prepare(
              `INSERT INTO patients (id,owner,${fields.join(',')},search_text,created_at,updated_at) VALUES (${Array(
                fields.length + 5,
              )
                .fill('?')
                .join(',')})`,
            )
            .bind(data.id, owner, ...values, search, now, now)
            .run();
        } else {
          if (!Number.isInteger(data.version))
            return reply({ error: 'Versão do cadastro ausente.' }, 400);
          const changed = await db
            .prepare(
              `UPDATE patients SET ${fields.map((f) => f + ' = ?').join(',')},search_text = ?,updated_at = ?,version = version + 1 WHERE owner = ? AND id = ? AND version = ?`,
            )
            .bind(...values, search, now, owner, data.id, data.version)
            .run();
          if (!changed.meta.changes)
            return reply(
              {
                error:
                  'Este cadastro foi alterado em outra janela. Reabra os dados atualizados antes de salvar.',
                conflict: true,
              },
              409,
            );
        }
      } catch (error) {
        if (String(error).includes('UNIQUE constraint'))
          return reply(
            {
              error:
                'Cadastro duplicado. Atualize a lista antes de tentar novamente.',
            },
            409,
          );
        throw error;
      }
      return reply(
        { patient: await present((await findPatient(db, owner, data.id))!) },
        action === 'create' ? 201 : 200,
      );
    } catch {
      return reply(
        { error: 'Não foi possível acessar os cadastros. Tente novamente.' },
        500,
      );
    }
  };
}
