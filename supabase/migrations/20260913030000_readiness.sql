-- MFA is enforced by existing RLS/RPC helpers, including direct PostgREST access.
alter table public.clinics add column require_mfa boolean not null default false;
create function public.session_is_strong(c uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select auth.role()='service_role' or (
   auth.uid() is not null and (
     auth.jwt()->>'aal'='aal2' or (
       not coalesce((select require_mfa from public.clinics where id=c),true)
       and not exists(select 1 from auth.mfa_factors where user_id=auth.uid() and status='verified')
     )
   )
 );
$$;
revoke all on function public.session_is_strong(uuid) from public;
grant execute on function public.session_is_strong(uuid) to authenticated;
create or replace function public.is_clinic_member(target_clinic_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.session_is_strong(target_clinic_id) and exists(
 select 1 from public.clinic_members where clinic_id=target_clinic_id and user_id=auth.uid());
$$;
create or replace function public.has_clinic_role(target_clinic_id uuid, allowed_roles public.clinic_role[])
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.session_is_strong(target_clinic_id) and exists(
 select 1 from public.clinic_members where clinic_id=target_clinic_id and user_id=auth.uid() and role=any(allowed_roles));
$$;
-- Own membership and clinic name/policy remain available to bootstrap the MFA screen.
drop policy clinic_members_read_members on public.clinic_members;
create policy clinic_members_read_members on public.clinic_members for select to authenticated
using(user_id=auth.uid() or public.is_clinic_member(clinic_id));
drop policy clinics_read_members on public.clinics;
create policy clinics_read_members on public.clinics for select to authenticated
using(exists(select 1 from public.clinic_members m where m.clinic_id=id and m.user_id=auth.uid()));
revoke update on public.clinics from authenticated;
grant update(name) on public.clinics to authenticated;
create function public.enable_clinic_mfa(c uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.jwt()->>'aal' is distinct from 'aal2' or not public.has_clinic_role(c,array['owner']::public.clinic_role[]) then
   raise insufficient_privilege using message='Ative e confirme seu autenticador antes de exigir MFA da equipe.';
 end if;
 update public.clinics set require_mfa=true where id=c;
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id)
 values(c,auth.uid(),'mfa_required','clinics',c::text);
end;
$$;
revoke all on function public.enable_clinic_mfa(uuid) from public;
grant execute on function public.enable_clinic_mfa(uuid) to authenticated;

-- Clinical attachments are retained. Only uncommitted upload leases may be deleted.
alter table public.attachments add column archived_at timestamptz;
alter table public.attachments add column archived_by uuid references auth.users(id);
create or replace function public.can_access_clinical_object(object_name text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.attachments a where a.storage_path=object_name and a.archived_at is null and public.is_clinic_member(a.clinic_id))
 or exists(select 1 from public.pending_uploads u where u.path=object_name and u.created_by=auth.uid() and u.expires_at>now() and public.is_clinic_member(u.clinic_id));
$$;
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
 if action in ('file','classify') and not exists(select 1 from public.attachments
   where clinic_id=c and id=d->>'id' and patient_id=d->>'patientId' and archived_at is null) then
   raise exception 'Anexo não encontrado ou arquivado.';
 end if;
 return public.capture_internal(c,action,d,device_token);
end;
$$;
drop policy clinical_files_delete_members on storage.objects;
create policy clinical_files_delete_pending on storage.objects for delete to authenticated
using(bucket_id='clinical-files' and public.can_upload_clinical_object(name)
 and not exists(select 1 from public.attachments a where a.storage_path=name));

-- A bounded clinical export snapshot runs in one database statement/transaction.
create function public.fhir_snapshot(c uuid, p text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
 select jsonb_build_object(
 'patient',to_jsonb(pat),
 'consultations',coalesce((select jsonb_agg(to_jsonb(v)||jsonb_build_object('addenda',coalesce((select jsonb_agg(a order by a.created_at) from public.consultation_addenda a where a.consultation_id=v.id),'[]'::jsonb)) order by v.created_at) from public.consultations v where v.clinic_id=c and v.patient_id=p),'[]'),
 'conditions',coalesce((select jsonb_agg(x order by created_at) from public.patient_conditions x where clinic_id=c and patient_id=p),'[]'),
 'medications',coalesce((select jsonb_agg(x order by created_at) from public.patient_medications x where clinic_id=c and patient_id=p),'[]'),
 'allergies',coalesce((select jsonb_agg(x order by created_at) from public.patient_allergies x where clinic_id=c and patient_id=p),'[]'),
 'allergy_state',(select state from public.patient_allergy_states where clinic_id=c and id=p),
 'documents',coalesce((select jsonb_agg(x order by created_at) from public.clinical_documents x where clinic_id=c and patient_id=p),'[]'),
 'attachments',coalesce((select jsonb_agg(x order by created_at) from public.attachments x where clinic_id=c and patient_id=p and archived_at is null),'[]'),
 'imports',coalesce((select jsonb_agg(x order by imported_at) from public.import_records x where clinic_id=c and patient_id=p and withdrawn_at is null),'[]')
 ) into result from public.patients pat where pat.clinic_id=c and pat.id=p;
 if result is null then raise exception 'Paciente não encontrado.'; end if;
 if octet_length(result::text)>2500000 then raise exception 'Prontuário acima do limite de exportação. Solicite uma exportação assistida.'; end if;
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id)
 values(c,auth.uid(),'export_snapshot','patients',p);
 return result;
end;
$$;
revoke all on function public.fhir_snapshot(uuid,text) from public;
grant execute on function public.fhir_snapshot(uuid,text) to authenticated;
