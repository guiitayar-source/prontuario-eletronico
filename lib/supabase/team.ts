import { adminClient } from './admin.ts';
import { body, check, handle, HttpError, json, writeGuard } from './server.ts';

type Member = {
  clinic_id: string;
  user_id: string;
  role: 'owner' | 'doctor' | 'secretary';
  created_at: string;
};
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function usersById(ids: string[]) {
  const admin = adminClient();
  const result = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (result.error)
    throw new HttpError(503, 'Não foi possível carregar as contas da equipe.');
  const index = new Map(result.data.users.map((user) => [user.id, user]));
  return ids.map((id) => ({
    id,
    email: index.get(id)?.email || 'Conta indisponível',
  }));
}

export const team = handle(async (request, ctx) => {
  if (ctx.role !== 'owner')
    throw new HttpError(
      403,
      'Somente o proprietário da clínica pode gerenciar a equipe.',
    );
  if (request.method === 'GET') {
    const rows = check(
      await ctx.db
        .from('clinic_members')
        .select('clinic_id,user_id,role,created_at')
        .eq('clinic_id', ctx.clinic)
        .order('created_at'),
    ) as Member[];
    const users = await usersById(rows.map((row) => row.user_id));
    const email = new Map(users.map((user) => [user.id, user.email]));
    return json({
      members: rows.map((row) => ({
        ...row,
        email: email.get(row.user_id) || 'Conta indisponível',
      })),
    });
  }
  writeGuard(request, 'X-Team-Action');
  const data = await body(request);
  const action = new URL(request.url).searchParams.get('action');
  const admin = adminClient();
  if (action === 'invite') {
    const email =
      typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    const role = data.role;
    if (!emailPattern.test(email) || email.length > 254)
      throw new HttpError(422, 'Informe um e-mail válido.');
    if (!['doctor', 'secretary'].includes(String(role)))
      throw new HttpError(422, 'Escolha médico ou secretária.');
    const listed = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (listed.error)
      throw new HttpError(503, 'Não foi possível consultar a conta.');
    let user = listed.data.users.find(
      (item) => item.email?.toLowerCase() === email,
    );
    let invitationSent = false;
    if (!user) {
      const invited = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: new URL(request.url).origin + '/',
      });
      if (invited.error || !invited.data.user)
        throw new HttpError(
          503,
          'Não foi possível enviar o convite. Confira a configuração de e-mail do Supabase.',
        );
      user = invited.data.user;
      invitationSent = true;
    }
    const old = await admin
      .from('clinic_members')
      .select('role')
      .eq('clinic_id', ctx.clinic)
      .eq('user_id', user.id)
      .maybeSingle();
    if (old.error)
      throw new HttpError(503, 'Não foi possível verificar a equipe.');
    if (old.data)
      throw new HttpError(409, 'Esta pessoa já faz parte da equipe.');
    const inserted = await admin
      .from('clinic_members')
      .insert({ clinic_id: ctx.clinic, user_id: user.id, role });
    if (inserted.error)
      throw new HttpError(503, 'Não foi possível incluir a pessoa na equipe.');
    await admin
      .from('audit_events')
      .insert({
        clinic_id: ctx.clinic,
        actor_id: ctx.user,
        action: 'invite',
        entity_type: 'clinic_member',
        entity_id: user.id,
        context: { role, invitation_sent: invitationSent },
      });
    return json(
      {
        member: { clinic_id: ctx.clinic, user_id: user.id, role, email },
        invitationSent,
      },
      201,
    );
  }
  const userId = typeof data.user_id === 'string' ? data.user_id : '';
  if (!/^[a-f0-9-]{36}$/i.test(userId))
    throw new HttpError(422, 'Integrante inválido.');
  const target = await admin
    .from('clinic_members')
    .select('role')
    .eq('clinic_id', ctx.clinic)
    .eq('user_id', userId)
    .maybeSingle();
  if (target.error || !target.data)
    throw new HttpError(404, 'Integrante não encontrado.');
  if (target.data.role === 'owner')
    throw new HttpError(
      403,
      'O proprietário não pode ser alterado ou removido nesta tela.',
    );
  if (action === 'role') {
    const role = data.role;
    if (!['doctor', 'secretary'].includes(String(role)))
      throw new HttpError(422, 'Escolha médico ou secretária.');
    const updated = await admin
      .from('clinic_members')
      .update({ role })
      .eq('clinic_id', ctx.clinic)
      .eq('user_id', userId);
    if (updated.error)
      throw new HttpError(503, 'Não foi possível atualizar o papel.');
    await admin
      .from('audit_events')
      .insert({
        clinic_id: ctx.clinic,
        actor_id: ctx.user,
        action: 'role_update',
        entity_type: 'clinic_member',
        entity_id: userId,
        context: { role },
      });
    return json({ ok: true });
  }
  if (action === 'revoke') {
    const removed = await admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', ctx.clinic)
      .eq('user_id', userId);
    if (removed.error)
      throw new HttpError(503, 'Não foi possível revogar o acesso.');
    await admin
      .from('audit_events')
      .insert({
        clinic_id: ctx.clinic,
        actor_id: ctx.user,
        action: 'revoke',
        entity_type: 'clinic_member',
        entity_id: userId,
        context: {},
      });
    return json({ ok: true });
  }
  throw new HttpError(400, 'Ação inválida.');
});
