-- Extend the existing transactional, audited patient snapshot.
alter function public.fhir_snapshot(uuid,text) rename to fhir_snapshot_before_exams;
revoke all on function public.fhir_snapshot_before_exams(uuid,text) from public,anon,authenticated;
create function public.fhir_snapshot(c uuid,p text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
 result:=public.fhir_snapshot_before_exams(c,p);
 result:=result || jsonb_build_object(
  'exam_results',coalesce((select jsonb_agg(x order by x.collected_on) from public.exam_results x where x.clinic_id=c and x.patient_id=p),'[]'::jsonb),
  'exam_definitions',coalesce((select jsonb_agg(x) from public.exam_definitions x where exists(select 1 from public.exam_results r where r.clinic_id=c and r.patient_id=p and r.definition_id=x.id)),'[]'::jsonb)
 );
 if octet_length(result::text)>2500000 then raise exception 'Prontuário acima do limite de exportação. Solicite uma exportação assistida.'; end if;
 return result;
end $$;
revoke all on function public.fhir_snapshot(uuid,text) from public,anon;
grant execute on function public.fhir_snapshot(uuid,text) to authenticated;
