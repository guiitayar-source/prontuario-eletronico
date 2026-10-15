// Escolhe as funções do plano de cada clínica. Uso exclusivo do titular (chave de serviço):
//   node --env-file=.env.local scripts/clinic-plan.mjs                         lista as clínicas
//   node --env-file=.env.local scripts/clinic-plan.mjs <email> ia,anamnesator  libera as duas
//   node --env-file=.env.local scripts/clinic-plan.mjs <email> nenhuma         tira todas
// O e-mail é o do proprietário da clínica. A tela esconde o que ficou fora do plano e o
// servidor recusa; a mudança vale quando a pessoa recarregar a página.
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { findUser } from './provision-clinic.mjs';

// Mesma lista da restrição em supabase/migrations/20261015135205_clinic_features.sql.
export const FEATURES = ['ia', 'anamnesator'];

export function parseFeatures(value = '') {
  const text = value.trim().toLowerCase();
  if (text === 'nenhuma') return [];
  const chosen = text
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  if (!chosen.length || chosen.some((f) => !FEATURES.includes(f)))
    throw new Error(
      `Informe ${FEATURES.join(', ')} separados por vírgula, ou "nenhuma".`,
    );
  return FEATURES.filter((f) => chosen.includes(f));
}

export async function setClinicPlan(admin, { email, features }) {
  const user = await findUser(admin, email.trim().toLowerCase());
  if (!user) throw new Error('Nenhuma conta com este e-mail.');
  const owned = await admin
    .from('clinic_members')
    .select('clinic_id')
    .eq('user_id', user.id)
    .eq('role', 'owner');
  if (owned.error)
    throw new Error('Não foi possível consultar as clínicas da conta.');
  if (owned.data.length !== 1)
    throw new Error(
      owned.data.length
        ? 'Esta conta é proprietária de mais de uma clínica. Nada foi alterado.'
        : 'Esta conta não é proprietária de nenhuma clínica.',
    );
  const clinicId = owned.data[0].clinic_id;
  const saved = await admin
    .from('clinic_features')
    .upsert({
      clinic_id: clinicId,
      features,
      updated_at: new Date().toISOString(),
    });
  if (saved.error) throw new Error('Não foi possível gravar o plano.');
  await admin.from('audit_events').insert({
    clinic_id: clinicId,
    actor_id: user.id,
    action: 'clinic_plan_change',
    entity_type: 'clinic_features',
    entity_id: clinicId,
    context: { features, via: 'scripts/clinic-plan.mjs' },
  });
  return { clinicId, features };
}

export async function listClinicPlans(admin) {
  const clinics = await admin
    .from('clinics')
    .select('id,name,clinic_features(features),clinic_members(user_id,role)');
  if (clinics.error) throw new Error('Não foi possível listar as clínicas.');
  const emails = new Map();
  for (let page = 1; ; page++) {
    const r = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (r.error) throw new Error('Não foi possível consultar as contas.');
    for (const u of r.data.users) emails.set(u.id, u.email);
    if (r.data.users.length < 1000) break;
  }
  return clinics.data.map((c) => {
    // Relação um-para-um: o PostgREST devolve objeto; versões antigas, lista.
    const plan = [c.clinic_features].flat()[0];
    const owner = c.clinic_members.find((m) => m.role === 'owner');
    return {
      name: c.name,
      owner: (owner && emails.get(owner.user_id)) || '(sem proprietário)',
      features: plan?.features ?? [],
    };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [email, plan] = process.argv.slice(2);
    if (email && plan === undefined)
      throw new Error(
        'Informe também as funções: ia,anamnesator ou "nenhuma".',
      );
    const features = email ? parseFeatures(plan) : null;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key)
      throw new Error(
        'Configure NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY.',
      );
    const admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    if (features) {
      await setClinicPlan(admin, { email, features });
      console.log(
        `Plano gravado: ${features.length ? features.join(', ') : 'nenhuma função extra'}. Vale quando a pessoa recarregar a página.`,
      );
    } else {
      for (const c of await listClinicPlans(admin))
        console.log(
          `${c.name} · ${c.owner} · ${c.features.join(', ') || 'nenhuma'}`,
        );
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
