import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { team } from '../lib/supabase/team.ts';
const raw = execFileSync(
  'node_modules/.bin/supabase',
  ['status', '-o', 'json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
);
const s = JSON.parse(raw.slice(raw.indexOf('{')));
assert.match(s.API_URL, /^http:\/\/127\.0\.0\.1:/);
process.env.NEXT_PUBLIC_SUPABASE_URL = s.API_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = s.PUBLISHABLE_KEY;
process.env.SUPABASE_SECRET_KEY = s.SECRET_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } },
  admin = createClient(s.API_URL, s.SECRET_KEY, options),
  users = [];
let clinic;
async function user() {
  const email = `team-${crypto.randomUUID()}@example.invalid`,
    password = 'Local_Test_123456789';
  const r = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(r.error);
  users.push(r.data.user.id);
  const db = createClient(s.API_URL, s.PUBLISHABLE_KEY, options);
  const login = await db.auth.signInWithPassword({ email, password });
  assert.ifError(login.error);
  return { id: r.data.user.id, email, token: login.data.session.access_token };
}
async function call(u, action, data) {
  const r = await team(
    new Request(
      'http://test.local/api/team' + (action ? '?action=' + action : ''),
      {
        method: action ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${u.token}`,
          'X-Clinic-Id': clinic,
          'X-Team-Action': '1',
          Origin: 'http://test.local',
        },
        body: data ? JSON.stringify(data) : undefined,
      },
    ),
  );
  return { status: r.status, data: await r.json() };
}
try {
  const owner = await user(),
    existing = await user(),
    doctor = await user();
  const c = await createClient(
    s.API_URL,
    s.PUBLISHABLE_KEY,
    options,
  ).auth.signInWithPassword({
    email: owner.email,
    password: 'Local_Test_123456789',
  });
  assert.ifError(c.error);
  const ownerDb = createClient(s.API_URL, s.PUBLISHABLE_KEY, {
    ...options,
    global: { headers: { Authorization: `Bearer ${owner.token}` } },
  });
  const created = await ownerDb.rpc('create_clinic', {
    clinic_name: 'Equipe sintética',
  });
  assert.ifError(created.error);
  clinic = created.data;
  let r = await call(owner);
  assert.equal(r.status, 200);
  assert.equal(r.data.members.length, 1);
  assert.equal(r.data.members[0].email, owner.email);
  r = await call(owner, 'invite', { email: existing.email, role: 'secretary' });
  assert.equal(r.status, 201);
  assert.equal(r.data.invitationSent, false);
  assert.equal((await call(existing)).status, 403);
  r = await call(owner, 'role', { user_id: existing.id, role: 'doctor' });
  assert.equal(r.status, 200);
  assert.equal(
    (
      await admin
        .from('clinic_members')
        .select('role')
        .eq('clinic_id', clinic)
        .eq('user_id', existing.id)
        .single()
    ).data.role,
    'doctor',
  );
  r = await call(owner, 'revoke', { user_id: existing.id });
  assert.equal(r.status, 200);
  assert.equal(
    (
      await admin
        .from('clinic_members')
        .select('*')
        .eq('clinic_id', clinic)
        .eq('user_id', existing.id)
    ).data.length,
    0,
  );
  assert.equal(
    (await call(owner, 'invite', { email: doctor.email, role: 'doctor' }))
      .status,
    201,
  );
  const resendRes = await call(owner, 'resend_invite', { user_id: doctor.id });
  assert.equal(resendRes.status, 200);
  assert.equal(resendRes.data.ok, true);
  assert.equal(resendRes.data.email, doctor.email);
  assert.equal(
    (await call(owner, 'resend_invite', { user_id: owner.id })).status,
    403,
  );
  assert.equal(
    (await call(owner, 'revoke', { user_id: owner.id })).status,
    403,
  );
  const audits = await admin
    .from('audit_events')
    .select('action')
    .eq('clinic_id', clinic)
    .eq('entity_type', 'clinic_member');
  assert.ifError(audits.error);
  assert.deepEqual(audits.data.map((x) => x.action).sort(), [
    'invite',
    'invite',
    'invite',
    'revoke',
    'role_update',
  ]);
  console.log(
    'PASS: lista, convite, reenvio de convite, permissão do proprietário, mudança de papel, revogação e auditoria.',
  );
} finally {
  if (clinic)
    for (const table of ['audit_events', 'clinic_members', 'clinics'])
      assert.ifError(
        (
          await admin
            .from(table)
            .delete()
            .eq(table === 'clinics' ? 'id' : 'clinic_id', clinic)
        ).error,
      );
  for (const id of users)
    assert.ifError((await admin.auth.admin.deleteUser(id)).error);
}
