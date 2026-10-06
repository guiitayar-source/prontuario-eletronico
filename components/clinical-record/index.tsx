'use client';
import { ImportedHistory } from '../imports';
import { ClinicalContextEditor } from '../clinical-context';
import { DocumentHistory, DocumentEditor } from '../documents';
import { PrescriptionWorkspace } from '../prescriptions';
import { PatientDetails } from '../patients/registry';
import Attachments from '../capture/desktop';
import { ConsultationDiagnoses } from '../diagnoses';
import { upsertDiagnosisBlock } from '@/lib/cid/evolution-block';
import { initials, age, type Patient } from '@/lib/patient-fields';
import { NavigationRail } from '../navigation-rail';
import {
  ChevronRight,
  PanelRightClose,
  PanelRightOpen,
  Check,
  FileText,
  Mic,
  ArrowUpRight,
  Timer,
} from 'lucide-react';
import { EvolutionSignatureDetailsModal } from '../evolution-signature-details-modal';
import { ConsultationTimer } from '../consultation-timer';
import { date, type RecordEntry } from './types';
import { EvolutionStatusBanner } from './status-banner';
import { EvolutionActions } from './actions';
import { RecordSidebar } from './sidebar';
import { AnamnesatorDialog, FinalizeDialog, AddendumDialog } from './dialogs';
import { DialogFrame } from '../dialog-frame';
import { useClinicalRecord } from './use-clinical-record';

export default function ClinicalRecord({
  patient,
  onHome,
  onAgenda,
  onUpdated,
  appointmentId,
  onSettings,
}: {
  patient: Patient;
  onHome: () => void;
  onAgenda: () => void;
  onUpdated: (p: Patient) => void;
  appointmentId?: string;
  onSettings?: () => void;
}) {
  const {
    medical,
    docs,
    clinicalContext,
    tab,
    setTab,
    rows,
    current,
    text,
    setText,
    setStatus,
    error,
    setError,
    busy,
    finalizing,
    panel,
    setPanel,
    addendum,
    setAddendum,
    setDirtyRegistration,
    signatureSession,
    signing,
    latest,
    blocked,
    dirty,
    choose,
    load,
    persist,
    handleSignEvolution,
    handleConnectAndSign,
    leave,
    create,
    append,
    hasImported,
    modal,
    setModal,
    openPrescription,
    closeModal,
    displayName,
    isSigned,
    isFinalizedUnsigned,
    finalized,
    ready,
    visitDate,
    timer,
    save,
    finish,
  } = useClinicalRecord({ patient, appointmentId });
  return (
    <div className="app-shell">
      <NavigationRail
        active="consultation"
        onAgenda={() => leave(onAgenda)}
        onPatients={() => leave(onHome)}
        onSettings={onSettings ? () => leave(onSettings) : undefined}
      />
      <div className="main-shell">
        <main>
          <div className="breadcrumb">
            <button onClick={() => leave(onAgenda)}>Consultório</button>
            <ChevronRight size={13} />
            <span>Atendimento</span>
          </div>
          <>
            <section className="patient-head">
              <div className="patient-title">
                <span className="avatar patient">{initials(displayName)}</span>
                <div>
                  <div className="eyebrow">CADASTRO DO PACIENTE</div>
                  <h1>{displayName}</h1>
                  <div className="patient-meta">
                    {age(patient.dob)} <span>•</span>{' '}
                    {patient.phone || 'Telefone não informado'}
                  </div>
                </div>
              </div>
              <ConsultationTimer timer={timer} visitDate={visitDate} />
            </section>
            <div className="patient-tabs">
              <button
                className={tab === 'consulta' ? 'selected' : ''}
                disabled={!medical}
                onClick={() => setTab('consulta')}
              >
                Consulta atual
              </button>
              <button
                className={tab === 'exames' ? 'selected' : ''}
                onClick={() => setTab('exames')}
              >
                Exames
              </button>
              <button
                className={tab === 'documentos' ? 'selected' : ''}
                onClick={() => setTab('documentos')}
              >
                Documentos
              </button>
              <button
                className={tab === 'cadastro' ? 'selected' : ''}
                onClick={() => setTab('cadastro')}
              >
                Cadastro
              </button>
              {medical && hasImported && (
                <button
                  className={tab === 'importados' ? 'selected' : ''}
                  onClick={() => setTab('importados')}
                >
                  Histórico importado
                </button>
              )}
              <div className="tabs-spacer" />
              {tab === 'consulta' && (
                <button onClick={() => setPanel(!panel)} aria-expanded={panel}>
                  {panel ? (
                    <PanelRightClose size={16} />
                  ) : (
                    <PanelRightOpen size={16} />
                  )}
                  <span>
                    {panel
                      ? 'Recolher painel lateral'
                      : 'Mostrar painel lateral'}
                  </span>
                </button>
              )}
            </div>
            <Attachments
              canCreateDocument={medical}
              key={patient.id}
              patient={patient}
              tab={tab}
              setTab={setTab}
              newDocument={(initialText) => {
                docs.open(undefined, current?.id, false, initialText);
                setModal('documento');
              }}
              newPrescription={medical ? openPrescription : undefined}
            />
            {medical && hasImported && tab === 'importados' && (
              <ImportedHistory key={patient.id} patientId={patient.id} />
            )}
            {medical && tab === 'documentos' && (
              <DocumentHistory
                docs={docs}
                onOpen={(d, duplicate) => {
                  docs.open(d, undefined, duplicate);
                  setModal(d.kind === 'Receita' ? 'receita' : 'documento');
                }}
              />
            )}
            <div hidden={tab !== 'cadastro'}>
              <PatientDetails
                patient={patient}
                onUpdated={onUpdated}
                onDirty={setDirtyRegistration}
              />
            </div>
            <div hidden={tab !== 'consulta' || !medical}>
              <div className={panel ? 'workspace' : 'workspace focused'}>
                <section className="editor-card">
                  <div className="editor-header">
                    <div>
                      <div className="eyebrow">{visitDate.toUpperCase()}</div>
                      <h2>Evolução da consulta</h2>
                    </div>
                    <button
                      className="secondary"
                      disabled={
                        busy ||
                        !!(
                          appointmentId &&
                          rows.some(
                            (r) =>
                              (r as RecordEntry & { appointment_id?: string })
                                .appointment_id === appointmentId,
                          )
                        )
                      }
                      onClick={() => leave(() => void create())}
                    >
                      Nova consulta
                    </button>
                    <span className="draft-chip">
                      {isSigned
                        ? '✓ Assinada (ICP-Brasil)'
                        : isFinalizedUnsigned
                          ? 'Finalizada (não assinada)'
                          : finalized
                            ? 'Finalizada'
                            : 'Rascunho'}
                    </span>
                  </div>
                  <div className="editor-toolbar">
                    <div className="editor-toolbar-left">
                      <span>
                        <FileText size={16} /> Texto livre
                      </span>
                      {ready && (
                        <span
                          className={`editor-timer-pill ${
                            finalized
                              ? 'finalized'
                              : timer.isPaused
                                ? 'paused'
                                : 'running'
                          }`}
                          title="Tempo decorrido do atendimento"
                        >
                          <Timer
                            size={13}
                            className={timer.isRunning ? 'ticking' : ''}
                          />
                          <span className="editor-timer-digits">
                            {timer.formattedDigits}
                          </span>
                          {!finalized && (
                            <span className="editor-timer-sub">
                              {timer.isPaused ? 'Pausado' : 'Em atendimento'}
                            </span>
                          )}
                        </span>
                      )}
                      {ready && !finalized && (
                        <button
                          type="button"
                          className="editor-insert-timer-btn"
                          title="Inserir tempo de atendimento no texto da evolução"
                          onClick={() => {
                            const tag = `[Tempo de atendimento: ${timer.formattedDigits}]`;
                            const next = text.trim()
                              ? `${text}\n\n${tag}`
                              : tag;
                            latest.current = next;
                            setText(next);
                            setStatus('Alterações pendentes');
                          }}
                        >
                          + Inserir tempo
                        </button>
                      )}
                    </div>
                    <button onClick={() => setModal('anamnesator')}>
                      <Mic size={16} /> Anamnesator <ArrowUpRight size={14} />
                    </button>
                  </div>
                  {error && (
                    <div className="capture-error" role="alert">
                      {error}
                      <p>
                        Seu texto permanece nesta tela. Copie-o antes de
                        recarregar se precisar preservá-lo.
                      </p>
                      <button
                        disabled={busy}
                        onClick={() => {
                          blocked.current = false;
                          void persist();
                        }}
                      >
                        Tentar salvar
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          leave(() => {
                            void load()
                              .then((list) => {
                                const r = list.find(
                                  (r) => r.id === current?.id,
                                );
                                if (r) choose(r);
                              })
                              .catch((e) => setError(e.message));
                          })
                        }
                      >
                        Recarregar do servidor
                      </button>
                    </div>
                  )}
                  <label className="sr-only" htmlFor="evolution">
                    Evolução em texto livre
                  </label>
                  <textarea
                    id="evolution"
                    value={text}
                    onChange={(e) => {
                      latest.current = e.target.value;
                      setText(e.target.value);
                      setStatus('Alterações pendentes');
                    }}
                    disabled={!ready}
                    readOnly={finalized || finalizing || isSigned || signing}
                    maxLength={100000}
                    placeholder={
                      current
                        ? 'Escreva livremente sobre o atendimento…'
                        : 'Clique em Nova consulta para começar…'
                    }
                    spellCheck
                  />
                  <EvolutionStatusBanner
                    current={current}
                    isSigned={isSigned}
                    isFinalizedUnsigned={isFinalizedUnsigned}
                    finalized={finalized}
                    hasSignatureSession={!!signatureSession}
                    busy={busy}
                    signing={signing}
                    onSign={() => void handleSignEvolution()}
                    onConnect={() => void handleConnectAndSign()}
                    onShowDetails={() => setModal('assinatura-detalhes')}
                  />
                  {current?.consultation_addenda?.map((a) => (
                    <article className="consultation-addendum" key={a.id}>
                      <strong>Adendo · {date(a.created_at)}</strong>
                      <p>{a.text}</p>
                      <details>
                        <summary>Autoria</summary>
                        {a.author_id}
                      </details>
                    </article>
                  ))}
                  <div className="editor-meta">
                    <span role="status">
                      <Check size={14} />
                      {save}
                    </span>
                    <span>
                      {text.trim() ? text.trim().split(/\s+/).length : 0}{' '}
                      palavras
                    </span>
                  </div>
                  <ConsultationDiagnoses
                    context={clinicalContext}
                    consultationId={current?.id}
                    locked={finalized}
                    onEvolutionBlock={(block) => {
                      const next = upsertDiagnosisBlock(latest.current, block);
                      if (next === latest.current) return;
                      latest.current = next;
                      setText(next);
                      setStatus('Alterações pendentes');
                    }}
                  />
                  <EvolutionActions
                    isSigned={isSigned}
                    isFinalizedUnsigned={isFinalizedUnsigned}
                    finalized={finalized}
                    hasSignatureSession={!!signatureSession}
                    busy={busy}
                    signing={signing}
                    ready={ready}
                    dirty={dirty}
                    hasText={!!text.trim()}
                    onNewDocument={() => {
                      docs.open(undefined, current?.id);
                      setModal('documento');
                    }}
                    onNewPrescription={openPrescription}
                    onShowDetails={() => setModal('assinatura-detalhes')}
                    onAddendum={() => setModal('reiniciar')}
                    onSaveDraft={() => void persist(false)}
                    onSign={() => void handleSignEvolution()}
                    onConnect={() => void handleConnectAndSign()}
                    onFinalizeUnsigned={() => setModal('finalizar')}
                  />
                </section>
                {panel && (
                  <RecordSidebar
                    context={clinicalContext}
                    onEditContext={() => setModal('contexto')}
                    rows={rows}
                    currentId={current?.id}
                    busy={busy}
                    onChoose={(r) => leave(() => choose(r))}
                  />
                )}
              </div>
              <div className="footnote">
                O rascunho é salvo automaticamente.
              </div>
            </div>
          </>
        </main>
      </div>
      {modal === 'assinatura-detalhes' && current && (
        <EvolutionSignatureDetailsModal
          evolutionId={current.id}
          onClose={closeModal}
        />
      )}
      {modal && modal !== 'assinatura-detalhes' && (
        <DialogFrame
          className={
            modal === 'contexto'
              ? 'modal context-modal'
              : modal === 'anamnesator'
                ? 'modal anamnesator-modal'
                : modal === 'documento'
                  ? 'modal document-modal'
                  : modal === 'receita'
                    ? 'modal document-modal prescription-modal'
                    : 'modal'
          }
          onClose={closeModal}
        >
          {modal === 'anamnesator' ? (
            <AnamnesatorDialog
              disabled={!current || finalized}
              onApply={(value, mode) => {
                const next =
                  mode === 'replace'
                    ? value
                    : [latest.current.trim(), value]
                        .filter(Boolean)
                        .join('\n\n');
                latest.current = next;
                setText(next);
                setStatus('Alterações pendentes');
                closeModal();
              }}
            />
          ) : modal === 'contexto' ? (
            <ClinicalContextEditor
              context={clinicalContext}
              onClose={closeModal}
            />
          ) : modal === 'finalizar' ? (
            <FinalizeDialog timer={timer} busy={busy} onConfirm={finish} />
          ) : modal === 'reiniciar' ? (
            <AddendumDialog
              value={addendum}
              busy={busy}
              onChange={setAddendum}
              onSubmit={() => void append().then(() => setModal(''))}
            />
          ) : modal === 'receita' ? (
            <PrescriptionWorkspace docs={docs} consultationId={current?.id} />
          ) : (
            <DocumentEditor docs={docs} />
          )}
        </DialogFrame>
      )}
    </div>
  );
}
