// PostgreSQL REAL: somente o contêiner descartável abaixo; nunca lê .env.
// Cada execução cria/remove um banco sintético isolado, inclusive em caso de falha.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const containerName = 'psywrite-sncr-3a-disposable';
const inspect = JSON.parse(execFileSync('docker', ['inspect', containerName], {encoding:'utf8'}))[0];
assert.equal(inspect.HostConfig.NetworkMode, 'none');
assert.equal(inspect.Mounts.length, 0);
assert.equal(inspect.Config.Image, 'public.ecr.aws/supabase/postgres:17.6.1.167');
assert.equal(inspect.State.Running, true);
// Fixar o ID evita atingir outro contêiner se o nome for reutilizado durante o teste.
const container = inspect.Id;
const database = `sncr_3a_test_${randomUUID().replaceAll('-','')}`;
const clinic='10000000-0000-0000-0000-000000000001';
const doctor='20000000-0000-0000-0000-000000000001';
const other='20000000-0000-0000-0000-000000000002';
const request='30000000-0000-0000-0000-000000000001';
const doc = n => `md5('doc-${n}')::uuid`;
const key = n => `md5('key-${n}')::uuid`;
const args = (db=database) => ['exec','-i',container,'psql','-X','-U','supabase_admin','-d',db,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-qAt'];
function sql(s, {role='postgres',db=database}={}) {
  return execFileSync('docker',args(db),{input:`set role ${role}; set statement_timeout='15s'; ${s}`,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:25000}).trim();
}
function sqlAsync(s, {role='postgres'}={}) {
  return new Promise((resolve,reject) => {
    const p=spawn('docker',args()); let out='',err='';
    const timer=setTimeout(()=>{p.kill();reject(Error('Tempo limite do teste PostgreSQL'));},25000);
    p.stdout.on('data',x=>out+=x); p.stderr.on('data',x=>err+=x);
    p.on('error',reject); p.on('close',code=>{clearTimeout(timer);code ? reject(Error(err)) : resolve(out.trim());});
    p.stdin.end(`set role ${role}; set statement_timeout='15s'; ${s}`);
  });
}
function fails(statement, code, opts) {
  assert.throws(()=>sql(statement,opts), e=>String(e.stderr||e.message).includes(code));
}
const reserve = (n, opts={}) => `select public.sncr_reserve_number('${opts.clinic||clinic}','${opts.doctor||doctor}',${doc(n)},${opts.version??1},'${opts.env||'hmg'}','${opts.modality||'controle_especial'}',${key(opts.key??n)})->>'number';`;
const rpc = s => sql(s,{role:'service_role'});
const cursor = () => sql(`select next_suffix from sncr_batches where request_id='${request}';`);
function requestSql(id,{origin='anvisa_api',state='completed',env='hmg',prescriber=doctor,modality='controle_especial'}={}) {
 return `insert into sncr_requests(id,clinic_id,prescriber_id,environment,modality,request_key,origin,state) values (md5('${id}')::uuid,'${clinic}','${prescriber}','${env}','${modality}',md5('request-${id}')::uuid,'${origin}','${state}');`;
}
function batchSql(id,{prefix='TEST.',first=1,last=1000,origin='anvisa_api',verification='verified',env='hmg',prescriber=doctor,modality='controle_especial',councilNumber='12345',snapshot='CRM 12345 SP'}={}) {
 return `insert into sncr_batches(request_id,clinic_id,prescriber_id,environment,modality,council,council_number,council_uf,registration_snapshot,number_prefix,suffix_width,first_suffix,last_suffix,next_suffix,origin,verification_state) values (md5('${id}')::uuid,'${clinic}','${prescriber}','${env}','${modality}','CRM','${councilNumber}','SP','${snapshot}','${prefix}',7,${first},${last},${first},'${origin}','${verification}');`;
}
const migration = readFileSync(new URL('../supabase/migrations/20261027010000_sncr_numbering.sql',import.meta.url),'utf8');
const guard="do $$ begin\n raise exception 'Migração SNCR em revisão: não aplicar';\nend $$;";
assert.equal(migration.split(guard).length,2,'Proteção da migração ausente ou ambígua');

// Fixture das relações clínicas necessárias, com vínculos/NOT NULL/chaves do projeto.
// Não substitui um ensaio de todas as migrações históricas do Supabase.
const bootstrap=`
create schema auth;
grant usage on schema public to service_role,authenticated,anon;
create table auth.users(id uuid primary key);
create table public.clinics(id uuid primary key);
create type public.clinic_role as enum ('owner','doctor','secretary');
create table public.clinic_members(clinic_id uuid not null references clinics,user_id uuid not null references auth.users,role clinic_role not null,primary key(clinic_id,user_id));
create table public.document_profiles(clinic_id uuid not null references clinics,user_id uuid not null references auth.users,physician_registration text not null,primary key(clinic_id,user_id));
create table public.clinical_documents(id uuid primary key,clinic_id uuid not null references clinics,author_id uuid not null references auth.users,kind text not null,status text not null,physician_registration text not null,version integer not null,text text not null);
create table public.audit_events(id bigint generated always as identity primary key,clinic_id uuid not null references clinics,actor_id uuid not null references auth.users,action text not null check(length(action) between 2 and 80),entity_type text not null,entity_id text not null,context jsonb not null);
insert into auth.users values ('${doctor}'),('${other}');
insert into clinics values ('${clinic}');
insert into clinic_members values ('${clinic}','${doctor}','doctor'),('${clinic}','${other}','doctor');
insert into document_profiles values ('${clinic}','${doctor}','CRM 12345 SP'),('${clinic}','${other}','CRM 23456 SP');
insert into clinical_documents select md5('doc-'||n)::uuid,'${clinic}','${doctor}','Receita','DRAFT','CRM 12345 SP',1,'Via de administração: Uso oral' from generate_series(1,1100) n;
`;
let created=false;
try {
 sql(`create database ${database} owner postgres template template0;`,{db:'postgres',role:'supabase_admin'}); created=true;
 sql(bootstrap);
 const signatureTable=readFileSync(new URL('../supabase/migrations/20260925010000_digital_signatures.sql',import.meta.url),'utf8').match(/create table if not exists public\.digital_signatures \([\s\S]*?\n\);/)[0];
 sql(signatureTable);
 // O arquivo original deve falhar antes de criar qualquer tabela SNCR.
 fails(migration,'P0001');
 assert.equal(sql("select to_regclass('public.sncr_requests') is null;"),'t');
 sql(`begin; ${migration.replace(guard,'-- cópia temporária de teste; original permanece bloqueado')} commit;`);
 sql(`insert into sncr_requests(id,clinic_id,prescriber_id,environment,modality,request_key,origin,state) values ('${request}','${clinic}','${doctor}','hmg','controle_especial',gen_random_uuid(),'anvisa_api','completed');
 insert into sncr_batches(request_id,clinic_id,prescriber_id,environment,modality,council,council_number,council_uf,registration_snapshot,number_prefix,suffix_width,first_suffix,last_suffix,next_suffix,origin,verification_state) values ('${request}','${clinic}','${doctor}','hmg','controle_especial','CRM','12345','SP','CRM 12345 SP','TEST.',7,1,1000,1,'anvisa_api','verified');`);

 await test('duas conexões independentes reservam números distintos', async () => {
  const r=await Promise.all([sqlAsync(reserve(1),{role:'service_role'}),sqlAsync(reserve(2),{role:'service_role'})]);
  assert.equal(new Set(r).size,2); assert.deepEqual(r.sort(),['TEST.0000001','TEST.0000002']);
 });
 await test('dez conexões independentes disputam o mesmo lote sem perdas', async () => {
  const r=await Promise.all(Array.from({length:10},(_,i)=>sqlAsync(reserve(i+3),{role:'service_role'})));
  assert.equal(new Set(r).size,10); assert.equal(cursor(),'13');
 });
 await test('dez repetições simultâneas da mesma operação consomem somente um número', async () => {
  const r=await Promise.all(Array.from({length:10},()=>sqlAsync(reserve(13),{role:'service_role'})));
  assert.equal(new Set(r).size,1); assert.equal(cursor(),'14');
 });
 await test('replay mantém reserva, cursor e histórico', () => {
  const before=sql('select count(*) from sncr_operation_history;'); const original=rpc(reserve(1));
  assert.equal(rpc(reserve(1)),original); assert.equal(cursor(),'14'); assert.equal(sql('select count(*) from sncr_operation_history;'),before);
 });
 await test('mesma chave com documento, ambiente ou versão divergentes é recusada', () => {
  fails(reserve(14,{key:1}),'23505',{role:'service_role'});
  fails(reserve(1,{env:'prd'}),'23505',{role:'service_role'});
  fails(reserve(1,{version:2}),'40001',{role:'service_role'});
  assert.equal(cursor(),'14');
 });
 await test('duas sessões com mesma chave e documentos distintos têm somente um vencedor', async () => {
  const r=await Promise.allSettled([sqlAsync(reserve(14,{key:14}),{role:'service_role'}),sqlAsync(reserve(15,{key:14}),{role:'service_role'})]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1); assert.equal(r.filter(x=>x.status==='rejected').length,1); assert.equal(cursor(),'15');
 });
 await test('reinicialização real do PostgreSQL preserva reserva e cursor', async () => {
  const before=rpc(reserve(1)), stock=cursor();
  execFileSync('docker',['restart',container],{stdio:'pipe',timeout:25000});
  let ready=false;
  for(let i=0;i<30;i++){ try { if(sql('select 1;')==='1'){ready=true;break;} } catch {} await new Promise(r=>setTimeout(r,250)); }
  assert.equal(ready,true); assert.equal(rpc(reserve(1)),before); assert.equal(cursor(),stock);
 });
 await test('rollback e erro após reservar revertem cursor, reserva, histórico e auditoria', () => {
  const before=sql('select (select next_suffix from sncr_batches where number_prefix=\'TEST.\')||\':\'||(select count(*) from sncr_reservations)||\':\'||(select count(*) from sncr_operation_history)||\':\'||(select count(*) from audit_events);');
  sql(`begin; ${reserve(16)} rollback;`);
  fails(`begin; ${reserve(16)} select 1/0; commit;`,'22012');
  const after=sql('select (select next_suffix from sncr_batches where number_prefix=\'TEST.\')||\':\'||(select count(*) from sncr_reservations)||\':\'||(select count(*) from sncr_operation_history)||\':\'||(select count(*) from audit_events);');
  assert.equal(after,before);
 });
 await test('timeout depois de reservar, antes do COMMIT, reverte toda a transação', () => {
  const before=cursor(); fails(`set statement_timeout='100ms'; begin; ${reserve(16)} select pg_sleep(1); commit;`,'57014'); assert.equal(cursor(),before);
  assert.equal(sql(`select count(*) from sncr_reservations where document_id=${doc(16)};`),'0');
 });
 await test('número confirmado com resposta perdida é recuperado pela chave sem novo consumo', () => {
  rpc(reserve(16)); const before=cursor(); const replay=rpc(reserve(16)); assert.ok(replay.startsWith('TEST.')); assert.equal(cursor(),before);
 });
 await test('documento já vinculado não recebe segunda reserva', () => { fails(reserve(1,{key:9999}),'23505',{role:'service_role'}); });
 await test('outro médico e inscrição divergente não usam o lote', () => {
  fails(reserve(17,{doctor:other}),'42501',{role:'service_role'});
  sql(`update clinical_documents set author_id='${other}',physician_registration='CRM 23456 SP' where id=${doc(1010)};`);
  fails(reserve(1010,{doctor:other}),'P0001',{role:'service_role'});
  sql(`update clinical_documents set physician_registration='CRM 99999 SP' where id=${doc(17)};`);
  fails(reserve(17),'42501',{role:'service_role'});
  sql(`update clinical_documents set physician_registration='CRM 12345 SP' where id=${doc(17)};`);
 });
 await test('modalidade é obtida do documento e não aceita substituição por parâmetro', () => {
  fails(reserve(17,{modality:'notificacao_b'}),'42501',{role:'service_role'});
  sql(`update clinical_documents set text=E'Modalidade: Notificação de Receita B\nVia de administração: Uso oral' where id=${doc(1011)};`);
  fails(reserve(1011),'42501',{role:'service_role'});
  fails(reserve(1011,{modality:'notificacao_b'}),'P0001',{role:'service_role'});
 });
 await test('ambientes separados: mesma representação numérica em estoques independentes', () => {
  fails(reserve(17,{env:'prd'}),'P0001',{role:'service_role'});
  sql(requestSql('prd',{env:'prd'})+batchSql('prd',{env:'prd',last:1}));
  assert.equal(rpc(reserve(1012,{env:'prd'})),'TEST.0000001');
  assert.equal(sql("select count(*) from sncr_reservations where number='TEST.0000001';"),'2');
 });
 await test('faixas sobrepostas concorrentes: restrição de banco admite somente uma', async () => {
  sql(requestSql('overlap1')+requestSql('overlap2'));
  const r=await Promise.allSettled([sqlAsync(`begin; ${batchSql('overlap1',{prefix:'OVERLAP.',first:1,last:10})} select pg_sleep(0.15); commit;`),sqlAsync(batchSql('overlap2',{prefix:'OVERLAP.',first:5,last:15}))]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
  assert.match(String(r.find(x=>x.status==='rejected')?.reason),/23P01/);
 });
 await test('sobreposição também é recusada com snapshot REPEATABLE READ', async () => {
  sql(requestSql('repeat1')+requestSql('repeat2'));
  const r=await Promise.allSettled([sqlAsync(`begin isolation level repeatable read; select count(*) from sncr_batches; select pg_sleep(0.1); ${batchSql('repeat1',{prefix:'REPEAT.',first:1,last:10})} commit;`),sqlAsync(`begin; ${batchSql('repeat2',{prefix:'REPEAT.',first:5,last:15})} select pg_sleep(0.2); commit;`)]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1); assert.match(String(r.find(x=>x.status==='rejected')?.reason),/23P01/);
 });
 await test('lotes manuais e históricos ficam em quarentena e nunca são selecionados', () => {
  for(const origin of ['manual','legacy']) {
   sql(requestSql(origin,{origin,state:'quarantined',prescriber:other})+batchSql(origin,{prefix:`${origin}.`,origin,verification:'quarantined',prescriber:other,councilNumber:'23456',snapshot:'CRM 23456 SP'}));
   fails(`update sncr_batches set verification_state='verified' where origin='${origin}';`,'23514');
  }
  fails(reserve(1010,{doctor:other}),'P0001',{role:'service_role'});
 });
 await test('requisição pendente ou incerta não disponibiliza números e não pode voltar para pending', () => {
  sql(requestSql('unknown',{state:'uncertain',prescriber:other})+batchSql('unknown',{prefix:'UNKNOWN.',prescriber:other,councilNumber:'23456',snapshot:'CRM 23456 SP'}));
  fails(reserve(1010,{doctor:other}),'P0001',{role:'service_role'});
  fails("update sncr_requests set state='pending' where id=md5('unknown')::uuid;",'23514');
 });
 await test('reserva incerta não retorna ao estoque nem pode ser apagada', () => {
  const number=rpc(reserve(17)),before=cursor();
  sql(`update sncr_reservations set state='uncertain',state_reason='resultado sintético desconhecido' where document_id=${doc(17)};`);
  fails(reserve(17),'23505',{role:'service_role'}); assert.equal(cursor(),before);
  fails(`update sncr_reservations set state='reserved',state_reason='reuso' where document_id=${doc(17)};`,'23514');
  fails(`delete from sncr_reservations where document_id=${doc(17)};`,'23514');
  assert.equal(sql(`select number from sncr_reservations where document_id=${doc(17)};`),number);
 });
 await test('constraints recusam cursor sem reserva, retrocesso, reatribuição e falsificação direta', () => {
  fails("update sncr_batches set next_suffix=next_suffix+1 where number_prefix='TEST.';",'23514');
  fails("update sncr_batches set next_suffix=next_suffix-1 where number_prefix='TEST.';",'23514');
  fails(`update sncr_reservations set prescriber_id='${other}' where document_id=${doc(1)};`,'23514');
  fails("update sncr_batches set council_number='99999' where number_prefix='TEST.';",'23514');
  fails(`insert into sncr_reservations(batch_id,clinic_id,prescriber_id,document_id,document_version,environment,modality,request_key,number) select id,'${clinic}','${doctor}',${doc(18)},1,'hmg','controle_especial',${key(18)},'FORGED.0000001' from sncr_batches where number_prefix='TEST.' and environment='hmg';`,'23514');
 });
 await test('RLS e privilégios restringem os clientes e a escrita direta do backend', () => {
  for(const role of ['anon','authenticated']) {
   for(const table of ['sncr_requests','sncr_batches','sncr_reservations','sncr_operation_history']) {
    fails(`select * from ${table};`,'42501',{role});
    assert.equal(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass;`),'t');
   }
   fails(reserve(18),'42501',{role});
  }
  fails("update sncr_batches set next_suffix=next_suffix+1;",'42501',{role:'service_role'});
  fails("delete from sncr_reservations;",'42501',{role:'service_role'});
 });
 await test('histórico é imutável e registra a transição para incerto', () => {
  assert.equal(sql("select count(*) from sncr_operation_history where action='reservation_uncertain';"),'1');
  fails("delete from sncr_operation_history;",'23514');
 });
 await test('mil números: uma única faixa, estoque completo, sem lacunas e sem duplicação', () => {
  // As reservas anteriores (inclusive incertas) continuam consumidas; reservar apenas documentos ainda livres.
  sql(`do $$ declare n int; begin for n in 1..1000 loop
   if not exists(select 1 from sncr_reservations where document_id=md5('doc-'||n)::uuid) then
    perform public.sncr_reserve_number('${clinic}','${doctor}',md5('doc-'||n)::uuid,1,'hmg','controle_especial',md5('final-'||n)::uuid);
   end if;
  end loop; end $$;`);
  assert.equal(cursor(),'1001');
  assert.equal(sql("select count(*) from sncr_batches where number_prefix='TEST.' and environment='hmg';"),'1');
  assert.equal(sql("select count(*),count(distinct number) from sncr_reservations where environment='hmg' and number like 'TEST.%';"),'1000|1000');
  assert.equal(sql("select count(*) from generate_series(1,1000) n where not exists(select 1 from sncr_reservations where environment='hmg' and number='TEST.'||lpad(n::text,7,'0'));"),'0');
  fails(reserve(18,{key:88888}),'23505',{role:'service_role'});
 });
} finally {
 if(created) sql(`drop database ${database} with (force);`,{db:'postgres',role:'supabase_admin'});
}
