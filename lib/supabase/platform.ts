import { adminClient } from './admin';
import { body, handle, HttpError, json, writeGuard } from './server';
import { FEATURES, type Feature } from '@/lib/plan-features';
import { listClinicPlans, setClinicFeatures } from '@/scripts/clinic-plan.mjs';
import { parseArgs, provisionClinic } from '@/scripts/provision-clinic.mjs';

/**
 * Painel do titular da plataforma: lista as clínicas, muda o plano e abre clínicas novas.
 * Só entra quem está em PSYWRITE_ADMIN_USER_IDS (ids de auth.users separados por vírgula),
 * com o segundo fator confirmado. Para os demais, a rota responde como se não existisse.
 * Mostra só dados da conta (proprietário, equipe, plano); nada de pacientes ou prontuário.
 */
export function isPlatformAdmin(
  userId: string,
  allowed = process.env.PSYWRITE_ADMIN_USER_IDS,
) {
  return (allowed || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePlanFeatures(value: unknown): Feature[] {
  if (
    !Array.isArray(value) ||
    value.some((f) => !(FEATURES as readonly unknown[]).includes(f))
  )
    throw new HttpError(422, 'Funções do plano inválidas.');
  return FEATURES.filter((f) => value.includes(f));
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

// Os scripts lançam Error com mensagem pronta para a pessoa; aqui vira resposta 422.
async function userFacing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, (error as Error).message);
  }
}

export const platform = handle(async (request, { user }) => {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const allowed = isPlatformAdmin(user);
  if (request.method === 'GET' && action === 'me')
    return json({ admin: allowed });
  if (!allowed) throw new HttpError(404, 'Página não encontrada.');

  const admin = adminClient();
  if (request.method === 'GET')
    return json({ clinics: await userFacing(() => listClinicPlans(admin)) });

  writeGuard(request, 'X-Platform-Action');
  const data = await body(request);

  if (action === 'features') {
    const clinicId = typeof data.clinic_id === 'string' ? data.clinic_id : '';
    if (!uuid.test(clinicId)) throw new HttpError(400, 'Clínica inválida.');
    const features = parsePlanFeatures(data.features);
    const found = await admin
      .from('clinics')
      .select('id')
      .eq('id', clinicId)
      .maybeSingle();
    if (found.error)
      throw new HttpError(503, 'Não foi possível acessar o banco.');
    if (!found.data) throw new HttpError(404, 'Clínica não encontrada.');
    return json(
      await userFacing(() =>
        setClinicFeatures(admin, {
          clinicId,
          features,
          actorId: user,
          via: 'painel do titular',
        }),
      ),
    );
  }

  if (action === 'provision') {
    const result = await userFacing(async () =>
      provisionClinic(admin, {
        ...parseArgs([text(data.email), text(data.clinic_name), url.origin]),
        via: 'painel do titular',
      }),
    );
    return json({ invitationSent: result.invitationSent });
  }

  throw new HttpError(400, 'Ação desconhecida.');
});
