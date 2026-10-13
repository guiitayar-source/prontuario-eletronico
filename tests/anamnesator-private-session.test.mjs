import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = ts.createSourceFile(
  'session.ts',
  readFileSync(
    new URL(
      '../components/anamnesator/use-anamnesator-session.ts',
      import.meta.url,
    ),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
);
const hook = source.statements.find(
  (n) =>
    ts.isFunctionDeclaration(n) && n.name?.text === 'useAnamnesatorSession',
);
const functions = hook.body.statements.filter(
  (n) =>
    ts.isFunctionDeclaration(n) &&
    ['transcribe', 'generateDraft', 'publish'].includes(n.name?.text),
);
const code = ts.transpileModule(
  functions.map((n) => n.getText(source)).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
function fixture(fail = false) {
  const audio = new Blob(['synthetic audio']),
    state = {},
    calls = [];
  const destination = {
    current: {
      id: 'synthetic-result',
      consultation: 'authorized-consultation',
      revision: 0,
    },
  };
  const bindings = {
    audio,
    destination,
    selectedTranscription: { configured: true, privacy: 'local' },
    transcriptionModel: 'medium',
    transcriptionProvider: 'remote',
    transcript: 'Texto revisado',
    draft: '',
    selectedDraft: { configured: true, privacy: 'local' },
    draftModel: 'local-ollama',
    draftProvider: 'remote',
    setBusy: (value) => (state.busy = value),
    setError: (value) => (state.error = value),
    setStatus: (value) => (state.status = value),
    setTranscript: (value) => (state.transcript = value),
    setDraft: (value) => (state.draft = value),
    setPublicationError: (value) => (state.publicationError = value),
    bridgeJson: async (path, init) => {
      calls.push({ destination: 'local-app', path, init });
      return { job_id: 'synthetic-job' };
    },
    waitForJob: async (_id, kind) =>
      kind === 'transcription' ? 'Transcrição sintética' : 'Rascunho sintético',
    extensionFor: () => '.webm',
    apiFetch: async (path, init) => {
      calls.push({
        destination: 'psywrite',
        path,
        data: JSON.parse(init.body),
      });
      return { ok: !fail };
    },
  };
  return {
    state,
    calls,
    audio,
    handlers: runInNewContext(
      code + '\n({ transcribe, generateDraft });',
      bindings,
    ),
  };
}
await test('Audio goes only to the local app; only scoped text goes to PsyWrite', async () => {
  const f = fixture();
  await f.handlers.transcribe();
  assert.equal(f.calls[0].destination, 'local-app');
  assert.equal(f.calls[0].init.body, f.audio);
  assert.equal(f.calls[1].destination, 'psywrite');
  assert.equal(f.calls[1].data.consultation_id, 'authorized-consultation');
  assert.equal(f.calls[1].data.transcription, 'Transcrição sintética');
  assert.equal('audio' in f.calls[1].data, false);
});
await test('Failed publication preserves transcription and gives a retry message', async () => {
  const f = fixture(true);
  await f.handlers.transcribe();
  assert.equal(f.state.transcript, 'Transcrição sintética');
  assert.match(f.state.publicationError, /não foi salvo/);
  assert.equal(f.state.error, '');
  assert.equal(f.state.busy, false);
});
await test('Generated draft is saved separately with the reviewed transcription', async () => {
  const f = fixture();
  await f.handlers.generateDraft();
  assert.equal(f.calls[1].data.transcription, 'Texto revisado');
  assert.equal(f.calls[1].data.draft, 'Rascunho sintético');
  assert.equal(f.state.draft, 'Rascunho sintético');
});
