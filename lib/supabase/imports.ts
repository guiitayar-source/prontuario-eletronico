import {
  boundedBody,
  check,
  handle,
  HttpError,
  json,
  writeGuard,
} from './server.ts';
import { normalizeImport } from '../imports/normalize.ts';
import { MAX_IMPORT_BYTES } from '../imports/types.ts';
export const imports = handle(async (request, { db, clinic, role }) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(
      403,
      'A importação e o histórico clínico são exclusivos da equipe médica.',
    );
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const patientId = url.searchParams.get('patientId');
    const page = Math.max(
      0,
      Math.min(
        10000,
        Number.parseInt(url.searchParams.get('page') || '0') || 0,
      ),
    );
    if (patientId) {
      const q = await db
        .from('import_records')
        .select(
          'id,source,source_id,kind,title,text,occurred_at,source_created_at,source_status,imported_at',
          { count: 'exact' },
        )
        .eq('clinic_id', clinic)
        .eq('patient_id', patientId)
        .is('withdrawn_at', null)
        .order('occurred_sort', { ascending: false, nullsFirst: false })
        .order('id')
        .range(page * 30, page * 30 + 29);
      return json({ records: check(q), total: q.count || 0 });
    }
    return json({
      batches: check(
        await db
          .from('import_batches')
          .select(
            'id,source,format,state,created_at,committed_at,reverted_at,result',
          )
          .eq('clinic_id', clinic)
          .in('state', ['committed', 'reverted'])
          .order('created_at', { ascending: false })
          .limit(50),
      ),
    });
  }
  writeGuard(request, 'X-Import-Action');
  let d: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(await boundedBody(request, 3_000_000)),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error();
    d = parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'JSON inválido. Confira a sintaxe do arquivo.');
  }
  const action = url.searchParams.get('action');
  if (action === 'preview') {
    if (
      typeof d.source !== 'string' ||
      d.source.trim().length < 2 ||
      d.source.trim().length > 80
    )
      throw new HttpError(
        422,
        'Informe um nome para o sistema de origem (2 a 80 caracteres).',
      );
    if (
      typeof d.file !== 'string' ||
      new TextEncoder().encode(d.file).length > MAX_IMPORT_BYTES
    )
      throw new HttpError(413, 'Use um arquivo JSON de até 2 MB.');
    let input: unknown;
    try {
      input = JSON.parse(d.file.replace(/^\uFEFF/, ''));
    } catch {
      throw new HttpError(
        422,
        'O arquivo contém JSON incompleto ou inválido. Corrija a cópia anonimizada ou exporte novamente. Nenhum registro foi importado.',
      );
    }
    let plan;
    try {
      plan = normalizeImport(input);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
    return json(
      check(
        await db.rpc('import_preview', {
          c: clinic,
          origin_name: d.source,
          plan,
        }),
      ),
    );
  }
  if (typeof d.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(d.id))
    throw new HttpError(422, 'Identificador de importação inválido.');
  if (action === 'commit') {
    if (d.confirmed !== true || !Array.isArray(d.choices))
      throw new HttpError(422, 'Revise e confirme a importação.');
    return json({
      result: check(
        await db.rpc('import_commit', {
          c: clinic,
          b: d.id,
          choices: d.choices,
        }),
      ),
    });
  }
  if (action === 'revert' || action === 'cancel') {
    check(
      await db.rpc(action === 'revert' ? 'import_revert' : 'import_cancel', {
        c: clinic,
        b: d.id,
      }),
    );
    return json({ ok: true });
  }
  throw new HttpError(400, 'Operação inválida.');
});
