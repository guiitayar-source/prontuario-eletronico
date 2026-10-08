'use client';
import { useEffect } from 'react';
import {
  Mic,
  Minus,
  Pause,
  Play,
  Square,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import type { AnamnesatorSession } from './use-anamnesator-session';
import type { AnamnesatorTarget } from './index';

/**
 * Painel flutuante e não modal: o prontuário continua navegável por trás dele.
 * Minimizado, vira um indicador no canto enquanto houver sessão em andamento.
 */
export function AnamnesatorDock({
  session,
  target,
  open,
  onOpen,
  onMinimize,
}: {
  session: AnamnesatorSession;
  target: AnamnesatorTarget | null;
  open: boolean;
  onOpen: () => void;
  onMinimize: () => void;
}) {
  const { capabilities, connect } = session;
  useEffect(() => {
    if (open && !capabilities) void connect();
    // connect só depende de capabilities/connecting, lidos na própria função.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, capabilities]);

  if (!open) {
    if (!session.active) return null;
    return (
      <button
        type="button"
        className="anamnesator-pill"
        onClick={onOpen}
        title="Abrir o Anamnesator"
      >
        <span
          className={
            session.recording === 'recording' ? 'recording' : undefined
          }
        />
        Anamnesator · {session.summary}
        {session.patient && <small>{session.patient.name}</small>}
      </button>
    );
  }

  return (
    <section className="anamnesator-dock" aria-labelledby="anamnesator-title">
      <header>
        <Mic size={18} />
        <div>
          <h2 id="anamnesator-title">Anamnesator</h2>
          <p>
            {session.patient
              ? `Sessão de ${session.patient.name}`
              : 'Grave, transcreva e revise cada etapa antes de incorporar o texto ao prontuário.'}
          </p>
        </div>
        <button
          type="button"
          className="anamnesator-icon-button"
          aria-label="Minimizar o Anamnesator"
          title="Minimizar (a sessão continua)"
          onClick={onMinimize}
        >
          <Minus size={18} />
        </button>
      </header>
      <AnamnesatorPanel session={session} target={target} />
    </section>
  );
}

function AnamnesatorPanel({
  session,
  target,
}: {
  session: AnamnesatorSession;
  target: AnamnesatorTarget | null;
}) {
  const {
    capabilities,
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
  } = session;
  const capturing = recording === 'recording' || recording === 'paused';
  const samePatient = !!target && !!patient && target.patient.id === patient.id;
  const canApply = samePatient && !target.disabled && !!draft.trim() && !busy;

  function record() {
    if (!target) return;
    if (
      (audio || transcript.trim() || draft.trim()) &&
      !window.confirm(
        'Iniciar nova gravação descarta o áudio, a transcrição e o rascunho atuais. Continuar?',
      )
    )
      return;
    void session.startRecording(target.patient);
  }

  function apply(mode: 'replace' | 'append') {
    if (!canApply || !target) return;
    target.apply(draft.trim(), mode);
    session.discard();
  }

  function discard() {
    if (
      (audio || transcript.trim() || draft.trim()) &&
      !window.confirm('Descartar o áudio, a transcrição e o rascunho?')
    )
      return;
    session.discard();
  }

  return (
    <div className="anamnesator-assistant">
      <output className="anamnesator-status">
        <span className={capabilities ? 'connected' : ''} /> {status}
      </output>
      {error && (
        <div className="capture-error" role="alert">
          {error}
        </div>
      )}
      {patient && !samePatient && (
        <div className="info-box">
          Esta sessão pertence a {patient.name}. Abra o atendimento desse
          paciente para inserir o rascunho na evolução.
        </div>
      )}
      {!patient && !target && (
        <div className="info-box">
          Abra o atendimento de um paciente para iniciar a gravação.
        </div>
      )}

      <div className="anamnesator-grid">
        <label>
          Transcrição
          <select
            value={transcriptionProvider}
            disabled={busy || capturing}
            onChange={(event) => {
              const provider = transcriptionProviders.find(
                (p) => p.id === event.target.value,
              );
              setTranscriptionProvider(event.target.value);
              setTranscriptionModel(provider?.models[0]?.id || '');
            }}
          >
            {transcriptionProviders.map((provider) => (
              <option
                key={provider.id}
                value={provider.id}
                disabled={!provider.configured}
              >
                {provider.label}
                {provider.configured ? '' : ' · não configurado'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <select
            value={transcriptionModel}
            disabled={busy}
            onChange={(e) => setTranscriptionModel(e.target.value)}
          >
            {selectedTranscription?.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rascunho clínico
          <select
            value={draftProvider}
            disabled={busy}
            onChange={(event) => {
              const provider = draftProviders.find(
                (p) => p.id === event.target.value,
              );
              setDraftProvider(event.target.value);
              setDraftModel(provider?.models[0]?.id || '');
            }}
          >
            {draftProviders.map((provider) => (
              <option
                key={provider.id}
                value={provider.id}
                disabled={!provider.configured}
              >
                {provider.label}
                {provider.configured ? '' : ' · não configurado'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <select
            value={draftModel}
            disabled={busy}
            onChange={(e) => setDraftModel(e.target.value)}
          >
            {selectedDraft?.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {(selectedTranscription?.privacy === 'api' ||
        selectedDraft?.privacy === 'api') && (
        <div className="info-box">
          O conteúdo da etapa marcada como API será enviado ao provedor somente
          quando você acionar essa etapa.
        </div>
      )}
      <div className="anamnesator-retention">
        {capabilities?.audio_retention === 'owner_configured_local_copy'
          ? 'O proprietário configurou o Anamnesator para conservar uma cópia local do áudio neste computador.'
          : 'O áudio será apagado pelo Anamnesator depois do processamento.'}
      </div>

      <div className="anamnesator-controls">
        {capturing ? (
          <>
            <button
              type="button"
              className="secondary"
              onClick={session.togglePause}
            >
              {recording === 'paused' ? (
                <Play size={16} />
              ) : (
                <Pause size={16} />
              )}
              {recording === 'paused' ? 'Retomar' : 'Pausar'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={session.stopRecording}
            >
              <Square size={16} /> Finalizar
            </button>
          </>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={!capabilities || busy || !target}
            onClick={record}
          >
            <Mic size={16} />{' '}
            {recording === 'ready' ? 'Gravar novamente' : 'Iniciar gravação'}
          </button>
        )}
        <button
          type="button"
          className="primary"
          disabled={
            !audio ||
            !selectedTranscription?.configured ||
            !transcriptionModel ||
            busy
          }
          onClick={session.transcribe}
        >
          Transcrever
        </button>
        {session.active && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={discard}
          >
            <Trash2 size={16} /> Descartar
          </button>
        )}
      </div>

      <label>
        Transcrição · revise antes de continuar
        <textarea
          value={transcript}
          disabled={busy}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="A transcrição aparecerá aqui."
        />
      </label>
      <button
        type="button"
        className="secondary anamnesator-generate"
        disabled={
          !transcript.trim() ||
          !selectedDraft?.configured ||
          !draftModel ||
          busy
        }
        onClick={session.generateDraft}
      >
        <WandSparkles size={16} /> Gerar rascunho clínico
      </button>
      <label>
        Rascunho clínico · revise antes de inserir
        <textarea
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="O rascunho aparecerá aqui."
        />
      </label>
      <div className="anamnesator-apply">
        <button
          type="button"
          className="secondary"
          disabled={!canApply}
          onClick={() => apply('append')}
        >
          Acrescentar à evolução
        </button>
        <button
          type="button"
          className="primary"
          disabled={!canApply}
          onClick={() => apply('replace')}
        >
          Substituir rascunho atual
        </button>
      </div>
    </div>
  );
}
