alter function public.clinical_context_write(uuid,text,jsonb) rename to clinical_context_write_internal;
revoke all on function public.clinical_context_write_internal(uuid,text,jsonb) from public,anon,authenticated;
create function public.clinical_context_write(c uuid,entity text,d jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare row_id uuid;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege;end if;
 if entity<>'allergy_state' then
  row_id:=(d->>'id')::uuid;
  if (entity='condition' and exists(select 1 from public.patient_conditions where id=row_id and clinic_id<>c))
   or (entity='medication' and exists(select 1 from public.patient_medications where id=row_id and clinic_id<>c))
   or (entity='allergy' and exists(select 1 from public.patient_allergies where id=row_id and clinic_id<>c)) then raise insufficient_privilege;end if;
 end if;
 return public.clinical_context_write_internal(c,entity,d);
end $$;
revoke all on function public.clinical_context_write(uuid,text,jsonb) from public,anon;grant execute on function public.clinical_context_write(uuid,text,jsonb) to authenticated;
