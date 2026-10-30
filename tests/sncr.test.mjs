// Simulated responses only. No connection to Anvisa, no patients, no issuance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  SncrClient,
  SncrError,
  sncrLoginUrl,
  parseNumberingResponse,
  validateNumberingInput,
  validCnpj,
} from '../lib/sncr/client.ts';
import { prescriptionSigningBlock, sncrTransitionEnd } from '../lib/sncr/policy.ts';
import { completeNumbering } from '../lib/sncr/workflow.ts';
import { sncrPreparationConfig } from '../lib/sncr/service.ts';

const input = {
  category: 'RCE',
  conselho: 'CRM',
  documento: '000001',
  uf: 'SP',
};
// Synthetic valid check digits, used only in in-memory mock transport.
const cnpj = '11222333000181';
const raw = {
  inicio: '2602.6-53.0000001',
  fim: '2602.6-53.0001000',
  quantidade: 1000,
};
test('official schema: paths, request fields, array response and environment', async () => {
  const spec = JSON.parse(
    await readFile(
      new URL('../docs/sncr/openapi-hmg-2026-10-19.json', import.meta.url),
      'utf8',
    ),
  );
  let calls = 0;
  const client = new SncrClient(
    'hmg',
    'http://localhost:3000',
    async (url, init) => {
      calls++;
      assert.equal(url.origin, 'https://api-gateway.hmg.apps.anvisa.gov.br');
      const path = url.pathname.replace('/api-sncr', '');
      const endpoint = spec.paths[path].post;
      const ref = endpoint.requestBody.content['application/json'].schema.$ref
        .split('/')
        .at(-1);
      const payload = JSON.parse(init.body);
      assert.deepEqual(
        Object.keys(payload).sort(),
        spec.components.schemas[ref].required.sort(),
      );
      assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
      assert.equal(init.headers.Origin, 'http://localhost:3000');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      assert.equal(payload.cnpj, cnpj);
      return Response.json(raw, { status: 201 });
    },
  );
  assert.deepEqual(
    await client.requestNumbers('synthetic-token', input, cnpj),
    raw,
  );
  assert.equal(calls, 1);
  assert.equal(parseNumberingResponse(input, raw).length, 1000);
  assert.equal(
    spec.components.schemas.NumeracaoReceitaDisponibilizadaResponse.properties
      .numeracoesReceita.type,
    'array',
  );
});
test('all notification types use the documented endpoint, with bounded quantity', async () => {
  for (const category of ['NRA', 'NRB', 'NRB2', 'NRR', 'NRT']) {
    const v = { ...input, category, quantidade: 10 };
    const client = new SncrClient(
      'hmg',
      'http://localhost:3000',
      async (url, init) => {
        assert.equal(
          url.pathname,
          '/api-sncr/api/v1/numeracoes/notificacao-receita',
        );
        assert.deepEqual(JSON.parse(init.body), {
          receita: category,
          conselho: 'CRM',
          uf: 'SP',
          documento: '000001',
          quantidade: 10,
        });
        return Response.json(
          { numeracoesReceita: ['2602.6-53.0000001'], saldoReceitas: 0 },
          { status: 201 },
        );
      },
    );
    assert.deepEqual(
      parseNumberingResponse(v, await client.requestNumbers('test', v, '')),
      ['2602.6-53.0000001'],
    );
  }
  for (const quantidade of [0, 9, 51, 10.5, '10'])
    assert.throws(() =>
      validateNumberingInput({ ...input, category: 'NRA', quantidade }),
    );
  assert.throws(() => validateNumberingInput({ ...input, uf: 'ZZ' }));
  assert.throws(() => validateNumberingInput({ ...input, conselho: 'CRO' }));
  assert.ok(validCnpj(cnpj));
  assert.equal(validCnpj('11111111111111'), false);
});
test('RET uses its own official category, not RCE', async () => {
  const client = new SncrClient(
    'hmg',
    'http://localhost:3000',
    async (_, init) => {
      assert.equal(JSON.parse(init.body).tipo, 'RET');
      return Response.json(raw);
    },
  );
  await client.requestNumbers('test', { ...input, category: 'RET' }, cnpj);
  await assert.rejects(
    () => client.requestNumbers('test', input, 'invalid'),
    /CNPJ/,
  );
});
test('token exchanged once, same Origin, no redirect or token persistence', async () => {
  const client = new SncrClient(
    'hmg',
    'http://localhost:3000',
    async (url, init) => {
      assert.equal(url.pathname, '/api-sncr/api/v1/auth/token');
      assert.equal(url.searchParams.get('session_id'), 'synthetic-once');
      assert.equal(init.headers.Origin, 'http://localhost:3000');
      return Response.json({
        access_token: 'synthetic-token',
        token_type: 'Bearer',
      });
    },
  );
  assert.equal(await client.exchange('synthetic-once'), 'synthetic-token');
  await assert.rejects(() => client.exchange('bad\nsession'), SncrError);
});
test('no automatic retry of POST after timeout, 5xx, 408 or unknown response', async () => {
  for (const status of ['timeout', 500, 502, 408, 429, 'html']) {
    let calls = 0;
    const client = new SncrClient('hmg', 'http://localhost:3000', async () => {
      calls++;
      if (status === 'timeout')
        throw new Error('network failure with synthetic-token');
      return new Response(status === 'html' ? '<html>bad</html>' : 'error', {
        status: status === 'html' ? 200 : status,
      });
    });
    await assert.rejects(
      () => client.requestNumbers('synthetic-token', input, cnpj),
      (e) => {
        assert.equal(e.uncertain, true);
        assert.doesNotMatch(e.message, /synthetic-token/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
  for (const status of [204, 400, 401, 403, 404]) {
    const client = new SncrClient(
      'hmg',
      'http://localhost:3000',
      async () => new Response(null, { status }),
    );
    await assert.rejects(
      () => client.requestNumbers('test', input, cnpj),
      (e) => e.uncertain === false && e.httpStatus === status,
    );
  }
});
test('reject inconsistent ranges, duplicate numbers, string arrays and unvalidated 16-digit format', () => {
  assert.throws(() =>
    parseNumberingResponse(input, { ...raw, fim: '2602.6-53.0000999' }),
  ); // actual Swagger example is inconsistent
  assert.throws(() =>
    parseNumberingResponse(input, { ...raw, fim: '2602.6-54.0001000' }),
  );
  assert.throws(() =>
    parseNumberingResponse(input, { ...raw, quantidade: 999 }),
  );
  const v = { ...input, category: 'NRA', quantidade: 10 };
  for (const numeracoesReceita of [
    '[2602.6-53.0000001]',
    ['2602.6-53.0000001', '2602.6-53.0000001'],
    ['2602.6-53.000000001'],
    [],
    ['<script>'],
  ])
    assert.throws(() =>
      parseNumberingResponse(v, { numeracoesReceita, saldoReceitas: 0 }),
    );
});
test('return URL cannot be redirected to untrusted hosts; production requires HTTPS .br', () => {
  assert.match(
    sncrLoginUrl('hmg', 'http://127.0.0.1:3000/sncr'),
    /auth\/login\?client_url=/,
  );
  for (const url of [
    'https://evil.test/sncr',
    'https://good.br.evil.test/sncr',
    'https://u:p@good.br/sncr',
    'http://good.br/sncr',
    'https://good.br/sncr?next=evil',
    'https://good.br/other',
  ])
    assert.throws(() => sncrLoginUrl('hmg', url));
  assert.throws(() => sncrLoginUrl('prd', 'http://localhost:3000/sncr'));
});
test('the server remains disabled by default and cannot be switched to production via an environment variable', () => {
  const request = new Request('http://localhost:3000/api/sncr');
  for (const environment of ['disabled', 'prd', 'invalid'])
    assert.throws(
      () =>
        sncrPreparationConfig(
          request,
          environment,
          'http://localhost:3000/sncr',
        ),
      (e) => e.status === 503,
    );
  assert.equal(
    sncrPreparationConfig(request, 'hmg', 'http://localhost:3000/sncr')
      .environment,
    'hmg',
  );
  assert.throws(
    () => sncrPreparationConfig(request, 'hmg', 'http://127.0.0.1:3000/sncr'),
    (e) => e.status === 403,
  );
});
test('cutoff uses São Paulo date; notifications never use legacy RCE signature', () => {
  assert.equal(
    prescriptionSigningBlock('RCE', new Date('2027-03-04T02:59:59Z')),
    null,
  );
  // Prorrogação: RCE continua assinável depois de 30/10/2026.
  assert.equal(
    prescriptionSigningBlock('RCE', new Date('2026-10-30T12:00:00Z')),
    null,
  );
  assert.match(
    prescriptionSigningBlock('RCE', new Date('2027-03-04T03:00:00Z')),
    /04\/03\/2027/,
  );
  for (const category of ['NRA', 'NRB', 'NRB2', 'NRR', 'NRT'])
    assert.ok(
      prescriptionSigningBlock(category, new Date('2026-10-19T12:00:00Z')),
    );
  // RET tem fluxo próprio: segue o mesmo prazo de transição da RCE.
  assert.equal(prescriptionSigningBlock('RET', new Date('2026-10-30T12:00:00Z')), null);
  assert.match(
    prescriptionSigningBlock('RET', new Date('2027-03-04T03:00:00Z')),
    /04\/03\/2027/,
  );
});
test('receita simples não depende do SNCR nem entra na numeração', () => {
  for (const at of ['2026-10-19T12:00:00Z', '2026-10-30T03:00:00Z', '2027-06-01T12:00:00Z'])
    assert.equal(prescriptionSigningBlock('SIMPLES', new Date(at)), null);
  assert.throws(() => validateNumberingInput({ ...input, category: 'SIMPLES' }));
});
test('durable workflow: partial failures preserve uncertainty/receipt and never allocate or sign', async () => {
  for (const scenario of [
    'success',
    'auth',
    'timeout',
    'receipt-store',
    'contract',
    'inventory-store',
  ]) {
    let state = 'REQUESTING',
      receipt = null,
      numberCalls = 0,
      stored = false;
    const order = [];
    const promise = completeNumbering({
      sessionId: 'synthetic-once',
      input,
      platformCnpj: cnpj,
      client: {
        exchange: async () => {
          if (scenario === 'auth') throw new Error('expired');
          return 'token';
        },
        requestNumbers: async () => {
          numberCalls++;
          if (scenario === 'timeout') throw new SncrError(503, true);
          return scenario === 'contract' ? { ...raw, quantidade: 999 } : raw;
        },
      },
      store: {
        update: async (fields) => {
          if (fields.raw_response) {
            order.push('receipt');
            if (scenario === 'receipt-store') throw new Error('db unavailable');
            receipt = fields.raw_response;
          }
          if (fields.state) state = fields.state;
        },
        storeNumbers: async (numbers) => {
          order.push('numbers');
          assert.ok(receipt, 'receipt persisted before materialization');
          if (scenario === 'inventory-store')
            throw new Error('duplicate or db failure');
          assert.equal(numbers.length, 1000);
          stored = true;
          state = 'RECEIVED_UNVERIFIED';
        },
      },
    });
    if (['auth', 'timeout', 'receipt-store'].includes(scenario))
      await assert.rejects(() => promise);
    else assert.equal((await promise).issuanceAvailable, false);
    assert.equal(numberCalls, scenario === 'auth' ? 0 : 1);
    assert.equal(
      state,
      {
        success: 'RECEIVED_UNVERIFIED',
        auth: 'AUTH_FAILED',
        timeout: 'UNKNOWN',
        'receipt-store': 'REQUESTING',
        contract: 'CONTRACT_REVIEW',
        'inventory-store': 'CONTRACT_REVIEW',
      }[scenario],
    );
    assert.equal(stored, scenario === 'success');
    if (scenario === 'success') assert.deepEqual(order, ['receipt', 'numbers']);
    if (scenario === 'inventory-store' || scenario === 'contract')
      assert.ok(receipt);
  }
});

test('data de fim da transição igual no código e no banco', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/20261030030624_sncr_transition_extension.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, new RegExp(`date '${sncrTransitionEnd}'`));
});
