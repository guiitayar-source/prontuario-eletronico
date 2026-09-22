'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play, Square, WandSparkles } from 'lucide-react';

const BRIDGE = 'http://127.0.0.1:8767';
const CLIENT_HEADERS = { 'X-Anamnesator-Client': 'psywrite' };

type Provider = {
  id: string;
  label: string;
  configured: boolean;
  privacy: 'local' | 'api';
  models: { id: string; label: string }[];
};

type Capabilities = {
  transcription_providers: Provider[];
  draft_providers: Provider[];
  audio_retention: 'delete_after_processing' | 'owner_configured_local_copy';
};

type Props = {
  disabled: boolean;
  onApply: (text: string, mode: 'replace' | 'append') => void;
};

function extensionFor(type: string) {
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('mp4') || type.includes('m4a')) return '.m4a';
  return '.webm';
}

async function bridgeJson(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(CLIENT_HEADERS))
    headers.set(key, value);
  const response = await fetch(`${BRIDGE}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });
  const payload: unknown = await response.json();
  const result =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  if (!response.ok)
    throw new Error(
      typeof result.message === 'string'
        ? result.message
        : 'O Anamnesator não conseguiu concluir a operação.',
    );
  return result;
}

async function waitForJob(id: string, field: 'transcription' | 'anamnese') {
  for (;;) {
    const job = await bridgeJson(`/v1/jobs/${id}`);
    if (job.state === 'failed' || job.state === 'cancelled')
      throw new Error(
        typeof job.error === 'string'
          ? job.error
          : 'O processamento foi interrompido.',
      );
    if (job.state === 'completed') {
      const result = await bridgeJson(`/v1/jobs/${id}/result`);
      await bridgeJson(`/v1/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
      const value = result[field];
      if (typeof value !== 'string' || !value.trim())
        throw new Error('O Anamnesator devolveu um resultado vazio.');
      return value.trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export function AnamnesatorAssistant({ disabled, onApply }: Props) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Procurando o Anamnesator neste computador…');
  const [recording, setRecording] = useState<'idle' | 'recording' | 'paused' | 'ready'>('idle');
  const [audio, setAudio] = useState<Blob | null>(null);
  const [transcript, setTranscript] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [transcriptionProvider, setTranscriptionProvider] = useState('local');
  const [transcriptionModel, setTranscriptionModel] = useState('medium');
  const [draftProvider, setDraftProvider] = useState('local');
  const [draftModel, setDraftModel] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);

  const transcriptionProviders = capabilities?.transcription_providers ?? [];
  const draftProviders = capabilities?.draft_providers ?? [];
  const selectedTranscription = transcriptionProviders.find(
    (item) => item.id === transcriptionProvider,
  );
  const selectedDraft = draftProviders.find((item) => item.id === draftProvider);

  useEffect(() => {
    let active = true;
    bridgeJson('/v1/capabilities')
      .then((value) => {
        if (!active) return;
        const caps = value as Capabilities;
        setCapabilities(caps);
        const transcription = caps.transcription_providers.find((p) => p.configured);
        const generation = caps.draft_providers.find((p) => p.configured);
        if (transcription) {
          setTranscriptionProvider(transcription.id);
          setTranscriptionModel(transcription.models[0]?.id || '');
        }
        if (generation) {
          setDraftProvider(generation.id);
          setDraftModel(generation.models[0]?.id || '');
        }
        setStatus('Anamnesator conectado.');
      })
      .catch(() => {
        if (!active) return;
        setError('Abra o Anamnesator neste computador e tente novamente.');
        setStatus('Anamnesator indisponível.');
      });
    return () => {
      active = false;
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function startRecording() {
    setError('');
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      const next = new MediaRecorder(media, preferred ? { mimeType: preferred } : undefined);
      chunks.current = [];
      stream.current = media;
      recorder.current = next;
      next.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      next.onstop = () => {
        const blob = new Blob(chunks.current, { type: next.mimeType || 'audio/webm' });
        setAudio(blob);
        setRecording('ready');
        setStatus('Gravação pronta para transcrever.');
        media.getTracks().forEach((track) => track.stop());
      };
      next.start(1000);
      setAudio(null);
      setTranscript('');
      setDraft('');
      setRecording('recording');
      setStatus('Gravando…');
    } catch {
      setError('Não foi possível acessar o microfone. Confira a permissão do navegador.');
    }
  }

  function togglePause() {
    const current = recorder.current;
    if (!current) return;
    if (current.state === 'recording') {
      current.pause();
      setRecording('paused');
      setStatus('Gravação pausada.');
    } else if (current.state === 'paused') {
      current.resume();
      setRecording('recording');
      setStatus('Gravando…');
    }
  }

  function stopRecording() {
    if (recorder.current?.state !== 'inactive') recorder.current?.stop();
  }

  async function transcribe() {
    if (!audio || !selectedTranscription?.configured || !transcriptionModel) return;
    setBusy(true);
    setError('');
    setStatus(
      selectedTranscription.privacy === 'api'
        ? 'Enviando o áudio à API selecionada…'
        : 'Transcrevendo localmente…',
    );
    try {
      const metadata = JSON.stringify({
        provider: transcriptionProvider,
        model: transcriptionModel,
        extension: extensionFor(audio.type),
      });
      const job = await bridgeJson('/v1/transcriptions', {
        method: 'POST',
        headers: {
          'Content-Type': audio.type || 'application/octet-stream',
          'X-Anamnesator-Job': metadata,
        },
        body: audio,
      });
      if (typeof job.job_id !== 'string')
        throw new Error('O Anamnesator não devolveu um identificador válido.');
      setTranscript(await waitForJob(job.job_id, 'transcription'));
      setStatus('Transcrição recebida. Revise-a antes de gerar o rascunho.');
    } catch (cause) {
      setError((cause as Error).message);
      setStatus('Falha na transcrição.');
    } finally {
      setBusy(false);
    }
  }

  async function generateDraft() {
    if (!transcript.trim() || !selectedDraft?.configured || !draftModel) return;
    setBusy(true);
    setError('');
    setStatus(
      selectedDraft.privacy === 'api'
        ? 'Enviando a transcrição revisada à API selecionada…'
        : 'Gerando o rascunho localmente…',
    );
    try {
      const job = await bridgeJson('/v1/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: transcript.trim(),
          provider: draftProvider,
          model: draftModel,
        }),
      });
      if (typeof job.job_id !== 'string')
        throw new Error('O Anamnesator não devolveu um identificador válido.');
      setDraft(await waitForJob(job.job_id, 'anamnese'));
      setStatus('Rascunho recebido. Revise-o antes de inserir na evolução.');
    } catch (cause) {
      setError((cause as Error).message);
      setStatus('Falha na geração do rascunho.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="anamnesator-assistant">
      <output className="anamnesator-status">
        <span className={capabilities ? 'connected' : ''} /> {status}
      </output>
      {error && <div className="capture-error" role="alert">{error}</div>}

      <div className="anamnesator-grid">
        <label>
          Transcrição
          <select
            value={transcriptionProvider}
            disabled={busy || recording === 'recording' || recording === 'paused'}
            onChange={(event) => {
              const provider = transcriptionProviders.find((p) => p.id === event.target.value);
              setTranscriptionProvider(event.target.value);
              setTranscriptionModel(provider?.models[0]?.id || '');
            }}
          >
            {transcriptionProviders.map((provider) => (
              <option key={provider.id} value={provider.id} disabled={!provider.configured}>
                {provider.label}{provider.configured ? '' : ' · não configurado'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <select value={transcriptionModel} disabled={busy} onChange={(e) => setTranscriptionModel(e.target.value)}>
            {selectedTranscription?.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </label>
        <label>
          Rascunho clínico
          <select
            value={draftProvider}
            disabled={busy}
            onChange={(event) => {
              const provider = draftProviders.find((p) => p.id === event.target.value);
              setDraftProvider(event.target.value);
              setDraftModel(provider?.models[0]?.id || '');
            }}
          >
            {draftProviders.map((provider) => (
              <option key={provider.id} value={provider.id} disabled={!provider.configured}>
                {provider.label}{provider.configured ? '' : ' · não configurado'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <select value={draftModel} disabled={busy} onChange={(e) => setDraftModel(e.target.value)}>
            {selectedDraft?.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </label>
      </div>

      {(selectedTranscription?.privacy === 'api' || selectedDraft?.privacy === 'api') && (
        <div className="info-box">O conteúdo da etapa marcada como API será enviado ao provedor somente quando você acionar essa etapa.</div>
      )}
      <div className="anamnesator-retention">
        {capabilities?.audio_retention === 'owner_configured_local_copy'
          ? 'O proprietário configurou o Anamnesator para conservar uma cópia local do áudio neste computador.'
          : 'O áudio será apagado pelo Anamnesator depois do processamento.'}
      </div>

      <div className="anamnesator-controls">
        {recording === 'idle' || recording === 'ready' ? (
          <button type="button" className="secondary" disabled={!capabilities || busy} onClick={startRecording}>
            <Mic size={16} /> {recording === 'ready' ? 'Gravar novamente' : 'Iniciar gravação'}
          </button>
        ) : (
          <>
            <button type="button" className="secondary" onClick={togglePause}>
              {recording === 'paused' ? <Play size={16} /> : <Pause size={16} />}
              {recording === 'paused' ? 'Retomar' : 'Pausar'}
            </button>
            <button type="button" className="secondary" onClick={stopRecording}><Square size={16} /> Finalizar</button>
          </>
        )}
        <button
          type="button"
          className="primary"
          disabled={!audio || !selectedTranscription?.configured || !transcriptionModel || busy}
          onClick={transcribe}
        >
          Transcrever
        </button>
      </div>

      <label>
        Transcrição · revise antes de continuar
        <textarea value={transcript} disabled={busy} onChange={(e) => setTranscript(e.target.value)} placeholder="A transcrição aparecerá aqui." />
      </label>
      <button
        type="button"
        className="secondary anamnesator-generate"
        disabled={!transcript.trim() || !selectedDraft?.configured || !draftModel || busy}
        onClick={generateDraft}
      >
        <WandSparkles size={16} /> Gerar rascunho clínico
      </button>
      <label>
        Rascunho clínico · revise antes de inserir
        <textarea value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} placeholder="O rascunho aparecerá aqui." />
      </label>
      <div className="anamnesator-apply">
        <button type="button" className="secondary" disabled={!draft.trim() || disabled || busy} onClick={() => onApply(draft.trim(), 'append')}>Acrescentar à evolução</button>
        <button type="button" className="primary" disabled={!draft.trim() || disabled || busy} onClick={() => onApply(draft.trim(), 'replace')}>Substituir rascunho atual</button>
      </div>
    </div>
  );
}
