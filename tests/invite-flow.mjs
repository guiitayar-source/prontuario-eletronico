import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { team } from '../lib/supabase/team.ts';

const raw = execFileSync('node_modules/.bin/supabase', ['status', '-o', 'json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const s = JSON.parse(raw.slice(raw.indexOf('{')));
assert.match(s.API_URL, /^http:\/\/127\.0\.0\.1:/);

process.env.NEXT_PUBLIC_SUPABASE_URL = s.API_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = s.PUBLISHABLE_KEY;
process.env.SUPABASE_SECRET_KEY = s.SECRET_KEY;

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(s.API_URL, s.SECRET_KEY, options);
const users = [];
let clinic;

async function createTestOwner() {
  const email = `owner-${crypto.randomUUID()}@example.invalid`;
  const password = 'Local_Test_Owner_123456';
  const r = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(r.error);
  users.push(r.data.user.id);
  const db = createClient(s.API_URL, s.PUBLISHABLE_KEY, options);
  const login = await db.auth.signInWithPassword({ email, password });
  assert.ifError(login.error);
  return { id: r.data.user.id, email, token: login.data.session.access_token, db };
}

try {
  console.log('1. Criando proprietário e clínica de teste...');
  const owner = await createTestOwner();
  const created = await owner.db.rpc('create_clinic', { clinic_name: 'Clínica Fluxo Convites' });
  assert.ifError(created.error);
  clinic = created.data;

  console.log('2. Enviando convite para novo integrante da equipe...');
  const invitedEmail = `convidado-${Date.now()}@example.com`;
  const inviteReq = new Request('http://127.0.0.1:3000/api/team?action=invite', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'X-Clinic-Id': clinic,
      'X-Team-Action': '1',
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:3000',
    },
    body: JSON.stringify({
      email: invitedEmail,
      role: 'doctor',
      origin: 'http://127.0.0.1:3000',
    }),
  });

  const inviteRes = await team(inviteReq);
  assert.equal(inviteRes.status, 201);
  const inviteData = await inviteRes.json();
  assert.equal(inviteData.invitationSent, true);
  users.push(inviteData.member.user_id);

  console.log('3. Verificando lista de equipe: integrante deve ter pendingFirstAccess = true...');
  const listReq = new Request('http://127.0.0.1:3000/api/team', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'X-Clinic-Id': clinic,
    },
  });
  const listRes = await team(listReq);
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  const memberEntry = listData.members.find((m) => m.email === invitedEmail);
  assert.ok(memberEntry, 'Convidado deve constar na lista da equipe');
  assert.equal(memberEntry.pendingFirstAccess, true, 'Deve indicar primeiro acesso pendente');

  console.log('4. Verificando e-mail de convite recebido no Mailpit...');
  await new Promise((r) => setTimeout(r, 600));
  const mailRes = await fetch('http://127.0.0.1:54324/api/v1/messages').then((r) => r.json());
  const emailMsg = mailRes.messages.find((m) => m.To.some((t) => t.Address === invitedEmail));
  assert.ok(emailMsg, 'E-mail deve ser capturado pelo Mailpit local');

  const msgContent = await fetch(`http://127.0.0.1:54324/api/v1/message/${emailMsg.ID}`).then((r) => r.json());
  const verifyLinkMatch = (msgContent.HTML || msgContent.Text).match(/href="([^"]+)"/);
  assert.ok(verifyLinkMatch, 'Link de confirmação deve estar presente no corpo do e-mail');
  const verifyUrl = verifyLinkMatch[1].replace(/&amp;/g, '&');

  console.log('5. Clicando no link do e-mail (resolução do token e redirecionamento da Supabase)...');
  const verifyRes = await fetch(verifyUrl, { redirect: 'manual' });
  assert.equal(verifyRes.status, 303, 'Supabase deve emitir 303 See Other');
  const location = verifyRes.headers.get('location');
  assert.ok(location, 'Header Location de redirecionamento deve existir');
  assert.ok(location.includes('first_access=true'), 'Redirecionamento deve apontar para first_access=true');
  assert.ok(location.includes('type=invite'), 'Hash deve conter type=invite');

  // Extrair access_token e refresh_token da URL de retorno
  const hashPart = location.split('#')[1] || '';
  const hashParams = new URLSearchParams(hashPart);
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  assert.ok(accessToken, 'access_token deve estar presente no hash');

  console.log('6. Primeiro acesso na aplicação: definindo a nova senha...');
  const memberClient = createClient(s.API_URL, s.PUBLISHABLE_KEY, options);
  const sessionRes = await memberClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  assert.ifError(sessionRes.error);
  assert.equal(sessionRes.data.user.email, invitedEmail);
  assert.equal(sessionRes.data.user.user_metadata.must_set_password, true);

  const newDoctorPassword = 'NovaSenhaDoutor2026!';
  const updateRes = await memberClient.auth.updateUser({
    password: newDoctorPassword,
    data: { must_set_password: false, password_set: true },
  });
  assert.ifError(updateRes.error);
  assert.equal(updateRes.data.user.user_metadata.must_set_password, false);
  assert.equal(updateRes.data.user.user_metadata.password_set, true);

  console.log('7. Conectando com a nova senha criada (login feito)...');
  const loginClient = createClient(s.API_URL, s.PUBLISHABLE_KEY, options);
  const loginRes = await loginClient.auth.signInWithPassword({
    email: invitedEmail,
    password: newDoctorPassword,
  });
  assert.ifError(loginRes.error);
  assert.equal(loginRes.data.user.id, memberEntry.user_id);

  console.log('8. Verificando que na lista de equipe o status de primeiro acesso não está mais pendente...');
  const listRes2 = await team(listReq);
  const listData2 = await listRes2.json();
  const updatedMember = listData2.members.find((m) => m.email === invitedEmail);
  assert.equal(updatedMember.pendingFirstAccess, false, 'Primeiro acesso deve estar concluído');

  console.log('SUCESSO: Fluxo de convite, verificação por e-mail, primeiro acesso com senha e login verificado!');
} finally {
  if (clinic) {
    for (const table of ['audit_events', 'clinic_members', 'clinics']) {
      assert.ifError(
        (
          await admin
            .from(table)
            .delete()
            .eq(table === 'clinics' ? 'id' : 'clinic_id', clinic)
        ).error,
      );
    }
  }
  for (const id of users) {
    assert.ifError((await admin.auth.admin.deleteUser(id)).error);
  }
}
