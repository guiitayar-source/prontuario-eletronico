import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCouncilRegistration,
  expandSncrRange,
  parseNotificacaoNumbers,
  parseSncrBatchInput,
  SncrService,
} from '../lib/sncr/client.ts';

describe('Integração SNCR Anvisa (RDC 1.000/2025 — API v1.2.1)', () => {
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

  it('autentica via Keycloak e aloca numeração RCE (Receita de Controle Especial), reaproveitando o lote e pulando números já usados', async () => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/openid-connect/token')) {
        return new Response(
          JSON.stringify({ access_token: 'tok-anvisa-123', expires_in: 300 }),
          { status: 200 }
        );
      }
      if (String(url).endsWith('/api/v1/numeracoes/receita-especial-retencao')) {
        const body = JSON.parse(init.body);
        assert.deepEqual(body, {
          conselho: 'CRM',
          tipo: 'RCE',
          documento: '164119',
          uf: 'SP',
          cnpj: '12345678000199',
        });
        return new Response(
          JSON.stringify({
            inicio: '2602.6-53.0000001',
            fim: '2602.6-53.0000003',
            quantidade: 3,
            mensagem: 'Numeração gerada com sucesso.',
          }),
          { status: 201 }
        );
      }
      throw new Error(`URL inesperada: ${url}`);
    };

    // Simula que o número 0000001 já foi utilizado em uma receita anterior da clínica
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: async () => ({
                data: [
                  {
                    text: 'SNCR: 2602.6-53.0000001\nVia de administração: Uso oral\n\n1) Sertralina 50mg',
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    };

    const service = new SncrService(mockFetch);

    // 1ª chamada: busca na API, pula 0000001 (já usado) e entrega 0000002
    const first = await service.allocateForPrescription({
      db: mockDb,
      clinicId: 'clinic-1',
      modality: 'controle_especial',
      physicianRegistration: 'Psiquiatra · CRM 164119 SP · RQE 72731',
    });
    assert.equal(first.number, '2602.6-53.0000002');
    assert.equal(first.source, 'api');
    assert.equal(first.remainingInPool, 1);
    assert.equal(calls.length, 2); // token + receita-especial-retencao

    // 2ª chamada: entrega 0000003 direto do pool sem nova chamada HTTP
    const second = await service.allocateForPrescription({
      db: mockDb,
      clinicId: 'clinic-1',
      modality: 'controle_especial',
      physicianRegistration: 'Psiquiatra · CRM 164119 SP · RQE 72731',
    });
    assert.equal(second.number, '2602.6-53.0000003');
    assert.equal(second.source, 'pool');
    assert.equal(second.remainingInPool, 0);
    assert.equal(calls.length, 2);
  });

  it('aloca numeração de Notificação de Receita B (NRB) em /api/v1/numeracoes/notificacao-receita', async () => {
    const mockFetch = async (url, init) => {
      if (String(url).includes('/openid-connect/token')) {
        return new Response(
          JSON.stringify({ access_token: 'tok-anvisa-456', expires_in: 300 }),
          { status: 200 }
        );
      }
      if (String(url).endsWith('/api/v1/numeracoes/notificacao-receita')) {
        const body = JSON.parse(init.body);
        assert.deepEqual(body, {
          receita: 'NRB',
          conselho: 'CRM',
          uf: 'SP',
          documento: '164119',
          quantidade: 10,
        });
        return new Response(
          JSON.stringify({
            numeracoesReceita: '[2411.1-00.0000001, 2411.1-00.0000002]',
            saldoReceitas: 48,
            mensagem: 'Saldo inferior a 50 receitas disponíveis.',
          }),
          { status: 201 }
        );
      }
      throw new Error(`URL inesperada: ${url}`);
    };

    const service = new SncrService(mockFetch);
    const res = await service.allocateForPrescription({
      clinicId: 'clinic-2',
      modality: 'notificacao_b',
      physicianRegistration: 'CRM/SP 164119',
    });
    assert.equal(res.number, '2411.1-00.0000001');
    assert.equal(res.saldoReceitas, 48);
    assert.equal(res.remainingInPool, 1);
  });

  it('interpreta lotes SNCR por faixa (início/fim) ou lista colada e aloca números sem exigir e-CNPJ/API', async () => {
    delete process.env.ANVISA_SNCR_CLIENT_ID;
    delete process.env.ANVISA_SNCR_CLIENT_SECRET;
    delete process.env.ANVISA_SNCR_CNPJ;

    const byRange = parseSncrBatchInput({
      inicio: '2602.6-53.0000010',
      fim: '2602.6-53.0000012',
    });
    assert.deepEqual(byRange.numbers, [
      '2602.6-53.0000010',
      '2602.6-53.0000011',
      '2602.6-53.0000012',
    ]);

    const byList = parseSncrBatchInput({
      rawList: '2411.1-00.0000001\n2411.1-00.0000002, 2411.1-00.0000003',
    });
    assert.deepEqual(byList.numbers, [
      '2411.1-00.0000001',
      '2411.1-00.0000002',
      '2411.1-00.0000003',
    ]);

    const auditEvents = [];
    const clinicalDocs = [
      {
        text: 'Modalidade: controle_especial\nSNCR: 2602.6-53.0000010\nVia de administração: Uso oral\n\n1) Sertralina 50mg',
      },
    ];

    const mockDb = {
      from: (table) => ({
        select: () => ({
          eq: () => ({
            eq: (_col, val) => ({
              limit: async () => {
                if (table === 'clinical_documents') {
                  return { data: clinicalDocs };
                }
                if (table === 'audit_events') {
                  return {
                    data: auditEvents.filter((ev) => ev.entity_type === val),
                  };
                }
                return { data: [] };
              },
            }),
          }),
        }),
        insert: async (row) => {
          auditEvents.push({
            id: auditEvents.length + 1,
            ...row,
            occurred_at: new Date().toISOString(),
          });
          return { error: null };
        },
      }),
    };

    const service = new SncrService();
    const batch = await service.registerBatch({
      db: mockDb,
      clinicId: 'clinic-local',
      userId: 'user-1',
      modality: 'controle_especial',
      label: 'Lote C1 Out/2026',
      inicio: '2602.6-53.0000010',
      fim: '2602.6-53.0000012',
    });

    assert.equal(batch.total, 3);
    assert.equal(batch.used, 1); // 0000010 já estava em clinicalDocs
    assert.equal(batch.remaining, 2);
    assert.equal(batch.nextNumber, '2602.6-53.0000011');

    // Aloca o próximo número livre direto do lote local sem chamar API da Anvisa
    const allocated = await service.allocateForPrescription({
      db: mockDb,
      clinicId: 'clinic-local',
      modality: 'controle_especial',
      physicianRegistration: 'Psiquiatra · CRM 164119 · RQE 72731',
    });

    assert.equal(allocated.number, '2602.6-53.0000011');
    assert.equal(allocated.source, 'batch');
    assert.equal(allocated.remainingInPool, 1);

    // Exclui o lote e verifica que a lista fica vazia
    await service.deleteBatch({
      db: mockDb,
      clinicId: 'clinic-local',
      userId: 'user-1',
      batchId: batch.id,
    });
    const listAfterDelete = await service.listBatches(mockDb, 'clinic-local');
    assert.equal(listAfterDelete.length, 0);
  });
});
