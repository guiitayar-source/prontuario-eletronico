import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Run the component's real handlers with controlled API failures, without a DOM
// or an external signing provider. The compiler removes their TypeScript types.
const source = ts.createSourceFile(
  'clinical-record.tsx',
  readFileSync(new URL('../components/clinical-record.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const component = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ClinicalRecord',
);
const names = new Set([
  'request', 'choose', 'load', 'persist', 'prepareEvolutionForSignature',
  'handleSignEvolution', 'handleConnectAndSign',
]);
const functions = [...source.statements, ...component.body.statements].filter(
  (node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text),
);
assert.equal(functions.length, names.size);
const code = ts.transpileModule(functions.map((node) => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ failure, changedDuringSave = false, finalized = false, clean = false, blocked = false, flight = false, waitForSave } = {}) {
  const previous = 'Texto confirmado no banco';
  const edited = clean ? previous : 'Texto novo ainda não salvo';
  const current = { id: 'synthetic-evolution', version: 1, text: previous, status: finalized ? 'FINALIZED' : 'DRAFT', finalized_at: finalized ? '2026-09-29T12:00:00Z' : null };
  const saved = { current: previous }, latest = { current: finalized ? previous : edited };
  const state = { error: blocked ? 'Falha anterior no salvamento' : '', status: 'Salvo', signing: false, text: latest.current };
  const calls = [], storage = new Map();
  const window = { location: { href: 'http://test.local' } };
  const apiFetch = async (url, init) => {
    const payload = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, payload });
    if (url.includes('action=save')) {
      if (waitForSave) await waitForSave;
      if (failure === 'network') throw new Error('Rede indisponível');
      if (failure) return Response.json({ error: 'Outra edição foi salva.' }, { status: 409 });
      if (changedDuringSave) latest.current = 'Texto alterado durante o salvamento';
      return Response.json({ consultation: { ...current, version: 2, text: payload.text } });
    }
    if (url.includes('sign-evolution')) return Response.json({ success: true });
    if (url.includes('birdid/authorize')) return Response.json({ authorizationUrl: 'https://provider.example/authorize' });
    return Response.json({ consultations: [{ ...current, text: saved.current, status: 'SIGNED' }] });
  };
  const bindings = {
    current, patient: { id: 'synthetic-patient' }, saved, latest,
    flight: { current: flight }, blocked: { current: blocked }, busy: false, signing: false,
    apiFetch, window, sessionStorage: { setItem: (key, value) => storage.set(key, value) },
    setCurrent: () => {}, setRows: () => {}, setFinalizing: () => {}, setBusy: () => {}, setAddendum: () => {},
    setText: (value) => { state.text = value; },
    setError: (value) => { state.error = value; },
    setStatus: (value) => { state.status = value; },
    setSigning: (value) => { state.signing = value; },
  };
  const handlers = runInNewContext(code + '\n({ handleSignEvolution, handleConnectAndSign });', bindings);
  return { handlers, calls, state, latest, saved, storage, window };
}

for (const handler of ['handleSignEvolution', 'handleConnectAndSign']) {
  const action = handler === 'handleSignEvolution' ? 'sign-evolution' : 'birdid/authorize';
  for (const failure of ['conflict', 'network']) {
    await test(`${handler}: ${failure} preserves the editor and stops signing/redirect`, async () => {
      const f = fixture({ failure });
      await f.handlers[handler]();
      assert.equal(f.calls.length, 1);
      assert.ok(f.calls[0].url.includes('action=save'));
      assert.equal(f.saved.current, 'Texto confirmado no banco');
      assert.equal(f.latest.current, 'Texto novo ainda não salvo');
      assert.equal(f.state.status, 'Não salvo — seu texto permanece nesta tela');
      assert.match(f.state.error, /Outra edição|Rede indisponível/);
      assert.equal(f.state.signing, false);
      assert.equal(f.storage.size, 0);
      assert.equal(f.window.location.href, 'http://test.local');
    });
  }
  await test(`${handler}: blocked or in-flight saving cannot be mistaken for success`, async () => {
    for (const options of [{ blocked: true }, { flight: true }]) {
      const f = fixture(options);
      await f.handlers[handler]();
      assert.equal(f.calls.length, 0);
      assert.equal(f.state.signing, false);
      assert.equal(f.storage.size, 0);
      assert.equal(f.window.location.href, 'http://test.local');
      if (options.blocked) assert.equal(f.state.error, 'Falha anterior no salvamento');
    }
  });
  await test(`${handler}: waits for saved text before contacting the provider`, async () => {
    let resolveSave;
    const waitForSave = new Promise((resolve) => { resolveSave = resolve; });
    const f = fixture({ waitForSave });
    const running = f.handlers[handler]();
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.signing, true);
    assert.equal(f.saved.current, 'Texto confirmado no banco');
    resolveSave();
    await running;
    assert.equal(f.saved.current, 'Texto novo ainda não salvo');
    assert.ok(f.calls[1].url.includes(action));
    assert.equal(f.state.signing, false);
    if (handler === 'handleConnectAndSign') {
      assert.equal(f.storage.get('birdid_return_evolution_id'), 'synthetic-evolution');
      assert.equal(f.window.location.href, 'https://provider.example/authorize');
    }
  });
  await test(`${handler}: newer text during saving stops the provider call`, async () => {
    const f = fixture({ changedDuringSave: true });
    await f.handlers[handler]();
    assert.equal(f.calls.length, 1);
    assert.equal(f.latest.current, 'Texto alterado durante o salvamento');
    assert.equal(f.state.status, 'Alterações pendentes');
    assert.match(f.state.error, /não salvas/);
    assert.equal(f.storage.size, 0);
    assert.equal(f.window.location.href, 'http://test.local');
  });
  await test(`${handler}: already saved or finalized evolutions need no extra save`, async () => {
    for (const options of [{ clean: true }, { finalized: true }]) {
      const f = fixture(options);
      await f.handlers[handler]();
      assert.ok(f.calls[0].url.includes(action));
      assert.ok(!f.calls.some((call) => call.url.includes('action=save')));
      assert.equal(f.state.error, '');
    }
  });
}
