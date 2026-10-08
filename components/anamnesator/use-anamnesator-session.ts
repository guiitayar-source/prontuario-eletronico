'use client';
import { useEffect, useRef, useState } from 'react';
import {
  bridgeJson,
  extensionFor,
  waitForJob,
  type Capabilities,
} from './client';

/** Paciente a quem pertencem a gravação, a transcrição e o rascunho. */
export type SessionPatient = { id: string; name: string };

/**
 * Sessão do Anamnesator: gravação, transcrição e rascunho. Fica montada acima das telas
 * (ver `AnamnesatorProvider`), então sobrevive a fechar o painel e a navegar pelo app;
 * só termina ao descartar, ao inserir na evolução ou ao recarregar a página.
 */
export function useAnamnesatorSession() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [patient, setPatient] = useState<SessionPatient | null>(null);
  const [recording, setRecording] = useState<
    'idle' | 'recording' | 'paused' | 'ready'
  >('idle');
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
  const selectedDraft = draftProviders.find(
    (item) => item.id === draftProvider,
  );
  /** Há algo que se perderia ao recarregar a página. */
  const active =
    recording !== 'idle' || busy || !!audio || !!transcript || !!draft;

  useEffect(
    () => () => stream.current?.getTracks().forEach((track) => track.stop()),
    [],
  );

  useEffect(() => {
    if (!active) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);

  /** Procura a ponte local; chamado ao abrir o painel enquanto não houver conexão. */
  async function connect() {
    if (capabilities || connecting) return;
    setConnecting(true);
    setError('');
    setStatus('Procurando o Anamnesator neste computador…');
    try {
      const caps = (await bridgeJson('/v1/capabilities')) as Capabilities;
      setCapabilities(caps);
      const transcription = caps.transcription_providers.find(
        (p) => p.configured,
      );
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
    } catch {
      setError('Abra o Anamnesator neste computador e tente novamente.');
      setStatus('Anamnesator indisponível.');
    } finally {
      setConnecting(false);
    }
  }

  /** Para o microfone sem aproveitar o que foi gravado. */
  function releaseRecorder() {
    const current = recorder.current;
    recorder.current = null;
    if (current && current.state !== 'inactive') current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }

  async function startRecording(owner: SessionPatient) {
    setError('');
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const next = new MediaRecorder(
        media,
        preferred ? { mimeType: preferred } : undefined,
      );
      releaseRecorder();
      chunks.current = [];
      stream.current = media;
      recorder.current = next;
      next.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      next.onstop = () => {
        media.getTracks().forEach((track) => track.stop());
        // Gravação descartada ou substituída: não vira áudio da sessão.
        if (recorder.current !== next) return;
        const blob = new Blob(chunks.current, {
          type: next.mimeType || 'audio/webm',
        });
        setAudio(blob);
        setRecording('ready');
        setStatus('Gravação pronta para transcrever.');
      };
      next.start(1000);
      setPatient(owner);
      setAudio(null);
      setTranscript('');
      setDraft('');
      setRecording('recording');
      setStatus('Gravando…');
    } catch {
      setError(
        'Não foi possível acessar o microfone. Confira a permissão do navegador.',
      );
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
    if (recorder.current && recorder.current.state !== 'inactive')
      recorder.current.stop();
  }

  /** Encerra a sessão e apaga da memória áudio, transcrição e rascunho. */
  function discard() {
    if (busy) return;
    releaseRecorder();
    chunks.current = [];
    setPatient(null);
    setAudio(null);
    setTranscript('');
    setDraft('');
    setRecording('idle');
    setError('');
    setStatus(capabilities ? 'Anamnesator conectado.' : '');
  }

  async function transcribe() {
    if (!audio || !selectedTranscription?.configured || !transcriptionModel)
      return;
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

  /** Resumo curto para o botão do atendimento e para o indicador flutuante. */
  const summary =
    recording === 'recording'
      ? 'Gravando'
      : recording === 'paused'
        ? 'Pausado'
        : busy
          ? 'Processando'
          : draft
            ? 'Rascunho pronto'
            : transcript
              ? 'Transcrição pronta'
              : audio
                ? 'Gravação pronta'
                : '';

  return {
    capabilities,
    connecting,
    connect,
    error,
    status,
    patient,
    recording,
    audio,
    transcript,
    setTranscript,
    draft,
    setDraft,
    busy,
    active,
    summary,
    transcriptionProviders,
    draftProviders,
    selectedTranscription,
    selectedDraft,
    transcriptionProvider,
    setTranscriptionProvider,
    transcriptionModel,
    setTranscriptionModel,
    draftProvider,
    setDraftProvider,
    draftModel,
    setDraftModel,
    startRecording,
    togglePause,
    stopRecording,
    discard,
    transcribe,
    generateDraft,
  };
}

export type AnamnesatorSession = ReturnType<typeof useAnamnesatorSession>;
