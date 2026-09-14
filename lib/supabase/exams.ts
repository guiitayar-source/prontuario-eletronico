import {
  validateDefinition,
  validateResult,
  type ExamDefinition,
  type ExamResult,
} from '../exams.ts';
import { body, check, handle, HttpError, json, writeGuard } from './server.ts';
export const exams = handle(async (request, { db, clinic, role }) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(403, 'Resultados disponíveis à equipe médica.');
  const patient = new URL(request.url).searchParams.get('patientId');
  if (!patient || patient.length > 180)
    throw new HttpError(400, 'Selecione um paciente.');
  if (
    !check(
      await db
        .from('patients')
        .select('id')
        .eq('clinic_id', clinic)
        .eq('id', patient)
        .maybeSingle(),
    )
  )
    throw new HttpError(404, 'Paciente não encontrado.');
  if (request.method === 'GET') {
    // Explicit pagination avoids Supabase's default 1000-row truncation.
    const readAll = async (table: string, catalog: boolean) => {
      const rows = [];
      for (let offset = 0; ; offset += 500) {
        let q = db
          .from(table)
          .select('*')
          .order('id')
          .range(offset, offset + 499);
        q = catalog
          ? q.or(`clinic_id.is.null,clinic_id.eq.${clinic}`)
          : q.eq('clinic_id', clinic).eq('patient_id', patient);
        const page = check(await q);
        rows.push(...page);
        if (page.length < 500) return rows;
      }
    };
    const [definitions, results] = await Promise.all([
      readAll('exam_definitions', true),
      readAll('exam_results', false),
    ]);
    return json({ definitions, results });
  }
  writeGuard(request, 'X-Exams-Action');
  const d = await body(request);
  if (d.action === 'definition') {
    try {
      validateDefinition(d as unknown as ExamDefinition);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
  } else if (d.action === 'result') {
    const definition = check(
      await db
        .from('exam_definitions')
        .select('*')
        .eq('id', d.definition_id)
        .or(`clinic_id.is.null,clinic_id.eq.${clinic}`)
        .maybeSingle(),
    );
    if (!definition) throw new HttpError(422, 'Exame não encontrado.');
    try {
      validateResult(d as unknown as ExamResult, definition);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
  } else throw new HttpError(422, 'Operação inválida.');
  const saved = await db.rpc('exam_write', {
    c: clinic,
    action: d.action,
    d: { ...d, patient_id: patient },
  });
  if (saved.error?.code === '23505')
    throw new HttpError(
      409,
      d.action === 'definition'
        ? 'Já existe um exame com esse nome na biblioteca da clínica.'
        : 'Este registro já foi salvo ou corrigido. Recarregue o histórico antes de continuar.',
    );
  return json({ record: check(saved) });
});
