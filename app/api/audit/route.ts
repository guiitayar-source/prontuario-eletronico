import { check, handle, HttpError, json } from '@/lib/supabase/server';
export const dynamic = 'force-dynamic';
export const GET = handle(async (_request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role))
    throw new HttpError(403, 'Auditoria restrita a médicos.');
  return json({
    events: check(
      await ctx.db
        .from('audit_events')
        .select('id,actor_id,action,entity_type,entity_id,occurred_at')
        .eq('clinic_id', ctx.clinic)
        .order('id', { ascending: false })
        .limit(100),
    ),
  });
});
