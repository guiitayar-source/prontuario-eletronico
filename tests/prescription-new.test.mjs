import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the real handler at the save boundary without a database or patient data.
const source = ts.createSourceFile(
  'prescriptions.tsx',
  readFileSync(new URL('../components/prescriptions.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const component = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'PrescriptionWorkspace',
);
const handler = component.body.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'newPrescription',
);
const code = ts.transpileModule(handler.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ dirty = true, signed = false, busy = false, docsBusy = false, save } = {}) {
  const draft = { id: 'first-prescription', text: 'Primeira receita', status: signed ? 'SIGNED' : 'DRAFT' };
  const calls = [];
  const state = { draft, error: '', busy, naming: true, name: 'Modelo', message: 'Modelo salvo.' };
  const docs = {
    dirty,
    busy: docsBusy,
    save: async () => {
      calls.push('save');
      return save ? await save() : draft;
    },
    open: (...args) => {
      calls.push(args);
      state.draft = { text: args[3], kind: args[4] };
    },
  };
  const newPrescription = runInNewContext(code + '\nnewPrescription;', {
    d: draft, docs, busy, consultationId: 'current-consultation',
    documentTemplate: () => 'Modelo inicial da receita',
    setBusy: (value) => { state.busy = value; },
    setError: (value) => { state.error = value; },
    setNaming: (value) => { state.naming = value; },
    setName: (value) => { state.name = value; },
    setMessage: (value) => { state.message = value; },
  });
  return { newPrescription, calls, state, draft };
}

test('new prescription waits for the current draft to save before replacing the editor', async () => {
  let finishSave;
  const f = fixture({ save: () => new Promise((resolve) => { finishSave = resolve; }) });
  const pending = f.newPrescription();
  assert.deepEqual(f.calls, ['save']);
  assert.equal(f.state.draft, f.draft);
  assert.equal(f.state.busy, true);
  finishSave(f.draft);
  await pending;
  assert.deepEqual(f.calls, [
    'save', [undefined, 'current-consultation', false, 'Modelo inicial da receita', 'Receita'],
  ]);
  assert.equal(f.state.naming, false);
  assert.equal(f.state.name, '');
  assert.equal(f.state.busy, false);
});

test('failed saving keeps the first prescription open and does not start another', async () => {
  for (const save of [async () => null, async () => { throw new Error('Falha de rede'); }]) {
    const f = fixture({ save });
    await f.newPrescription();
    assert.deepEqual(f.calls, ['save']);
    assert.equal(f.state.draft, f.draft);
    assert.equal(f.state.busy, false);
  }
});

test('saved, untouched and signed prescriptions can start another without saving again', async () => {
  for (const options of [{ dirty: false }, { signed: true }]) {
    const f = fixture(options);
    await f.newPrescription();
    assert.equal(f.calls.length, 1);
    assert.ok(Array.isArray(f.calls[0]));
    assert.equal(f.state.draft.kind, 'Receita');
    assert.equal(f.draft.text, 'Primeira receita');
  }
});

test('pending document or template operations prevent starting another prescription', async () => {
  for (const options of [{ docsBusy: true }, { busy: true }]) {
    const f = fixture(options);
    await f.newPrescription();
    assert.deepEqual(f.calls, []);
    assert.equal(f.state.draft, f.draft);
  }
});
