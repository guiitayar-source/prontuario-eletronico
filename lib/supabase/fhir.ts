import { exportFHIR, type Snapshot } from '../fhir/export.ts';
import { body, check, handle, HttpError, writeGuard } from './server.ts';
export const fhir = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role))
    throw new HttpError(403, 'Exportação disponível somente para médicos.');
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const row = check(
      await ctx.db
        .from('attachments')
        .select('storage_path')
        .eq('clinic_id', ctx.clinic)
        .eq('patient_id', url.searchParams.get('patientId') || '')
        .eq('id', url.searchParams.get('attachment') || '')
        .is('archived_at', null)
        .maybeSingle(),
    );
    if (!row) throw new HttpError(404, 'Anexo não encontrado.');
    const signed = check(
      await ctx.db.storage
        .from('clinical-files')
        .createSignedUrl(row.storage_path, 60),
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: signed.signedUrl,
        'Cache-Control': 'private, no-store',
      },
    });
  }
  writeGuard(request, 'x-fhir-action');
  const d = await body(request);
  if (typeof d.patientId !== 'string' || d.patientId.length > 160)
    throw new HttpError(422, 'Selecione um paciente.');
  const snapshot = check(
    await ctx.db.rpc('fhir_snapshot', { c: ctx.clinic, p: d.patientId }),
  ) as Snapshot;
  const embedded = new Map<string, Buffer>();
  if (d.includeFiles === true) {
    if (
      snapshot.attachments.reduce((sum, a) => sum + Number(a.size), 0) > 2000000
    )
      throw new HttpError(
        413,
        'Os anexos ultrapassam 2 MB. Exporte com referências protegidas e baixe os arquivos separadamente.',
      );
    for (const a of snapshot.attachments) {
      const blob = check(
        await ctx.db.storage.from('clinical-files').download(a.storage_path),
      );
      if (blob.size !== Number(a.size))
        throw new HttpError(
          409,
          'Um anexo está inconsistente. Exportação interrompida.',
        );
      embedded.set(a.id, Buffer.from(await blob.arrayBuffer()));
    }
  }
  const serialized = JSON.stringify(
    exportFHIR(snapshot, url.origin, embedded),
    null,
    2,
  );
  if (Buffer.byteLength(serialized) > 3500000)
    throw new HttpError(
      413,
      'Exportação acima do limite. Desmarque a inclusão dos arquivos; se persistir, solicite exportação assistida.',
    );
  return new Response(serialized, {
    headers: {
      'Content-Type': 'application/fhir+json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="psywrite-fhir-r4.json"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
