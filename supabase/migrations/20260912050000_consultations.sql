create table public.consultations (
 id uuid primary key,
 clinic_id uuid not null references public.clinics(id),
 patient_id text not null,
 appointment_id text,
 author_id uuid not null references auth.users(id),
 text text not null default '' check (char_length(text) <= 100000),
 version integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 finalized_at timestamptz,
 finalized_by uuid references auth.users(id),
 foreign key (clinic_id,patient_id) references public.patients(clinic_id,id),
 foreign key (clinic_id,appointment_id) references public.appointments(clinic_id,id)
);
create unique index consultation_appointment on public.consultations(clinic_id,appointment_id) where appointment_id is not null;
create index consultation_patient on public.consultations(clinic_id,patient_id,created_at desc);
create table public.consultation_addenda (
 id uuid primary key,
 consultation_id uuid not null references public.consultations(id),
 clinic_id uuid not null references public.clinics(id),
 author_id uuid not null references auth.users(id),
 text text not null check(char_length(btrim(text)) between 1 and 100000),
 created_at timestamptz not null default now()
);
alter table public.consultations enable row level security;
alter table public.consultation_addenda enable row level security;
revoke all on public.consultations, public.consultation_addenda from anon, authenticated;
grant select on public.consultations, public.consultation_addenda to authenticated;
create policy consultation_read on public.consultations for select to authenticated using (public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create policy addendum_read on public.consultation_addenda for select to authenticated using (public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create function public.consultation_write(c uuid, action text, d jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.consultations; a public.consultation_addenda; aid text; pid text;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
 if action='create' then
  aid := nullif(d->>'appointment_id',''); pid := d->>'patient_id';
  perform 1 from public.patients where clinic_id=c and id=pid for update;
  if not found then raise exception 'Paciente não encontrado.'; end if;
  if aid is not null then
   perform 1 from public.appointments where clinic_id=c and id=aid and patient_id=pid and status in ('scheduled','in_progress') for update;
   if not found then raise exception 'Agendamento indisponível.'; end if;
  end if;
  select * into r from public.consultations where clinic_id=c and (id=(d->>'id')::uuid or (aid is not null and appointment_id=aid));
  if found then
   if r.patient_id<>pid then raise exception 'Consulta de outro paciente.'; end if;
   return to_jsonb(r);
  end if;
  insert into public.consultations(id,clinic_id,patient_id,appointment_id,author_id) values((d->>'id')::uuid,c,pid,aid,auth.uid()) returning * into r;
  if aid is not null then update public.appointments set status='in_progress',version=version+1,updated_at=now() where clinic_id=c and id=aid; end if;
 else
  select * into r from public.consultations where clinic_id=c and id=(d->>'id')::uuid for update;
  if not found then raise exception 'Consulta não encontrada.'; end if;
  if action='addendum' then
   if r.finalized_at is null then raise exception 'Finalize a consulta antes de adicionar um adendo.'; end if;
   select * into a from public.consultation_addenda where id=(d->>'addendum_id')::uuid;
   if found then
    if a.consultation_id<>r.id or a.author_id<>auth.uid() or a.text<>d->>'text' then raise exception 'Identificador de adendo já utilizado.'; end if;
    return to_jsonb(r);
   end if;
   insert into public.consultation_addenda(id,consultation_id,clinic_id,author_id,text) values((d->>'addendum_id')::uuid,r.id,c,auth.uid(),d->>'text');
   return to_jsonb(r);
  end if;
  if action not in ('save','finalize') then raise exception 'Operação inválida.'; end if;
  if r.author_id<>auth.uid() then raise insufficient_privilege; end if;
  if r.finalized_at is not null then raise exception 'Consulta finalizada; registre um adendo.'; end if;
  if (d->>'version')::integer is distinct from r.version then raise exception 'Outra edição foi salva. Recarregue a consulta antes de continuar.'; end if;
  if action='finalize' and char_length(btrim(d->>'text'))=0 then raise exception 'Escreva a evolução antes de finalizar.'; end if;
  update public.consultations set text=d->>'text',version=version+1,updated_at=now(),finalized_at=case when action='finalize' then now() end,finalized_by=case when action='finalize' then auth.uid() end where id=r.id returning * into r;
  if action='finalize' and r.appointment_id is not null then update public.appointments set status='completed',version=version+1,updated_at=now() where clinic_id=c and id=r.appointment_id; end if;
 end if;
 return to_jsonb(r);
end $$;
revoke all on function public.consultation_write(uuid,text,jsonb) from public,anon;
grant execute on function public.consultation_write(uuid,text,jsonb) to authenticated;
create trigger consultation_audit after insert or update on public.consultations for each row execute function public.record_change();
create trigger addendum_audit after insert on public.consultation_addenda for each row execute function public.record_change();
