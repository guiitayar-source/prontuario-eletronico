-- Modelos de receita por profissional e dados fixos do timbre por usuário.

create table public.prescription_templates (
 id uuid primary key,
 clinic_id uuid not null references public.clinics(id),
 user_id uuid not null references auth.users(id),
 name text not null check(char_length(btrim(name)) between 1 and 80),
 text text not null check(char_length(btrim(text)) between 1 and 20000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create unique index prescription_templates_name
 on public.prescription_templates(clinic_id,user_id,lower(btrim(name)));

alter table public.prescription_templates enable row level security;
revoke all on public.prescription_templates from anon,authenticated;
grant select on public.prescription_templates to authenticated;

create policy own_prescription_templates on public.prescription_templates
 for select to authenticated
 using(
   user_id=auth.uid()
   and public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[])
 );

create function public.prescription_template_write(c uuid,action text,d jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.prescription_templates; row_id uuid;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then
   raise insufficient_privilege;
 end if;
 row_id:=(d->>'id')::uuid;
 if action='delete' then
   delete from public.prescription_templates
    where id=row_id and clinic_id=c and user_id=auth.uid()
    returning * into r;
   if not found then raise exception 'Modelo de receita não encontrado.'; end if;
   return to_jsonb(r);
 end if;
 if action<>'save' then raise exception 'Operação inválida.'; end if;
 if exists(
   select 1 from public.prescription_templates
    where clinic_id=c and user_id=auth.uid()
      and lower(btrim(name))=lower(btrim(d->>'name')) and id<>row_id
 ) then
   raise exception 'Já existe um modelo de receita com esse nome.';
 end if;
 select * into r from public.prescription_templates where id=row_id for update;
 if found then
   if r.clinic_id<>c or r.user_id<>auth.uid() then raise insufficient_privilege; end if;
   update public.prescription_templates
      set name=btrim(d->>'name'),text=d->>'text',updated_at=now()
    where id=row_id returning * into r;
 else
   insert into public.prescription_templates(id,clinic_id,user_id,name,text)
   values(row_id,c,auth.uid(),btrim(d->>'name'),d->>'text')
   returning * into r;
 end if;
 return to_jsonb(r);
end $$;

revoke all on function public.prescription_template_write(uuid,text,jsonb) from public,anon;
grant execute on function public.prescription_template_write(uuid,text,jsonb) to authenticated;
create trigger prescription_templates_audit
 after insert or update or delete on public.prescription_templates
 for each row execute function public.record_change();

-- Timbre do profissional: cada usuário mantém os próprios dados fixos.
alter table public.document_profiles
 add column if not exists letterhead_title text not null default '' check(char_length(letterhead_title)<=120),
 add column if not exists letterhead_address text not null default '' check(char_length(letterhead_address)<=200),
 add column if not exists letterhead_phone text not null default '' check(char_length(letterhead_phone)<=80),
 add column if not exists updated_at timestamptz not null default now();

-- O CPF é definido pelo certificado ICP-Brasil e não é alterado por aqui.
create function public.document_profile_write(c uuid,d jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.document_profiles;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then
   raise insufficient_privilege;
 end if;
 if char_length(coalesce(d->>'physician_name',''))>180
    or char_length(coalesce(d->>'physician_registration',''))>120
    or char_length(coalesce(d->>'letterhead_title',''))>120
    or char_length(coalesce(d->>'letterhead_address',''))>200
    or char_length(coalesce(d->>'letterhead_phone',''))>80 then
   raise exception 'Confira o tamanho dos campos.';
 end if;
 insert into public.document_profiles(
   clinic_id,user_id,physician_name,physician_registration,
   letterhead_title,letterhead_address,letterhead_phone,updated_at
 ) values (
   c,auth.uid(),btrim(coalesce(d->>'physician_name','')),btrim(coalesce(d->>'physician_registration','')),
   btrim(coalesce(d->>'letterhead_title','')),btrim(coalesce(d->>'letterhead_address','')),
   btrim(coalesce(d->>'letterhead_phone','')),now()
 )
 on conflict (clinic_id,user_id) do update set
   physician_name=excluded.physician_name,
   physician_registration=excluded.physician_registration,
   letterhead_title=excluded.letterhead_title,
   letterhead_address=excluded.letterhead_address,
   letterhead_phone=excluded.letterhead_phone,
   updated_at=now()
 returning * into r;
 insert into public.audit_events(clinic_id,actor_id,action,entity_type,entity_id)
 values(c,auth.uid(),'update','document_profiles',auth.uid()::text);
 return to_jsonb(r) - 'cpf';
end $$;

revoke all on function public.document_profile_write(uuid,jsonb) from public,anon;
grant execute on function public.document_profile_write(uuid,jsonb) to authenticated;
