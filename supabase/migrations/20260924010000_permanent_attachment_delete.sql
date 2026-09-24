-- Allow permanent deletion of attachments to reclaim storage space:
-- 1. Owners (administrators) can permanently delete any attachment.
-- 2. Doctors can permanently delete exam photos once the exams referencing
--    the photo are already recorded in exam_results.
-- 3. Referential integrity: exam_results.attachment_id becomes null on delete.

alter table public.exam_results drop constraint if exists exam_results_attachment_id_fkey;
alter table public.exam_results
  add constraint exam_results_attachment_id_fkey
  foreign key (attachment_id) references public.attachments(id) on delete set null;

create or replace function public.capture_command(c uuid, action text, d jsonb default '{}', device_token text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.attachments;
begin
 if not public.is_clinic_member(c) then raise insufficient_privilege; end if;
 if action='commit' then raise insufficient_privilege using message='Validação do servidor necessária.'; end if;
 if action in ('delete','restore') then
   if not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
   update public.attachments set archived_at=case when action='delete' then now() else null end,
     archived_by=case when action='delete' then auth.uid() else null end
   where clinic_id=c and id=d->>'id' and patient_id=d->>'patientId' returning * into a;
   if not found then raise exception 'Anexo não encontrado.'; end if;
   return to_jsonb(a);
 end if;
 if action = 'purge' then
   if not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
   select * into a from public.attachments
     where clinic_id=c and id=d->>'id' and patient_id=d->>'patientId' for update;
   if not found then raise exception 'Anexo não encontrado.'; end if;
   if not public.has_clinic_role(c,array['owner']::public.clinic_role[]) then
     if not exists(
       select 1 from public.exam_results
       where clinic_id=c and patient_id=a.patient_id
         and (attachment_id=a.id or provenance->>'attachment_id'=a.id)
     ) then
       raise exception 'A exclusão definitiva pelo médico só é permitida após os exames desta foto estarem preenchidos no prontuário. Caso precise excluir antes, solicite ao administrador.';
     end if;
   end if;
   delete from public.attachments where id=a.id;
   return to_jsonb(a);
 end if;
 if action in ('file','classify') and not exists(select 1 from public.attachments
   where clinic_id=c and id=d->>'id' and patient_id=d->>'patientId' and archived_at is null) then
   raise exception 'Anexo não encontrado ou arquivado.';
 end if;
 return public.capture_internal(c,action,d,device_token);
end;
$$;

revoke all on function public.capture_command(uuid,text,jsonb,text) from public;
grant execute on function public.capture_command(uuid,text,jsonb,text) to authenticated;
