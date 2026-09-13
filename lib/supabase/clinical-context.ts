import { body, check, handle, HttpError, json, writeGuard } from './server.ts';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowed = {
  condition: ['hypothesis', 'confirmed', 'resolved'],
  medication: ['active', 'stopped'],
  allergy: ['active', 'inactive'],
  allergy_state: ['unknown', 'none', 'known'],
} as const;
export const clinicalContext = handle(async (request, { db, clinic, role }) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(
      403,
      'O contexto clínico é exclusivo da equipe médica.',
    );
  const url = new URL(request.url),
    patient = url.searchParams.get('patientId');
  if (!patient || patient.length > 180)
    throw new HttpError(400, 'Informe o paciente.');
  if (request.method === 'GET') {
    const [conditions, medications, allergies, state] = await Promise.all([
      db
        .from('patient_conditions')
        .select('*')
        .eq('clinic_id', clinic)
        .eq('patient_id', patient)
        .order('updated_at', { ascending: false }),
      db
        .from('patient_medications')
        .select('*')
        .eq('clinic_id', clinic)
        .eq('patient_id', patient)
        .order('updated_at', { ascending: false }),
      db
        .from('patient_allergies')
        .select('*')
        .eq('clinic_id', clinic)
        .eq('patient_id', patient)
        .order('updated_at', { ascending: false }),
      db
        .from('patient_allergy_states')
        .select('*')
        .eq('clinic_id', clinic)
        .eq('id', patient)
        .maybeSingle(),
    ]);
    return json({
      conditions: check(conditions),
      medications: check(medications),
      allergies: check(allergies),
      allergyState: check(state) || { state: 'unknown', version: 0 },
    });
  }
  writeGuard(request, 'X-Clinical-Context-Action');
  const d = await body(request);
  if (typeof d.entity !== 'string')
    throw new HttpError(422, 'Confira os dados do contexto clínico.');
  const entity = d.entity;
  if (
    !(entity in allowed) ||
    d.patient_id !== patient ||
    !Number.isInteger(d.version) ||
    Number(d.version) < 0
  )
    throw new HttpError(422, 'Confira os dados do contexto clínico.');
  if (
    entity !== 'allergy_state' &&
    (typeof d.id !== 'string' || !uuid.test(d.id))
  )
    throw new HttpError(422, 'Identificador inválido.');
  const status = entity === 'allergy_state' ? d.state : d.status;
  if (
    !(allowed[entity as keyof typeof allowed] as readonly unknown[]).includes(
      status,
    )
  )
    throw new HttpError(422, 'Situação inválida.');
  const field =
    entity === 'condition'
      ? 'description'
      : entity === 'medication'
        ? 'name'
        : entity === 'allergy'
          ? 'substance'
          : '';
  if (
    field &&
    (!(d[field] as string)?.trim() ||
      String(d[field]).length > (entity === 'condition' ? 500 : 300))
  )
    throw new HttpError(422, 'Preencha a descrição principal.');
  for (const [name, max] of [
    ['cid_code', 20],
    ['notes', 4000],
    ['dose', 200],
    ['instructions', 1000],
    ['reaction', 1000],
  ] as const)
    if (
      (d[name] != null && typeof d[name] !== 'string') ||
      (typeof d[name] === 'string' && d[name].length > max)
    )
      throw new HttpError(422, 'Um dos campos está acima do limite permitido.');
  return json({
    record: check(
      await db.rpc('clinical_context_write', { c: clinic, entity, d }),
    ),
  });
});
