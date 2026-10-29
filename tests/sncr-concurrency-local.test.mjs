// PostgreSQL real, isolado e descartável. Nenhuma chamada externa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSncrDb } from './helpers/sncr-local-db.mjs';

const h = createSncrDb();
const clinic = '10000000-0000-4000-8000-000000000001';
const doctor = '20000000-0000-4000-8000-000000000001';
const id = s => `md5('${s}')::uuid`;
const rounds = 20;

try {
  h.sql(`insert into auth.users values ('${doctor}');
    insert into clinics values ('${clinic}');
    insert into clinic_members values ('${clinic}','${doctor}','doctor');
    insert into document_profiles values ('${clinic}','${doctor}','CRM 12345 SP');
    insert into sncr_local_sandboxes values ('${clinic}','synthetic-local-only');
    create table public.sncr_test_markers (scenario text, contestant integer, primary key (scenario,contestant));`);

  for (const competitors of [2, 10]) {
    await test(`${rounds} disputas de faixas sobrepostas com ${competitors} conexões`, async () => {
      for (let round = 0; round < rounds; round++) {
        const scenario = `overlap-${competitors}-${round}`;
        const prefix = `SIMULADO.${scenario}.`;
        h.sql(Array.from({ length: competitors }, (_, i) => `
          insert into sncr_requests(id,clinic_id,prescriber_id,environment,modality,request_key,origin,state)
          values (${id(`${scenario}-request-${i}`)},'${clinic}','${doctor}','hmg','notificacao_b2',${id(`${scenario}-key-${i}`)},'synthetic','completed');`).join(''));
        const outcomes = await Promise.allSettled(Array.from({ length: competitors }, (_, i) => h.asyncSql(`
          begin;
          insert into sncr_test_markers values ('${scenario}',${i});
          insert into sncr_batches(request_id,clinic_id,prescriber_id,environment,modality,council,council_number,council_uf,registration_snapshot,number_prefix,suffix_width,first_suffix,last_suffix,next_suffix,origin,verification_state)
          values (${id(`${scenario}-request-${i}`)},'${clinic}','${doctor}','hmg','notificacao_b2','CRM','12345','SP','CRM 12345 SP','${prefix}',7,1,10,1,'synthetic','verified');
          select pg_sleep(0.02); commit;`, 'postgres')));
        assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1, scenario);
        for (const outcome of outcomes.filter(x => x.status === 'rejected'))
          assert.match(String(outcome.reason.stderr || outcome.reason), /ERROR:\s+23P01:/, scenario);
        const state = JSON.parse(h.sql(`select jsonb_build_object(
          'markers',(select count(*) from sncr_test_markers where scenario='${scenario}'),
          'batches',(select count(*) from sncr_batches where number_prefix='${prefix}' and next_suffix=1 and first_suffix=1 and last_suffix=10 and modality='notificacao_b2' and prescriber_id='${doctor}' and verification_state='verified'),
          'reservations',(select count(*) from sncr_reservations r join sncr_batches b on b.id=r.batch_id where b.number_prefix='${prefix}'),
          'history',(select count(*) from sncr_operation_history h join sncr_batches b on b.request_id=h.request_id where b.number_prefix='${prefix}' and h.action='batch_verified'),
          'audit',(select count(*) from audit_events a join sncr_batches b on a.entity_id=b.id::text where b.number_prefix='${prefix}' and a.action='sncr.batch_verified'));`));
        assert.deepEqual(state, { markers: 1, batches: 1, reservations: 0, history: 1, audit: 1 }, scenario);
        // Esses lotes testam apenas a exclusão; não são estoque para a disputa seguinte.
        h.sql(`update sncr_batches set verification_state='invalid' where number_prefix='${prefix}';`);
      }
    });

    await test(`${rounds} disputas do último número com ${competitors} conexões`, async () => {
      for (let round = 0; round < rounds; round++) {
        const scenario = `last-${competitors}-${round}`;
        const prefix = `SIMULADO.${scenario}.`;
        const request = id(`${scenario}-request`);
        h.sql(`insert into sncr_requests(id,clinic_id,prescriber_id,environment,modality,request_key,origin,state)
          values (${request},'${clinic}','${doctor}','hmg','notificacao_b2',${id(`${scenario}-request-key`)},'synthetic','completed');
          insert into sncr_batches(request_id,clinic_id,prescriber_id,environment,modality,council,council_number,council_uf,registration_snapshot,number_prefix,suffix_width,first_suffix,last_suffix,next_suffix,origin,verification_state)
          values (${request},'${clinic}','${doctor}','hmg','notificacao_b2','CRM','12345','SP','CRM 12345 SP','${prefix}',7,1,1,1,'synthetic','verified');
          ${Array.from({ length: competitors }, (_, i) => `insert into clinical_documents(id,clinic_id,author_id,patient_id,kind,status,physician_registration,version,text,patient_name,physician_name)
            values (${id(`${scenario}-doc-${i}`)},'${clinic}','${doctor}','synthetic','Receita','DRAFT','CRM 12345 SP',1,'Modalidade: Notificação de Receita B2','Paciente sintético','Prescritor sintético');`).join('')}`);
        const reserve = i => `select public.sncr_reserve_number('${clinic}','${doctor}',${id(`${scenario}-doc-${i}`)},1,'hmg','notificacao_b2',${id(`${scenario}-key-${i}`)},true);`;
        const outcomes = await Promise.allSettled(Array.from({ length: competitors }, (_, i) => h.asyncSql(reserve(i))));
        const winner = outcomes.findIndex(x => x.status === 'fulfilled');
        assert.notEqual(winner, -1, scenario);
        assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1, scenario);
        for (const outcome of outcomes.filter(x => x.status === 'rejected'))
          assert.match(String(outcome.reason.stderr || outcome.reason), /ERROR:\s+P0001:/, scenario);
        const first = JSON.parse(outcomes[winner].value);
        assert.equal(first.number, `${prefix}0000001`, scenario);
        const replay = JSON.parse(await h.asyncSql(reserve(winner)));
        assert.equal(replay.replayed, true, scenario);
        assert.equal(replay.reservationId, first.reservationId, scenario);
        assert.equal(replay.number, first.number, scenario);
        const state = JSON.parse(h.sql(`select jsonb_build_object(
          'remaining',(select last_suffix-next_suffix+1 from sncr_batches where request_id=${request}),
          'cursor',(select next_suffix from sncr_batches where request_id=${request}),
          'reservations',(select count(*) from sncr_reservations r join sncr_batches b on b.id=r.batch_id where b.request_id=${request}),
          'correct',(select count(*) from sncr_reservations r join sncr_batches b on b.id=r.batch_id join clinical_documents d on d.id=r.document_id where b.request_id=${request} and r.document_id=${id(`${scenario}-doc-${winner}`)} and r.prescriber_id='${doctor}' and r.clinic_id='${clinic}' and r.modality='notificacao_b2' and r.state='reserved' and r.document_version=d.version and r.number='${prefix}0000001' and r.request_key=${id(`${scenario}-key-${winner}`)} and b.origin='synthetic' and b.verification_state='verified'),
          'history',(select count(*) from sncr_operation_history where request_id=${request} and action='reservation_reserved'),
          'audit',(select count(*) from audit_events a join sncr_reservations r on a.entity_id=r.id::text join sncr_batches b on b.id=r.batch_id where b.request_id=${request} and a.action='sncr.reservation_reserved'));`));
        assert.deepEqual(state, { remaining: 0, cursor: 2, reservations: 1, correct: 1, history: 1, audit: 1 }, scenario);
      }
    });
  }
} finally {
  h.cleanup();
}
