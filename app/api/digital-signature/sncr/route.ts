import {
  handle,
  HttpError,
  json,
  writeGuard,
  body,
} from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import {
  prescriptionModalities,
  type PrescriptionModality,
} from '@/lib/document-fields';
import {
  getSncrEnvironment,
  isSncrConfigured,
  sncrService,
} from '@/lib/sncr/client';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(403, 'Acesso restrito a profissionais médicos.');
  }

  const admin = adminClient();
  const batches = await sncrService.listBatches(admin, ctx.clinic);

  return json({
    configured: isSncrConfigured(),
    env: getSncrEnvironment(),
    batches,
  });
});

export const POST = handle(async (request, ctx) => {
  writeGuard(request, 'x-signature-action');

  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos podem gerenciar lotes ou solicitar numeração no SNCR da Anvisa.'
    );
  }

  const admin = adminClient();
  const payload = await body(request);
  const action =
    typeof payload.action === 'string' ? payload.action : 'allocate';

  if (action === 'register-batch') {
    const modality = (
      typeof payload.modality === 'string' && payload.modality
        ? payload.modality
        : 'controle_especial'
    ) as PrescriptionModality;
    if (!prescriptionModalities.some((m) => m.id === modality)) {
      throw new HttpError(422, 'Modalidade de receita inválida.');
    }

    const batch = await sncrService.registerBatch({
      db: admin,
      clinicId: ctx.clinic,
      userId: ctx.user,
      modality,
      label: typeof payload.label === 'string' ? payload.label : '',
      inicio: typeof payload.inicio === 'string' ? payload.inicio : '',
      fim: typeof payload.fim === 'string' ? payload.fim : '',
      rawList: typeof payload.rawList === 'string' ? payload.rawList : '',
    });

    const batches = await sncrService.listBatches(admin, ctx.clinic);
    return json({ batch, batches });
  }

  if (action === 'delete-batch') {
    const batchId =
      typeof payload.batchId === 'string' ? payload.batchId.trim() : '';
    await sncrService.deleteBatch({
      db: admin,
      clinicId: ctx.clinic,
      userId: ctx.user,
      batchId,
    });
    const batches = await sncrService.listBatches(admin, ctx.clinic);
    return json({ batches });
  }

  const modality = (
    typeof payload.modality === 'string' && payload.modality
      ? payload.modality
      : 'controle_especial'
  ) as PrescriptionModality;
  const physicianRegistration =
    typeof payload.physicianRegistration === 'string'
      ? payload.physicianRegistration.trim()
      : '';

  if (!prescriptionModalities.some((m) => m.id === modality)) {
    throw new HttpError(422, 'Modalidade de receita inválida.');
  }

  const allocation = await sncrService.allocateForPrescription({
    db: admin,
    clinicId: ctx.clinic,
    modality,
    physicianRegistration,
  });

  await admin.from('audit_events').insert({
    clinic_id: ctx.clinic,
    actor_id: ctx.user,
    action: 'sncr.number_allocated',
    entity_type: 'sncr_numbering',
    entity_id: allocation.number,
    context: {
      modality,
      physician_registration: physicianRegistration,
      source: allocation.source,
      remaining_in_pool: allocation.remainingInPool,
      saldo_receitas: allocation.saldoReceitas ?? null,
    },
  });

  const batches = await sncrService.listBatches(admin, ctx.clinic);

  return json({
    ...allocation,
    batches,
  });
});
