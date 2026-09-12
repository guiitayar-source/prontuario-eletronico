import {
  handle,
  check,
  json,
  HttpError,
  boundedBody,
  writeGuard,
} from './server.ts';
export const consultations = handle(async (request, { db, clinic, role }) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(
      403,
      'O acesso às evoluções é exclusivo da equipe médica.',
    );
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const patient = url.searchParams.get('patientId');
    if (!patient) throw new HttpError(400, 'Informe o paciente.');
    const rows = check(
      await db
        .from('consultations')
        .select('*,consultation_addenda(*)')
        .eq('clinic_id', clinic)
        .eq('patient_id', patient)
        .order('created_at', { ascending: false }),
    );
    return json({ consultations: rows });
  }
  writeGuard(request, 'X-Consultation-Action');
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(
      new TextDecoder().decode(await boundedBody(request, 450000)),
    );
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Solicitação inválida.');
  }
  if (!d || typeof d !== 'object' || Array.isArray(d))
    throw new HttpError(400, 'Solicitação inválida.');
  const action = url.searchParams.get('action');
  if (!['create', 'save', 'finalize', 'addendum'].includes(action || ''))
    throw new HttpError(400, 'Operação inválida.');
  if (
    action !== 'create' &&
    (typeof d.text !== 'string' || d.text.length > 100000)
  )
    throw new HttpError(422, 'Texto inválido ou acima de 100 mil caracteres.');
  return json({
    consultation: check(
      await db.rpc('consultation_write', { c: clinic, action, d }),
    ),
  });
});
