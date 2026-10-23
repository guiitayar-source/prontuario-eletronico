// Ephemeral local PostgreSQL. Synthetic records only; no Supabase/Anvisa network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('SNCR staged schema: isolation, one-use claims, quarantine, duplicate rollback and clinical locks', async () => {
  const db = new PGlite();
  const c = 'aaaaaaaa-0000-4000-8000-000000000001',
    c2 = 'aaaaaaaa-0000-4000-8000-000000000002';
  const u = 'bbbbbbbb-0000-4000-8000-000000000001',
    u2 = 'bbbbbbbb-0000-4000-8000-000000000002';
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
      create table auth.users(id uuid primary key);
      create type public.clinic_role as enum ('owner','doctor','secretary');
      create table public.clinics(id uuid primary key);
      create table public.patients(clinic_id uuid,id text,name text,social_name text,primary key(clinic_id,id));
      create table public.consultations(id uuid primary key,clinic_id uuid,patient_id text);
      create function public.has_clinic_role(c uuid,roles public.clinic_role[]) returns boolean language sql as $$
        select c='${c}'::uuid and auth.uid()='${u}'::uuid and current_setting('test.role',true)='doctor' $$;
      create function public.record_change() returns trigger language plpgsql as $$ begin return new; end $$;
      insert into public.clinics values('${c}'),('${c2}'); insert into auth.users values('${u}'),('${u2}');
      insert into public.patients values('${c}','synthetic-patient','PACIENTE SINTÉTICO','');
      set test.uid='${u}'; set test.role='doctor';
    `);
    for (const file of [
      '20260912060000_documents.sql',
      '20260921010000_optional_prescription_date.sql',
      '20260925010000_digital_signatures.sql',
    ])
      await db.exec(
        await readFile(
          new URL('../supabase/migrations/' + file, import.meta.url),
          'utf8',
        ),
      );
    const historicalId = crypto.randomUUID();
    await db.query(
      `insert into public.clinical_documents(id,clinic_id,patient_id,author_id,kind,patient_name,document_date,text,status,signed_pdf_path)
      values($1,$2,'synthetic-patient',$3,'Receita','PACIENTE SINTÉTICO','2026-01-01','FIXTURE HISTÓRICA','SIGNED','synthetic-historical.pdf')`,
      [historicalId, c, u],
    );
    await db.exec(
      await readFile(
        new URL(
          '../supabase/migrations/20261019010000_sncr_preparation.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const historical = (
      await db.query(
        'select status,text,prescription_category,signed_pdf_path from public.clinical_documents where id=$1',
        [historicalId],
      )
    ).rows[0];
    assert.deepEqual(historical, {
      status: 'SIGNED',
      text: 'FIXTURE HISTÓRICA',
      prescription_category: null,
      signed_pdf_path: 'synthetic-historical.pdf',
    });
    const input = {
      category: 'RCE',
      conselho: 'CRM',
      documento: '000001',
      uf: 'SP',
    };
    const create = async (
      id,
      clinic = c,
      user = u,
      category = 'RCE',
      state = 'AUTH_PENDING',
    ) =>
      db.query(
        `
      insert into public.sncr_numbering_requests(id,clinic_id,user_id,environment,category,input,browser_hash,state)
      values($1,$2,$3,'hmg',$4,$5::jsonb,'synthetic-browser',$6)`,
        [id, clinic, user, category, JSON.stringify(input), state],
      );
    const claim = (id, clinic = c, user = u, browser = 'synthetic-browser') =>
      db.query('select public.sncr_claim_request($1,$2,$3,$4)', [
        id,
        clinic,
        user,
        browser,
      ]);
    const id = crypto.randomUUID();
    await create(id);
    for (const args of [
      [c2, u, 'synthetic-browser'],
      [c, u2, 'synthetic-browser'],
      [c, u, 'wrong-browser'],
    ])
      await assert.rejects(() => claim(id, ...args), /privilege|permission/i);
    const claims = await Promise.allSettled([claim(id), claim(id)]);
    assert.equal(
      claims.filter((r) => r.status === 'fulfilled').length,
      1,
      'a callback can be claimed only once',
    );
    await assert.rejects(() => claim(id), /já processada/);
    await assert.rejects(
      () => create(crypto.randomUUID(), c2, u),
      /duplicate key/,
      'unresolved request blocks another clinic from consuming another quota',
    );
    await db.query(
      'update public.sncr_numbering_requests set raw_response=$2::jsonb where id=$1',
      [id, JSON.stringify({ synthetic: true })],
    );
    const store = (rid, numbers, clinic = c, user = u) =>
      db.query('select public.sncr_store_numbers($1,$2,$3,$4::jsonb)', [
        rid,
        clinic,
        user,
        JSON.stringify(numbers),
      ]);
    await assert.rejects(
      () => store(id, ['2602.6-53.0000001'], c2),
      /privilege|permission/i,
    );
    await store(id, ['2602.6-53.0000001']);
    assert.equal(
      (await db.query('select state from public.sncr_numbering_items')).rows[0]
        .state,
      'QUARANTINED',
    );
    assert.equal(
      (
        await db.query(
          'select state from public.sncr_numbering_requests where id=$1',
          [id],
        )
      ).rows[0].state,
      'RECEIVED_UNVERIFIED',
    );
    await assert.rejects(
      () => store(id, ['2602.6-53.0000002']),
      /não está pronta/,
    );
    const id2 = crypto.randomUUID();
    await create(id2, c2, u2);
    await claim(id2, c2, u2);
    await db.query(
      "update public.sncr_numbering_requests set raw_response='{}'::jsonb where id=$1",
      [id2],
    );
    await assert.rejects(
      () => store(id2, ['2602.6-53.0000002', '2602.6-53.0000001'], c2, u2),
      /duplicate key/,
    );
    assert.equal(
      (
        await db.query(
          'select count(*)::int as n from public.sncr_numbering_items',
        )
      ).rows[0].n,
      1,
      'partial batch rolled back',
    );
    const expired = crypto.randomUUID();
    await create(expired, c, u, 'NRB');
    await db.query(
      "update public.sncr_numbering_requests set expires_at=now()-interval '1 minute' where id=$1",
      [expired],
    );
    await assert.rejects(() => claim(expired), /expirada/);
    const events = (
      await db.query(
        'select actor_id,state from public.sncr_request_events where request_id=$1 order by id',
        [id],
      )
    ).rows;
    assert.deepEqual(
      events.map((r) => r.state),
      ['AUTH_PENDING', 'REQUESTING', 'REQUESTING', 'RECEIVED_UNVERIFIED'],
    );
    assert.ok(events.every((r) => r.actor_id === u));
    // Browser roles cannot read raw receipts/cookie hashes or mutate inventory/RPCs.
    await db.exec('set role authenticated');
    await assert.rejects(
      () => db.query('select * from public.sncr_numbering_requests'),
      /permission denied/,
    );
    await assert.rejects(() => claim(id), /permission denied/);
    await assert.rejects(() => store(id, []), /permission denied/);
    await assert.rejects(
      () => db.query('select * from public.sncr_request_events'),
      /permission denied/,
    );
    await db.exec('reset role');
    await db.exec('set role service_role');
    await assert.rejects(
      () => db.query('delete from public.sncr_request_events'),
      /permission denied/,
    );
    await db.exec('reset role');
    const write = async (d) =>
      (
        await db.query('select public.document_write($1,$2::jsonb) as d', [
          c,
          JSON.stringify(d),
        ])
      ).rows[0].d;
    const draft = {
      id: crypto.randomUUID(),
      patient_id: 'synthetic-patient',
      kind: 'Receita',
      text: 'CONTEÚDO SINTÉTICO',
      physician_name: 'PRESCRITOR SINTÉTICO',
      physician_registration: 'CRM 000001/SP',
      document_date: null,
      version: 0,
    };
    const saved = await write(draft);
    assert.equal(saved.prescription_category, 'RCE');
    assert.equal(
      (await write(draft)).version,
      1,
      'existing repeated-create behavior preserved',
    );
    const ret = await write({ ...saved, prescription_category: 'RET' });
    assert.equal(ret.prescription_category, 'RET');
    await assert.rejects(
      () =>
        db.query(
          "update public.clinical_documents set status='SIGNING' where id=$1",
          [ret.id],
        ),
      /Emissão eletrônica indisponível/,
    );
    const nr = await write({ ...ret, prescription_category: 'NRB' });
    await assert.rejects(
      () =>
        db.query(
          "update public.clinical_documents set status='SIGNED' where id=$1",
          [nr.id],
        ),
      /Emissão eletrônica indisponível/,
    );
    await assert.rejects(
      () => write({ ...nr, prescription_category: 'INVALID' }),
      /check constraint/,
    );
    await db.exec("set test.role='secretary'");
    await assert.rejects(
      () => write({ ...nr, text: 'Forbidden' }),
      /privilege|permission/i,
    );
    await db.exec("set test.role='doctor'");
    // Existing signed documents survive migration; use non-recipe for lock test.
    const att = await write({
      ...draft,
      id: crypto.randomUUID(),
      kind: 'Atestado',
      document_date: '2026-10-19',
    });
    await db.query(
      "update public.clinical_documents set status='SIGNING' where id=$1",
      [att.id],
    );
    await assert.rejects(() => write({ ...att, text: 'changed' }), /imutável/);
    await assert.rejects(
      () =>
        db.query(
          "update public.clinical_documents set text='changed' where id=$1",
          [att.id],
        ),
      /imutável/,
    );
    await db.query(
      "update public.clinical_documents set status='SIGNED' where id=$1",
      [att.id],
    );
    await assert.rejects(
      () =>
        db.query(
          "update public.clinical_documents set status='DRAFT' where id=$1",
          [att.id],
        ),
      /não pode retornar/,
    );
    assert.equal(
      (
        await db.query(
          'select count(*)::int as n from public.digital_signatures',
        )
      ).rows[0].n,
      0,
      'no recipe or signature emitted by these tests',
    );
  } finally {
    await db.close();
  }
});
