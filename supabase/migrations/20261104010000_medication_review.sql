-- Revisão explícita: uma lista vazia não significa que o paciente nega uso.
create table public.patient_medication_states (
 clinic_id uuid not null references public.clinics(id), id text not null,
 author_id uuid not null references auth.users(id),
 state text not null check (state in ('unknown','none','known')),
 reviewed_at timestamptz, version integer not null default 1 check(version > 0),
 updated_at timestamptz not null default now(),
 primary key(clinic_id,id), foreign key(clinic_id,id) references public.patients(clinic_id,id)
);
alter table public.patient_medication_states enable row level security;
revoke all on public.patient_medication_states from anon,authenticated;
grant select on public.patient_medication_states to authenticated;
create policy medication_states_medical_read on public.patient_medication_states for select to authenticated
 using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));

create function public.medication_review_write(c uuid,d jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; previous_version integer; active_medications boolean;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
 if (d->>'state') is null or (d->>'state') not in ('unknown','none','known') or (d->>'version') is null then raise exception 'Revisão inválida.'; end if;
 perform 1 from public.patients where clinic_id=c and id=d->>'patient_id' for update;
 if not found then raise exception 'Paciente não encontrado.'; end if;
 select version into previous_version from public.patient_medication_states where clinic_id=c and id=d->>'patient_id' for update;
 if coalesce(previous_version,0) <> (d->>'version')::integer then raise exception 'Revisão alterada em outra janela. Recarregue os dados.'; end if;
 select exists(select 1 from public.patient_medications where clinic_id=c and patient_id=d->>'patient_id' and status='active') into active_medications;
 if d->>'state'='none' and active_medications then raise exception 'Revise e suspenda os medicamentos ativos antes de registrar que o paciente nega uso.'; end if;
 if d->>'state'='known' and not active_medications then raise exception 'Cadastre os medicamentos em uso antes de confirmar a revisão.'; end if;
 insert into public.patient_medication_states(clinic_id,id,author_id,state,reviewed_at)
 values(c,d->>'patient_id',auth.uid(),d->>'state',case when d->>'state'<>'unknown' then now() end)
 on conflict(clinic_id,id) do update set state=excluded.state,author_id=auth.uid(),
 reviewed_at=case when excluded.state='unknown' then patient_medication_states.reviewed_at else excluded.reviewed_at end,
 version=patient_medication_states.version+1,updated_at=now()
 returning to_jsonb(patient_medication_states.*) into result;
 return result;
end $$;
revoke all on function public.medication_review_write(uuid,jsonb) from public,anon;
grant execute on function public.medication_review_write(uuid,jsonb) to authenticated;

-- Alterações da lista invalidam a confirmação anterior, preservando sua data histórica.
create function public.invalidate_medication_review() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.patient_medication_states set state='unknown',version=version+1,updated_at=now()
 where clinic_id=coalesce(new.clinic_id,old.clinic_id) and id=coalesce(new.patient_id,old.patient_id);
 return coalesce(new,old);
end $$;
revoke all on function public.invalidate_medication_review() from public;
create trigger medication_review_invalidated after insert or update or delete on public.patient_medications
 for each row execute function public.invalidate_medication_review();
create trigger medication_states_audit after insert or update on public.patient_medication_states
 for each row execute function public.record_change();
