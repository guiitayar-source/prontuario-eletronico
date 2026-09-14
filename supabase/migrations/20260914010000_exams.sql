-- Immutable catalog definitions and append-only results. Extraction adapters must
-- submit reviewed data through the same validation; no model is connected here.
create table public.exam_definitions (
 id uuid primary key default gen_random_uuid(), clinic_id uuid references public.clinics(id),
 name text not null check(length(btrim(name)) between 1 and 160),
 aliases jsonb not null default '[]' check(jsonb_typeof(aliases)='array' and jsonb_array_length(aliases)<=30),
 fields jsonb not null check(jsonb_typeof(fields)='array' and jsonb_array_length(fields) between 1 and 50),
 author_id uuid references auth.users(id), created_at timestamptz not null default now()
);
create unique index exam_definition_names on public.exam_definitions(coalesce(clinic_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(btrim(name)));
create table public.exam_results (
 id uuid primary key, clinic_id uuid not null references public.clinics(id), patient_id text not null,
 definition_id uuid not null references public.exam_definitions(id), collected_on date not null,
 laboratory text not null default '' check(length(laboratory)<=500), method text not null default '' check(length(method)<=500),
 specimen text not null default '' check(length(specimen)<=500), values jsonb not null check(jsonb_typeof(values)='object' and values<>'{}'),
 notes text not null default '' check(length(notes)<=4000), attachment_id text references public.attachments(id),
 supersedes_id uuid unique references public.exam_results(id), correction_reason text not null default '' check(length(correction_reason)<=500),
 source text not null default 'manual' check(source='manual'), provenance jsonb not null default '{}' check(provenance='{}'::jsonb),
 author_id uuid not null references auth.users(id), created_at timestamptz not null default now(),
 foreign key(clinic_id,patient_id) references public.patients(clinic_id,id),
 check(supersedes_id is null or length(btrim(correction_reason))>0)
);
create index exam_results_patient on public.exam_results(clinic_id,patient_id,collected_on desc);
alter table public.exam_definitions enable row level security;
alter table public.exam_results enable row level security;
revoke all on public.exam_definitions,public.exam_results from anon,authenticated;
grant select on public.exam_definitions,public.exam_results to authenticated;
create policy exam_definitions_read on public.exam_definitions for select to authenticated using (
 (clinic_id is null and exists(select 1 from public.clinic_members m where m.user_id=auth.uid() and public.has_clinic_role(m.clinic_id,array['owner','doctor']::public.clinic_role[])))
 or public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));
create policy exam_results_read on public.exam_results for select to authenticated using(public.has_clinic_role(clinic_id,array['owner','doctor']::public.clinic_role[]));

create function public.exam_write(c uuid, action text, d jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; def public.exam_definitions; f jsonb; v jsonb; k text; old public.exam_results; seen text[]:='{}';
begin
 if not public.has_clinic_role(c,array['owner','doctor']::public.clinic_role[]) then raise insufficient_privilege; end if;
 if action='definition' then
  if jsonb_typeof(d->'fields') is distinct from 'array' or jsonb_array_length(d->'fields') not between 1 and 50
    or jsonb_typeof(d->'aliases') is distinct from 'array' or jsonb_array_length(d->'aliases')>30 then raise exception 'Modelo inválido.'; end if;
  for f in select value from jsonb_array_elements(d->'aliases') loop
   if jsonb_typeof(f)<>'string' or length(f#>>'{}')>100 then raise exception 'Sinônimo inválido.'; end if;
  end loop;
  for f in select value from jsonb_array_elements(d->'fields') loop
   if coalesce(f->>'id','') !~ '^[a-z0-9_-]{1,64}$' or f->>'id'=any(seen)
     or coalesce(length(btrim(f->>'name')),0) not between 1 and 120
     or coalesce(f->>'type','') not in ('number','text','choice')
     or jsonb_typeof(f->'unit') is distinct from 'string' or length(f->>'unit')>40 then raise exception 'Parâmetro inválido.'; end if;
   seen:=array_append(seen,f->>'id');
   if f->>'type'='choice' then
    if jsonb_typeof(f->'options') is distinct from 'array' or jsonb_array_length(f->'options') not between 1 and 30 then raise exception 'Opções inválidas.'; end if;
    for v in select value from jsonb_array_elements(f->'options') loop
     if jsonb_typeof(v)<>'string' or length(btrim(v#>>'{}')) not between 1 and 100 then raise exception 'Opção inválida.'; end if;
    end loop;
   end if;
  end loop;
  if exists(select 1 from public.exam_definitions where (clinic_id is null or clinic_id=c) and lower(btrim(name))=lower(btrim(d->>'name'))) then raise exception 'Já existe um exame com esse nome na biblioteca.'; end if;
  insert into public.exam_definitions(id,clinic_id,name,aliases,fields,author_id)
  values((d->>'id')::uuid,c,btrim(d->>'name'),d->'aliases',d->'fields',auth.uid()) returning to_jsonb(exam_definitions.*) into result;
 elsif action='result' then
  perform 1 from public.patients where clinic_id=c and id=d->>'patient_id' for update;
  if not found then raise exception 'Paciente não encontrado.'; end if;
  select * into def from public.exam_definitions where id=(d->>'definition_id')::uuid and (clinic_id is null or clinic_id=c);
  if not found then raise exception 'Exame não encontrado.'; end if;
  if coalesce(d->>'collected_on','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Data inválida.'; end if;
  if jsonb_typeof(d->'values') is distinct from 'object' or d->'values'='{}' then raise exception 'Informe um resultado.'; end if;
  for k,v in select * from jsonb_each(d->'values') loop
   select value into f from jsonb_array_elements(def.fields) where value->>'id'=k;
   if not found then raise exception 'Parâmetro desconhecido.'; end if;
   if jsonb_typeof(v->'value') is distinct from 'string' or coalesce(length(btrim(v->>'value')),0) not between 1 and 2000
    or jsonb_typeof(v->'unit') is distinct from 'string' or length(v->>'unit')>40
    or jsonb_typeof(v->'reference') is distinct from 'string' or length(v->>'reference')>500 then raise exception 'Valor inválido.'; end if;
   if f->>'type'='number' and btrim(v->>'value') !~ '^(<=|>=|<|>|≤|≥)?\s*[+-]?[0-9]+([.,][0-9]+)?$' then raise exception 'Número inválido.'; end if;
   if f->>'type'='choice' and not (f->'options' ? (v->>'value')) then raise exception 'Opção inválida.'; end if;
  end loop;
  if nullif(d->>'attachment_id','') is not null then
   perform 1 from public.attachments where id=d->>'attachment_id' and clinic_id=c and patient_id=d->>'patient_id' and archived_at is null;
   if not found then raise exception 'Anexo não pertence a este paciente.'; end if;
  end if;
  if nullif(d->>'supersedes_id','') is not null then
   select * into old from public.exam_results where id=(d->>'supersedes_id')::uuid and clinic_id=c and patient_id=d->>'patient_id' for update;
   if not found or old.definition_id<>def.id then raise exception 'Resultado original inválido.'; end if;
   if exists(select 1 from public.exam_results where supersedes_id=old.id) then raise exception 'Resultado já corrigido. Recarregue o histórico.'; end if;
  end if;
  insert into public.exam_results(id,clinic_id,patient_id,definition_id,collected_on,laboratory,method,specimen,values,notes,attachment_id,supersedes_id,correction_reason,author_id)
  values((d->>'id')::uuid,c,d->>'patient_id',def.id,(d->>'collected_on')::date,coalesce(d->>'laboratory',''),coalesce(d->>'method',''),coalesce(d->>'specimen',''),d->'values',coalesce(d->>'notes',''),nullif(d->>'attachment_id',''),old.id,coalesce(d->>'correction_reason',''),auth.uid())
  returning to_jsonb(exam_results.*) into result;
 else raise exception 'Operação inválida.'; end if;
 return result;
end $$;
revoke all on function public.exam_write(uuid,text,jsonb) from public,anon;
grant execute on function public.exam_write(uuid,text,jsonb) to authenticated;
create trigger exams_audit after insert on public.exam_results for each row execute function public.record_change();
create trigger exam_definitions_audit after insert on public.exam_definitions for each row execute function public.record_change();
