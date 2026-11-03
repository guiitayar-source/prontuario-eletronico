-- Modelos próprios para todos os tipos de documento (antes só receitas).
-- Os modelos existentes ficam como 'Receita'. O nome passa a ser único por tipo.
alter table public.prescription_templates
  add column if not exists kind text not null default 'Receita'
  check(kind in ('Declaração de comparecimento','Atestado','Relatório','Receita','Pedido de exames','Encaminhamento','Documento livre'));

drop index if exists public.prescription_templates_name;
create unique index prescription_templates_name
  on public.prescription_templates(clinic_id,user_id,kind,lower(btrim(name)));

create or replace function public.prescription_template_write(c uuid,action text,d jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.prescription_templates; row_id uuid; k text;
begin
 if auth.uid() is null or not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then
   raise insufficient_privilege;
 end if;
 row_id:=(d->>'id')::uuid;
 if action='delete' then
   delete from public.prescription_templates
    where id=row_id and clinic_id=c and user_id=auth.uid()
    returning * into r;
   if not found then raise exception 'Modelo não encontrado.'; end if;
   return to_jsonb(r);
 end if;
 if action<>'save' then raise exception 'Operação inválida.'; end if;
 k:=coalesce(nullif(d->>'kind',''),'Receita');
 if exists(
   select 1 from public.prescription_templates
    where clinic_id=c and user_id=auth.uid() and kind=k
      and lower(btrim(name))=lower(btrim(d->>'name')) and id<>row_id
 ) then
   raise exception 'Já existe um modelo com esse nome para este tipo de documento.';
 end if;
 select * into r from public.prescription_templates where id=row_id for update;
 if found then
   if r.clinic_id<>c or r.user_id<>auth.uid() then raise insufficient_privilege; end if;
   update public.prescription_templates
      set name=btrim(d->>'name'),text=d->>'text',kind=k,updated_at=now()
    where id=row_id returning * into r;
 else
   insert into public.prescription_templates(id,clinic_id,user_id,kind,name,text)
   values(row_id,c,auth.uid(),k,btrim(d->>'name'),d->>'text')
   returning * into r;
 end if;
 return to_jsonb(r);
end $$;

revoke all on function public.prescription_template_write(uuid,text,jsonb) from public,anon;
grant execute on function public.prescription_template_write(uuid,text,jsonb) to authenticated;
