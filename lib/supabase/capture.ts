import { fileType, MAX_FILE } from '../capture.ts';
import { body, check, handle, HttpError, json, writeGuard } from './server.ts';
import { patient } from './patients.ts';
import { adminClient } from './admin.ts';

function normalize(result: Record<string, any>) {
  if (result.request?.expires_at) result.request.expires_at = Date.parse(result.request.expires_at);
  return result;
}
export const capture = handle(async (request, ctx) => {
  const url = new URL(request.url), action = url.searchParams.get('action') || '';
  const bucket = ctx.db.storage.from('clinical-files');
  const command = async (a: string, d: Record<string, unknown>) => check(await ctx.db.rpc('capture_command', {
    c: ctx.clinic, action: a, d, device_token: request.headers.get('x-device-token'),
  }));
  if (request.method === 'GET') {
    if (action === 'list') {
      await patient(ctx, url.searchParams.get('patientId'));
      const rows = check(await ctx.db.from('attachments').select('id,request_id,name,mime,size,category,created_at').eq('clinic_id', ctx.clinic)
        .eq('patient_id', url.searchParams.get('patientId')!).order('created_at').order('id'));
      return json({ attachments: rows.map(r => ({ ...r, created_at: Date.parse(r.created_at) })) });
    }
    if (action === 'file') {
      const record = await command('file', { id: url.searchParams.get('id'), patientId: url.searchParams.get('patientId') });
      const signed = check(await bucket.createSignedUrl(record.storage_path, 60));
      return json({ url: signed.signedUrl, mime: record.mime, name: record.name });
    }
    if (action === 'pair' || action === 'mobile') return json(normalize(await command(action, { id: url.searchParams.get('id') })));
    throw new HttpError(404, 'Ação não encontrada.');
  }
  writeGuard(request, 'x-capture-action');
  const d = await body(request);
  if (action === 'prepare') {
    if (typeof d.name !== 'string' || typeof d.mime !== 'string' || !Number.isSafeInteger(d.size) || Number(d.size) < 1 || Number(d.size) > MAX_FILE) throw new HttpError(422, 'Selecione um arquivo de até 12 MB.');
    d.name = d.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0,160) || 'anexo';
    return json(await command(action,d));
  }
  if (action === 'commit') {
    const lease = await command('prepare',d);
    if (lease.alreadyReceived) return json(lease);
    if (lease.path !== d.path) throw new HttpError(409, 'Envio expirado. Tente novamente.');
    const download = await bucket.download(lease.path);
    if (download.error || !download.data) throw new HttpError(409, 'Arquivo ainda não recebido. Tente novamente.');
    const blob = download.data;
    if (blob.size !== Number(lease.size) || blob.size > MAX_FILE || fileType(new Uint8Array(await blob.slice(0,12).arrayBuffer())) !== lease.mime) {
      check(await bucket.remove([lease.path]));
      await command('abort', d);
      throw new HttpError(415, 'Conteúdo inválido. Use JPG, PNG, WebP ou PDF.');
    }
    return json(check(await adminClient().rpc('commit_verified_upload', { c: ctx.clinic, d, actor: ctx.user, device_token: request.headers.get('x-device-token') })),201);
  }
  if (action === 'delete') {
    const record = await command('file',d);
    check(await bucket.remove([record.storage_path]));
    await command('delete',d);
    return json({ ok:true });
  }
  if (['connect','request','disconnect','complete','classify'].includes(action)) return json(normalize(await command(action,d)));
  throw new HttpError(404,'Ação não encontrada.');
});
