import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandSncrRange, getSncrEnvironment, SncrService } from '../lib/sncr/client.ts';

test('faixa de mil números é preservada em ordem', () => {
  const result = expandSncrRange('X0000001', 'X0001000');
  assert.equal(result.length, 1000);
  assert.deepEqual(result, Array.from({length: 1000}, (_, i) => `X${String(i + 1).padStart(7, '0')}`));
});

test('faixa inválida ou maior que o limite falha sem truncamento', () => {
  assert.throws(() => expandSncrRange('X0001', 'X1001', 1000));
  assert.throws(() => expandSncrRange('X0001', 'Y0002'));
});

test('ambiente padrão é homologação', () => {
  const old = process.env.ANVISA_SNCR_ENV;
  try { delete process.env.ANVISA_SNCR_ENV; assert.equal(getSncrEnvironment(), 'hmg'); }
  finally { if (old === undefined) delete process.env.ANVISA_SNCR_ENV; else process.env.ANVISA_SNCR_ENV = old; }
});

test('alocação antiga falha sem chamar Anvisa ou banco', async () => {
  let called = false;
  const service = new SncrService(async () => { called = true; throw new Error('rede'); });
  await assert.rejects(service.allocateForPrescription({clinicId:'synthetic', modality:'controle_especial', physicianRegistration:'CRM 12345 SP'}), /reserva|indisponível/i);
  assert.equal(called, false);
});
