import { body, check, handle, HttpError, json, writeGuard } from './server.ts';
export const backupStatus = handle(async (request, { db, clinic, role }) => {
  if (role !== 'owner')
    throw new HttpError(
      403,
      'O acompanhamento de backups é exclusivo do titular.',
    );
  if (request.method === 'GET') {
    const results = await Promise.all(
      ['verified', 'external_copy'].map((kind) =>
        db
          .from('clinic_backup_events')
          .select(
            'id,kind,source,backup_at,occurred_at,verification_seconds,verified_event_id',
          )
          .eq('clinic_id', clinic)
          .eq('kind', kind)
          .order('backup_at', { ascending: false })
          .order('occurred_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    );
    if (
      results.some(
        (r) => r.error && ['42P01', 'PGRST205'].includes(r.error.code),
      )
    )
      return json({ available: false, verified: null, external: null });
    return json({
      available: true,
      verified: check(results[0]),
      external: check(results[1]),
    });
  }
  writeGuard(request, 'X-Backup-Action');
  const d = await body(request);
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    typeof d.id !== 'string' ||
    !uuid.test(d.id) ||
    typeof d.verified_event_id !== 'string' ||
    !uuid.test(d.verified_event_id) ||
    typeof d.copied_at !== 'string' ||
    d.copied_at.length > 40 ||
    !Number.isFinite(Date.parse(d.copied_at))
  )
    throw new HttpError(
      422,
      'Confira a identificação e a data da cópia externa.',
    );
  return json({
    event: check(await db.rpc('backup_external_copy_write', { c: clinic, d })),
  });
});
