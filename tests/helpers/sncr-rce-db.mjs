import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { rceRepository } from '../../lib/sncr/rce-repository.ts';
import { rceSnapshotHash } from '../../lib/sncr/rce-workflow.ts';

export const syntheticSnapshot = () => ({
  schema: 1,
  patient: {
    name: 'PACIENTE FICTICIO - TESTE',
    identifier: 'Passaporte TESTE000',
    address: 'Rua de Teste, 10, Bairro Ficticio, Cidade Ficticia/SP',
  },
  prescriber: {
    name: 'PRESCRITOR FICTICIO',
    cpf: '52998224725',
    crm: '000001',
    uf: 'SP',
    address: 'Rua Ficticia, 20, Cidade de Teste/SP',
    phone: '(00) 00000-0000',
  },
  medicine: {
    name: 'MEDICAMENTO FICTICIO',
    concentration: '10 mg',
    pharmaceuticalForm: 'Comprimido de teste',
    quantity: '30 comprimidos - teste',
    dosage:
      'EXEMPLO FICTICIO. Usar conforme orientacao simulada. Nao utilizar este documento para tratamento.',
  },
  platform: 'PsyWrite - ambiente de teste',
});
export async function localRceDatabase(dataDir) {
  const db = new PGlite(dataDir);
  const clinic = 'aaaaaaaa-0000-4000-8000-000000000001',
    user = 'bbbbbbbb-0000-4000-8000-000000000001';
  const exists = (
    await db.query(
      "select to_regclass('public.sncr_rce_emissions') as table_name",
    )
  ).rows[0].table_name;
  if (!exists) {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select '${user}'::uuid $$;
    create type public.clinic_role as enum('owner','doctor','secretary');
    create table public.clinics(id uuid primary key);
    create table public.patients(clinic_id uuid,id text,name text,social_name text,primary key(clinic_id,id));
    create table public.consultations(id uuid primary key,clinic_id uuid,patient_id text);
    create function public.has_clinic_role(c uuid,roles public.clinic_role[]) returns boolean language sql as $$ select true $$;
    create function public.record_change() returns trigger language plpgsql as $$ begin return new;end $$;
    insert into public.clinics values('${clinic}'); insert into auth.users values('${user}');
    insert into public.patients values('${clinic}','synthetic-patient','PACIENTE FICTICIO - TESTE','');`);
    for (const file of [
      '20260912060000_documents.sql',
      '20260921010000_optional_prescription_date.sql',
      '20260925010000_digital_signatures.sql',
      '20261030023641_sncr_preparation.sql',
      '20261030023733_sncr_rce_issuance.sql',
    ])
      await db.exec(
        await readFile(
          new URL('../../supabase/migrations/' + file, import.meta.url),
          'utf8',
        ),
      );
  }
  const rpc = async (name, args) => {
    if (!/^sncr_rce_[a-z_]+$/.test(name)) throw new Error('RPC not allowed');
    const keys = Object.keys(args);
    const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(',');
    const values = keys.map((k) =>
      args[k] && typeof args[k] === 'object'
        ? JSON.stringify(args[k])
        : args[k],
    );
    return (
      await db.query(`select public.${name}(${placeholders}) as result`, values)
    ).rows[0].result;
  };
  const get = async (id) =>
    (
      await db.query(
        'select * from public.sncr_rce_emissions where id=$1 and clinic_id=$2 and user_id=$3',
        [id, clinic, user],
      )
    ).rows[0];
  const repo = (id) =>
    rceRepository({ id, clinic, user, rpc, get: () => get(id) });
  async function addNumbers(
    numbers = ['2602.6-53.0000001', '2602.6-53.0000002'],
    identity = { crm: '000001', uf: 'SP' },
  ) {
    const rid = crypto.randomUUID();
    await db.query(
      `insert into public.sncr_numbering_requests(id,clinic_id,user_id,environment,category,input,browser_hash,state,raw_response)
      values($1,$2,$3,'hmg','RCE',$4::jsonb,'local-synthetic','RECEIVED_UNVERIFIED','{}')`,
      [
        rid,
        clinic,
        user,
        JSON.stringify({
          conselho: 'CRM',
          category: 'RCE',
          documento: identity.crm,
          uf: identity.uf,
        }),
      ],
    );
    for (const number of numbers)
      await db.query(
        `insert into public.sncr_numbering_items(environment,number,request_id,clinic_id,user_id) values('hmg',$1,$2,$3,$4)`,
        [number, rid, clinic, user],
      );
    return rid;
  }
  async function reserve(
    snapshot = syntheticSnapshot(),
    eid = crypto.randomUUID(),
  ) {
    const did = crypto.randomUUID();
    await db.query(
      `insert into public.clinical_documents(id,clinic_id,patient_id,author_id,kind,patient_name,document_date,text,prescription_category)
      values($1,$2,'synthetic-patient',$3,'Receita','PACIENTE FICTICIO - TESTE',null,'CONTEUDO FICTICIO','RCE')`,
      [did, clinic, user],
    );
    return rpc('sncr_rce_reserve', {
      eid,
      c: clinic,
      u: user,
      did,
      v: 1,
      s: snapshot,
      h: rceSnapshotHash(snapshot),
    });
  }
  return { db, clinic, user, rpc, get, repo, addNumbers, reserve };
}
