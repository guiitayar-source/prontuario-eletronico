-- Receitas podem ser salvas sem data; os demais documentos continuam exigindo-a.
alter table public.clinical_documents alter column document_date drop not null;
alter table public.clinical_documents add constraint clinical_documents_date_required
 check (kind = 'Receita' or document_date is not null);

create or replace function public.document_write(c uuid,d jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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
   if (d->>'version')::integer=0 and r.kind=d->>'kind' and r.text=d->>'text' and r.physician_name=d->>'physician_name' and r.physician_registration=d->>'physician_registration' and r.document_date is not distinct from nullif(d->>'document_date','')::date and r.consultation_id is not distinct from cid then return to_jsonb(r); end if;
   raise exception 'Documento alterado em outra sessão. Reabra-o antes de salvar.';
  end if;
  update public.clinical_documents set kind=d->>'kind',text=d->>'text',physician_name=d->>'physician_name',physician_registration=d->>'physician_registration',document_date=nullif(d->>'document_date','')::date,consultation_id=cid,version=version+1,updated_at=now() where id=r.id returning * into r;
 else
  if (d->>'version')::integer is distinct from 0 then raise exception 'Documento não encontrado.'; end if;
  insert into public.clinical_documents(id,clinic_id,patient_id,consultation_id,author_id,kind,patient_name,physician_name,physician_registration,document_date,text) values((d->>'id')::uuid,c,d->>'patient_id',cid,auth.uid(),d->>'kind',pname,d->>'physician_name',d->>'physician_registration',nullif(d->>'document_date','')::date,d->>'text') returning * into r;
 end if;
 return to_jsonb(r);
end $$;
