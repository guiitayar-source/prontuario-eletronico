// Teto de chamadas pagas de IA por pessoa, contado nos eventos de auditoria que cada
// chamada já grava (sem tabela própria). Evita custo descontrolado por conta comprometida
// ou laço no cliente; não substitui o limite configurado na conta da OpenAI.
import { adminClient } from './admin.ts';
import { HttpError, type Context } from './server.ts';

export const AI_AUDIT_ACTIONS = ['ai_document_request', 'ai_file_request'];
const HOURLY_LIMIT = Number(process.env.PSYWRITE_AI_HOURLY_LIMIT) || 120;

export async function assertAiQuota({
  db,
  clinic,
  user,
}: Pick<Context, 'db' | 'clinic' | 'user'>) {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error } = await db
    .from('audit_events')
    .select('id', { count: 'exact', head: true })
    .eq('clinic_id', clinic)
    .eq('actor_id', user)
    .in('action', AI_AUDIT_ACTIONS)
    .gte('occurred_at', since);
  if (error) throw new HttpError(503, 'Não foi possível verificar o uso da IA.');
  if ((count ?? 0) >= HOURLY_LIMIT)
    throw new HttpError(
      429,
      'Limite de uso da IA nesta hora atingido. Tente novamente mais tarde.',
    );
}

// Leitura de arquivo por IA: registra quem enviou qual anexo, sem conteúdo clínico.
export async function auditAiFileRequest(
  { clinic, user }: Pick<Context, 'clinic' | 'user'>,
  patientId: string,
  context: Record<string, unknown>,
) {
  const inserted = await adminClient().from('audit_events').insert({
    clinic_id: clinic,
    actor_id: user,
    action: 'ai_file_request',
    entity_type: 'patients',
    entity_id: patientId,
    context,
  });
  if (inserted.error)
    throw new HttpError(503, 'Não foi possível registrar o uso da IA.');
}
