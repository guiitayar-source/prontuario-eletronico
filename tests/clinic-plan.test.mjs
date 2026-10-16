import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listClinicPlans,
  parseFeatures,
  setClinicPlan,
} from '../scripts/clinic-plan.mjs';

// Cliente falso: guarda o que seria gravado.
function fakeAdmin({ users = [], owned = [], clinics = [] } = {}) {
  const log = { upserts: [], audit: [] };
  const query = (table) => {
    const rows = table === 'clinics' ? clinics : owned;
    const q = Object.assign(Promise.resolve({ data: rows, error: null }), {
      select() {
        return q;
      },
      eq() {
        return q;
      },
      order() {
        return q;
      },
      upsert(row) {
        log.upserts.push(row);
        return Promise.resolve({ error: null });
      },
      insert(row) {
        log.audit.push(row);
        return Promise.resolve({ error: null });
      },
    });
    return q;
  };
  return {
    log,
    from: query,
    auth: {
      admin: { listUsers: async () => ({ data: { users }, error: null }) },
    },
  };
}

const owner = { id: 'u1', email: 'ana@exemplo.com' };

test('lê as funções do plano', () => {
  assert.deepEqual(parseFeatures(' Anamnesator, ia '), ['ia', 'anamnesator']);
  assert.deepEqual(parseFeatures('ia'), ['ia']);
  assert.deepEqual(parseFeatures('nenhuma'), []);
  assert.throws(() => parseFeatures(''), /separados por vírgula/);
  assert.throws(() => parseFeatures('ia,agenda'), /separados por vírgula/);
});

test('grava o plano da clínica do proprietário e registra na auditoria', async () => {
  const admin = fakeAdmin({ users: [owner], owned: [{ clinic_id: 'c1' }] });
  const r = await setClinicPlan(admin, {
    email: 'ANA@exemplo.com',
    features: ['ia'],
  });
  assert.deepEqual(r, { clinicId: 'c1', features: ['ia'] });
  assert.equal(admin.log.upserts[0].clinic_id, 'c1');
  assert.deepEqual(admin.log.upserts[0].features, ['ia']);
  assert.equal(admin.log.audit[0].action, 'clinic_plan_change');
  assert.deepEqual(admin.log.audit[0].context.features, ['ia']);
});

test('não altera nada sem uma única clínica do proprietário', async () => {
  for (const [users, owned, message] of [
    [[], [], /Nenhuma conta/],
    [[owner], [], /não é proprietária/],
    [
      [owner],
      [{ clinic_id: 'c1' }, { clinic_id: 'c2' }],
      /mais de uma clínica/,
    ],
  ]) {
    const admin = fakeAdmin({ users, owned });
    await assert.rejects(
      setClinicPlan(admin, { email: owner.email, features: [] }),
      message,
    );
    assert.equal(admin.log.upserts.length, 0);
  }
});

test('lista clínicas com proprietário, equipe e funções', async () => {
  const admin = fakeAdmin({
    users: [{ ...owner, last_sign_in_at: '2026-10-15T12:00:00Z' }],
    clinics: [
      {
        id: 'c1',
        name: 'Consultório Ana',
        created_at: '2026-10-01T00:00:00Z',
        clinic_features: { features: ['ia', 'anamnesator'] },
        clinic_members: [
          { user_id: 'u1', role: 'owner' },
          { user_id: 'u2', role: 'secretary' },
        ],
      },
      { id: 'c2', name: 'Nova', clinic_features: null, clinic_members: [] },
    ],
  });
  assert.deepEqual(await listClinicPlans(admin), [
    {
      id: 'c1',
      name: 'Consultório Ana',
      createdAt: '2026-10-01T00:00:00Z',
      owner: 'ana@exemplo.com',
      ownerLastSignIn: '2026-10-15T12:00:00Z',
      doctors: 1,
      secretaries: 1,
      features: ['ia', 'anamnesator'],
    },
    {
      id: 'c2',
      name: 'Nova',
      createdAt: null,
      owner: '(sem proprietário)',
      ownerLastSignIn: null,
      doctors: 0,
      secretaries: 0,
      features: [],
    },
  ]);
});
