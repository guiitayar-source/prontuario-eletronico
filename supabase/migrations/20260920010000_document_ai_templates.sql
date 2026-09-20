create table public.document_ai_templates (
 id uuid primary key,
 clinic_id uuid not null references public.clinics(id),
 user_id uuid not null references auth.users(id),
 kind text not null check(kind in ('Declaração de comparecimento','Atestado','Relatório','Receita','Pedido de exames','Documento livre')),
 name text not null check(char_length(btrim(name)) between 1 and 80),
 instructions text not null check(char_length(btrim(instructions)) between 1 and 12000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(clinic_id,user_id,kind,name)
);

create index document_ai_templates_owner
 on public.document_ai_templates(clinic_id,user_id,kind,updated_at desc);

alter table public.document_ai_templates enable row level security;
revoke all on public.document_ai_templates from anon,authenticated;
grant select on public.document_ai_templates to authenticated;

create policy own_document_ai_templates on public.document_ai_templates
 for select to authenticated
 using(
   user_id=auth.uid()
   and public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[])
 );

create function public.document_ai_template_write(c uuid,action text,d jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.document_ai_templates; row_id uuid;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then
   raise insufficient_privilege;
 end if;
 row_id:=(d->>'id')::uuid;
 if action='delete' then
   delete from public.document_ai_templates
    where id=row_id and clinic_id=c and user_id=auth.uid()
    returning * into r;
   if not found then raise exception 'Modelo de instruções não encontrado.'; end if;
   return to_jsonb(r);
 end if;
 if action<>'save' then raise exception 'Operação inválida.'; end if;
 if exists(
   select 1 from public.document_ai_templates
    where clinic_id=c and user_id=auth.uid() and kind=d->>'kind'
      and lower(btrim(name))=lower(btrim(d->>'name')) and id<>row_id
 ) then
   raise exception 'Já existe um modelo com esse nome para este tipo de documento.';
 end if;
 select * into r from public.document_ai_templates
  where id=row_id for update;
 if found then
   if r.clinic_id<>c or r.user_id<>auth.uid() then raise insufficient_privilege; end if;
   update public.document_ai_templates
      set kind=d->>'kind',name=btrim(d->>'name'),instructions=btrim(d->>'instructions'),updated_at=now()
    where id=row_id returning * into r;
 else
   insert into public.document_ai_templates(id,clinic_id,user_id,kind,name,instructions)
   values(row_id,c,auth.uid(),d->>'kind',btrim(d->>'name'),btrim(d->>'instructions'))
   returning * into r;
 end if;
 return to_jsonb(r);
end $$;

revoke all on function public.document_ai_template_write(uuid,text,jsonb) from public,anon;
grant execute on function public.document_ai_template_write(uuid,text,jsonb) to authenticated;
create trigger document_ai_templates_audit
 after insert or update or delete on public.document_ai_templates
 for each row execute function public.record_change();
