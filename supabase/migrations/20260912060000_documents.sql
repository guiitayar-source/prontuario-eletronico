create table public.document_profiles (
 clinic_id uuid not null references public.clinics(id),user_id uuid not null references auth.users(id),
 physician_name text not null,physician_registration text not null,primary key(clinic_id,user_id)
);
alter table public.document_profiles enable row level security;
revoke all on public.document_profiles from anon,authenticated;
grant select on public.document_profiles to authenticated;
create policy own_document_profile on public.document_profiles for select to authenticated using(user_id=auth.uid() and public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create table public.clinical_documents (
 id uuid primary key,
 clinic_id uuid not null references public.clinics(id),
 patient_id text not null,
 consultation_id uuid references public.consultations(id),
 author_id uuid not null references auth.users(id),
 kind text not null check(kind in ('Declaração de comparecimento','Atestado','Relatório','Receita','Pedido de exames','Documento livre')),
 patient_name text not null check(char_length(patient_name) between 1 and 180),
 physician_name text not null default '' check(char_length(physician_name)<=180),
 physician_registration text not null default '' check(char_length(physician_registration)<=120),
 document_date date not null,
 text text not null check(char_length(text)<=100000),
 version integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(clinic_id,patient_id) references public.patients(clinic_id,id)
);
create index documents_patient on public.clinical_documents(clinic_id,patient_id,updated_at desc);
alter table public.clinical_documents enable row level security;
revoke all on public.clinical_documents from anon,authenticated;
grant select on public.clinical_documents to authenticated;
create policy medical_documents on public.clinical_documents for select to authenticated using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create function public.document_write(c uuid,d jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.clinical_documents; pname text; cid uuid;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
 select coalesce(nullif(social_name,''),name) into pname from public.patients where clinic_id=c and id=d->>'patient_id' for update;
 if not found then raise exception 'Paciente não encontrado.'; end if;
 cid:=nullif(d->>'consultation_id','')::uuid;
 if cid is not null and not exists(select 1 from public.consultations where id=cid and clinic_id=c and patient_id=d->>'patient_id') then raise exception 'Consulta não pertence a este paciente.'; end if;
 select * into r from public.clinical_documents where id=(d->>'id')::uuid for update;
 if found then
  if r.clinic_id<>c or r.patient_id<>d->>'patient_id' or r.author_id<>auth.uid() then raise insufficient_privilege; end if;
  if (d->>'version')::integer is distinct from r.version then
   if (d->>'version')::integer=0 and r.kind=d->>'kind' and r.text=d->>'text' and r.physician_name=d->>'physician_name' and r.physician_registration=d->>'physician_registration' and r.document_date=(d->>'document_date')::date and r.consultation_id is not distinct from cid then return to_jsonb(r); end if;
   raise exception 'Documento alterado em outra sessão. Reabra-o antes de salvar.';
  end if;
  update public.clinical_documents set kind=d->>'kind',text=d->>'text',physician_name=d->>'physician_name',physician_registration=d->>'physician_registration',document_date=(d->>'document_date')::date,consultation_id=cid,version=version+1,updated_at=now() where id=r.id returning * into r;
 else
  if (d->>'version')::integer is distinct from 0 then raise exception 'Documento não encontrado.'; end if;
  insert into public.clinical_documents(id,clinic_id,patient_id,consultation_id,author_id,kind,patient_name,physician_name,physician_registration,document_date,text) values((d->>'id')::uuid,c,d->>'patient_id',cid,auth.uid(),d->>'kind',pname,d->>'physician_name',d->>'physician_registration',(d->>'document_date')::date,d->>'text') returning * into r;
 end if;
 return to_jsonb(r);
end $$;
revoke all on function public.document_write(uuid,jsonb) from public,anon;
grant execute on function public.document_write(uuid,jsonb) to authenticated;
create trigger documents_audit after insert or update on public.clinical_documents for each row execute function public.record_change();
