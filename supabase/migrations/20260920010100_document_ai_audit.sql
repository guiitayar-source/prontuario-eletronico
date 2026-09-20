create function public.document_ai_request_audit(c uuid,p text,d jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then
   raise insufficient_privilege;
 end if;
 if not exists(select 1 from public.patients where clinic_id=c and id=p) then
   raise exception 'Paciente não encontrado.';
 end if;
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id,context)
 values(c,auth.uid(),'ai_document_request','patients',p,d);
end $$;

revoke all on function public.document_ai_request_audit(uuid,text,jsonb) from public,anon;
grant execute on function public.document_ai_request_audit(uuid,text,jsonb) to authenticated;
