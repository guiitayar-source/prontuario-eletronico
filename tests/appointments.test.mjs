import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { patientsHandler } from '../lib/patients.ts';
import { appointmentsHandler } from '../lib/appointments.ts';

function setup() {
  const f = fixture();
  const patientApi = patientsHandler(f.db);
  const appointmentApi = appointmentsHandler(f.db);
  const call = (api, path, body, user = 'doctor-a') =>
    api(
      new Request(`https://demo.test/api/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(user ? { 'oai-authenticated-user-id': user } : {}),
          ...(body
            ? {
                'Content-Type': 'application/json',
                'X-Appointment-Action': '1',
              }
            : {}),
          origin: 'https://demo.test',
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  return { ...f, call, patientApi, appointmentApi };
}

async function patient(f, name) {
  const id = crypto.randomUUID();
  const response = await f.patientApi(
    new Request('https://demo.test/api/patients?action=create', {
      method: 'POST',
      headers: {
        'oai-authenticated-user-id': 'doctor-a',
        'Content-Type': 'application/json',
        'X-Patient-Action': '1',
        origin: 'https://demo.test',
      },
      body: JSON.stringify({ id, name }),
    }),
  );
  assert.equal(response.status, 201);
  return (await response.json()).patient;
}

test('creates, lists, updates and cancels a patient-linked appointment', async () => {
  const f = setup();
  const p = await patient(f, 'Paciente Fictício Agenda');
  const id = crypto.randomUUID();
  const starts = new Date('2026-09-15T09:00:00').getTime();
  const create = await f.call(f.appointmentApi, 'appointments?action=create', {
    id,
    patient_id: p.id,
    starts_at: starts,
    ends_at: starts + 50 * 60_000,
    modality: 'presencial',
    admin_notes: 'Retorno fictício',
  });
  assert.equal(create.status, 201);
  const created = (await create.json()).appointment;
  const listed = await f.call(f.appointmentApi, 'appointments?day=2026-09-15');
  assert.equal((await listed.json()).appointments[0].patient_id, p.id);
  const update = await f.call(f.appointmentApi, 'appointments?action=update', {
    ...created,
    patient_id: p.id,
    starts_at: starts + 60 * 60_000,
    ends_at: starts + 110 * 60_000,
    modality: 'teleconsulta',
    admin_notes: '',
  });
  assert.equal(update.status, 200);
  const changed = (await update.json()).appointment;
  const cancel = await f.call(f.appointmentApi, 'appointments?action=cancel', {
    id,
    version: changed.version,
  });
  assert.equal(cancel.status, 200);
  assert.equal(
    (
      await (
        await f.call(f.appointmentApi, 'appointments?day=2026-09-15')
      ).json()
    ).appointments[0].status,
    'cancelled',
  );
});

test('rejects invalid patient, duration and stale changes', async () => {
  const f = setup();
  const starts = new Date('2026-09-15T09:00:00').getTime();
  assert.equal(
    (
      await f.call(f.appointmentApi, 'appointments?action=create', {
        id: crypto.randomUUID(),
        patient_id: crypto.randomUUID(),
        starts_at: starts,
        ends_at: starts + 50 * 60_000,
        modality: 'presencial',
      })
    ).status,
    404,
  );
  const p = await patient(f, 'Paciente Fictício Validação');
  assert.equal(
    (
      await f.call(f.appointmentApi, 'appointments?action=create', {
        id: crypto.randomUUID(),
        patient_id: p.id,
        starts_at: starts,
        ends_at: starts + 5 * 60_000,
        modality: 'presencial',
      })
    ).status,
    422,
  );
  const id = crypto.randomUUID();
  const created = await f.call(f.appointmentApi, 'appointments?action=create', {
    id,
    patient_id: p.id,
    starts_at: starts,
    ends_at: starts + 50 * 60_000,
    modality: 'presencial',
  });
  const item = (await created.json()).appointment;
  assert.equal(
    (
      await f.call(f.appointmentApi, 'appointments?action=cancel', {
        id,
        version: item.version - 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.call(f.appointmentApi, 'appointments?day=2026-99-99')).status,
    400,
  );
});
