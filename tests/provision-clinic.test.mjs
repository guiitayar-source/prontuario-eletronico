import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs, provisionClinic } from '../scripts/provision-clinic.mjs';

// Cliente falso: guarda o que seria gravado e permite simular falhas.
function fakeAdmin({ users = [], owned = [], inviteError = false, memberError = false } = {}) {
  const log = { clinics: [], members: [], deleted: [], audit: [], invites: [] };
  const query = (table) => {
    // Promessa de verdade com os métodos encadeáveis do construtor de consultas.
    const q = Object.assign(Promise.resolve({ data: owned, error: null }), {
      select() { return q; },
      eq() { return q; },
      insert(row) {
        if (table === 'clinics') {
          log.clinics.push(row);
          return { select: () => ({ single: async () => ({ data: { id: 'c1' }, error: null }) }) };
        }
        if (table === 'clinic_members') {
          if (memberError) return Promise.resolve({ error: { message: 'x' } });
          log.members.push(row);
        }
        if (table === 'audit_events') log.audit.push(row);
        return Promise.resolve({ error: null });
      },
      delete() {
        return { eq: async (_k, v) => { log.deleted.push(v); return { error: null }; } };
      },
    });
    return q;
  };
  return {
    log,
    from: query,
    auth: {
      admin: {
        listUsers: async () => ({ data: { users }, error: null }),
        inviteUserByEmail: async (email, opts) => {
          log.invites.push({ email, opts });
          return inviteError
            ? { data: {}, error: { message: 'smtp' } }
            : { data: { user: { id: 'u-new', email } }, error: null };
        },
      },
    },
  };
}

const input = { email: 'ana@exemplo.com', clinicName: 'Consultório Ana', origin: 'https://app.test' };

test('valida argumentos', () => {
  assert.deepEqual(parseArgs([' Ana@Exemplo.com ', ' Consultório Ana ', 'https://app.test/x']), input);
  assert.throws(() => parseArgs(['ana', 'Consultório', 'https://app.test']), /e-mail/);
  assert.throws(() => parseArgs(['ana@exemplo.com', 'A', 'https://app.test']), /nome/);
  assert.throws(() => parseArgs(['ana@exemplo.com', 'Clínica', 'http://app.test']), /https/);
  assert.equal(parseArgs(['a@b.co', 'Clínica', 'http://127.0.0.1:3000']).origin, 'http://127.0.0.1:3000');
});

test('convida conta nova como proprietária da clínica criada', async () => {
  const admin = fakeAdmin();
  const r = await provisionClinic(admin, input);
  assert.deepEqual(r, { clinicId: 'c1', userId: 'u-new', invitationSent: true });
  assert.equal(admin.log.invites[0].opts.redirectTo, 'https://app.test/?first_access=true');
  assert.equal(admin.log.invites[0].opts.data.must_set_password, true);
  assert.deepEqual(admin.log.members, [{ clinic_id: 'c1', user_id: 'u-new', role: 'owner' }]);
  assert.equal(admin.log.audit[0].action, 'clinic_provision');
});

test('vincula conta existente sem reenviar convite', async () => {
  const admin = fakeAdmin({ users: [{ id: 'u1', email: 'ANA@exemplo.com' }] });
  const r = await provisionClinic(admin, input);
  assert.equal(r.invitationSent, false);
  assert.equal(admin.log.invites.length, 0);
  assert.equal(admin.log.members[0].user_id, 'u1');
});

test('recusa quem já é proprietário de outra clínica', async () => {
  const admin = fakeAdmin({ users: [{ id: 'u1', email: input.email }], owned: [{ clinic_id: 'c0' }] });
  await assert.rejects(provisionClinic(admin, input), /já é proprietária/);
  assert.equal(admin.log.clinics.length, 0);
});

test('desfaz a clínica se o convite ou o vínculo falhar', async () => {
  for (const opts of [{ inviteError: true }, { memberError: true }]) {
    const admin = fakeAdmin(opts);
    await assert.rejects(provisionClinic(admin, input));
    assert.deepEqual(admin.log.deleted, ['c1']);
    assert.equal(admin.log.audit.length, 0);
  }
});
