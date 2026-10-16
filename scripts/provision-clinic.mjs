// Abre a clínica de um médico novo e o convida como proprietário. Uso exclusivo do titular:
//   node --env-file=.env.local scripts/provision-clinic.mjs <email> "<nome da clínica>" <origem>
// Ex.: ... dra.ana@exemplo.com "Consultório Dra. Ana" https://psywrite.vercel.app
// O cadastro público segue fechado (auth.enable_signup = false); cada colega entra por aqui.
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseArgs([email = '', clinicName = '', origin = '']) {
  const e = email.trim().toLowerCase();
  const name = clinicName.trim();
  if (!emailPattern.test(e) || e.length > 254) throw new Error('Informe um e-mail válido.');
  if (name.length < 2 || name.length > 120)
    throw new Error('O nome da clínica deve ter entre 2 e 120 caracteres.');
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Informe a origem do aplicativo, ex.: https://psywrite.vercel.app');
  }
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('A origem precisa usar https.');
  return { email: e, clinicName: name, origin: url.origin };
}

export async function findUser(admin, email) {
  for (let page = 1; ; page++) {
    const r = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (r.error) throw new Error('Não foi possível consultar as contas.');
    const found = r.data.users.find((u) => u.email?.toLowerCase() === email);
    if (found || r.data.users.length < 1000) return found;
  }
}

export async function provisionClinic(
  admin,
  { email, clinicName, origin, via = 'scripts/provision-clinic.mjs' },
) {
  let user = await findUser(admin, email);
  if (user) {
    const owned = await admin
      .from('clinic_members')
      .select('clinic_id')
      .eq('user_id', user.id)
      .eq('role', 'owner');
    if (owned.error) throw new Error('Não foi possível consultar as clínicas da conta.');
    if (owned.data.length)
      throw new Error('Esta conta já é proprietária de uma clínica. Nada foi criado.');
  }

  const clinic = await admin.from('clinics').insert({ name: clinicName }).select('id').single();
  if (clinic.error) throw new Error('Não foi possível criar a clínica.');
  const clinicId = clinic.data.id;

  let invitationSent = false;
  try {
    if (!user) {
      const invited = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${origin}/?first_access=true`,
        data: { must_set_password: true, invited_role: 'owner' },
      });
      if (invited.error || !invited.data.user)
        throw new Error('Não foi possível enviar o convite. Confira o e-mail do Supabase.');
      user = invited.data.user;
      invitationSent = true;
    }
    const member = await admin
      .from('clinic_members')
      .insert({ clinic_id: clinicId, user_id: user.id, role: 'owner' });
    if (member.error) throw new Error('Não foi possível vincular o proprietário.');
  } catch (error) {
    // Sem proprietário a clínica fica inacessível; desfaz para permitir nova tentativa.
    await admin.from('clinics').delete().eq('id', clinicId);
    throw error;
  }

  await admin.from('audit_events').insert({
    clinic_id: clinicId,
    actor_id: user.id,
    action: 'clinic_provision',
    entity_type: 'clinics',
    entity_id: clinicId,
    context: { invitation_sent: invitationSent, via },
  });
  return { clinicId, userId: user.id, invitationSent };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const input = parseArgs(process.argv.slice(2));
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('Configure NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY.');
    const admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const r = await provisionClinic(admin, input);
    console.log(
      r.invitationSent
        ? `Clínica criada. Convite enviado para ${input.email}: no primeiro acesso a pessoa define a senha e ativa o MFA.`
        : `Clínica criada e vinculada à conta existente de ${input.email}.`,
    );
    console.log(
      `A clínica começa sem IA e sem Anamnesator. Para liberar: node --env-file=.env.local scripts/clinic-plan.mjs ${input.email} ia,anamnesator`,
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
