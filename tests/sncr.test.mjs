import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCouncilRegistration,
  expandSncrRange,
  parseNotificacaoNumbers,
  parseSncrBatchInput,
  SncrService,
} from '../lib/sncr/client.ts';

describe('Parsing SNCR e bloqueio do contrato legado (sem validação externa)', () => {
  const prevEnv = {};
  const envKeys = [
    'ANVISA_SNCR_ENV',
    'ANVISA_SNCR_CLIENT_ID',
    'ANVISA_SNCR_CLIENT_SECRET',
    'ANVISA_SNCR_CNPJ',
    'ANVISA_SNCR_JWS_INTEGRADORA',
  ];

  beforeEach(() => {
    for (const k of envKeys) prevEnv[k] = process.env[k];
    process.env.ANVISA_SNCR_ENV = 'hmg';
    process.env.ANVISA_SNCR_CLIENT_ID = 'client-teste';
    process.env.ANVISA_SNCR_CLIENT_SECRET = 'secret-teste';
    process.env.ANVISA_SNCR_CNPJ = '12.345.678/0001-99';
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  });

  it('extrai conselho, número e UF de diferentes formatos de registro médico (incluindo RQE 72731)', () => {
    assert.deepEqual(
      extractCouncilRegistration('CRM 164119 SP · RQE 72731'),
      { conselho: 'CRM', documento: '164119', uf: 'SP' }
    );
    assert.deepEqual(
      extractCouncilRegistration('Psiquiatra  ·  CRM 164119  ·  RQE 72731'),
      { conselho: 'CRM', documento: '164119', uf: 'SP' }
    );
    assert.deepEqual(
      extractCouncilRegistration('CRM/RJ 123.456 - RQE 1122'),
      { conselho: 'CRM', documento: '123456', uf: 'RJ' }
    );
    assert.deepEqual(
      extractCouncilRegistration('CRM-MG 54321'),
      { conselho: 'CRM', documento: '54321', uf: 'MG' }
    );
    assert.equal(extractCouncilRegistration('CRM 164119', ''), null);
    assert.equal(extractCouncilRegistration(''), null);
  });

  it('expande faixa de numeração de Receita Branca (RCE / RET)', () => {
    const nums = expandSncrRange('2602.6-53.0000001', '2602.6-53.0000004');
    assert.deepEqual(nums, [
      '2602.6-53.0000001',
      '2602.6-53.0000002',
      '2602.6-53.0000003',
      '2602.6-53.0000004',
    ]);
  });

  it('normaliza lista de numerações de Notificação de Receita (array ou string com colchetes)', () => {
    assert.deepEqual(
      parseNotificacaoNumbers('[2411.1-00.0000001, 2411.1-00.0000002]'),
      ['2411.1-00.0000001', '2411.1-00.0000002']
    );
    assert.deepEqual(
      parseNotificacaoNumbers(['2411.1-00.0000010', '2411.1-00.0000011']),
      ['2411.1-00.0000010', '2411.1-00.0000011']
    );
  });

  it('credenciais configuradas não liberam alocação legada nem chamadas externas', async () => {
    let calls=0;
    const service=new SncrService(async()=>{calls++;throw Error('não deve chamar rede');});
    await assert.rejects(service.allocateForPrescription({clinicId:'synthetic',modality:'controle_especial',physicianRegistration:'CRM 12345 SP'}), /reserva.*indisponível/i);
    assert.equal(calls,0);
    assert.equal(await service.hasAvailableNumbering({},'synthetic','controle_especial'),false);
  });

  it('notificações A e B também exigem o contrato transacional por documento', async () => {
    let calls=0;const service=new SncrService(async()=>{calls++;throw Error('não deve chamar rede');});
    for(const modality of ['notificacao_b','notificacao_a']) await assert.rejects(service.allocateForPrescription({clinicId:'synthetic',modality,physicianRegistration:'CRM 12345 SP'}),/reserva.*indisponível/i);
    assert.equal(calls,0);
  });

  it('interpreta lotes manuais integralmente sem qualificá-los como estoque oficial', async () => {
    const range=parseSncrBatchInput({inicio:'2602.6-53.0000001',fim:'2602.6-53.0001000'});
    assert.equal(range.numbers.length,1000);
    assert.deepEqual(parseSncrBatchInput({rawList:'synthetic.1,synthetic.2;synthetic.3'}).numbers,['synthetic.1','synthetic.2','synthetic.3']);
    const service=new SncrService(async()=>{throw Error('rede não autorizada');});
    await assert.rejects(service.allocateForPrescription({clinicId:'synthetic',modality:'controle_especial',physicianRegistration:'CRM 12345 SP'}),/reserva.*indisponível/i);
  });
});
