'use client';
import { useEffect, useRef, useState } from 'react';
import { useAccess } from './auth';
import { ImportedHistory } from './imports';
import { FHIRExport } from './fhir-export';
import {
  useClinicalContext,
  ClinicalContextSummary,
  ClinicalContextEditor,
} from './clinical-context';
import { useDocuments, DocumentHistory, DocumentEditor } from './documents';
import { apiFetch } from '@/lib/supabase/http';
import { PatientDetails, PatientSearch } from './patients/registry';
import Attachments from './capture/desktop';
import { AnamnesatorAssistant } from './anamnesator-assistant';
import { DEMO_ID, initials, age, type Patient } from '@/lib/patient-fields';
import { TopBar } from './topbar';
import { NavigationRail } from './navigation-rail';
import {
  Activity,
  CalendarDays,
  Users,
  Search,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  Clock3,
  Check,
  FileText,
  Mic,
  X,
  ArrowUpRight,
  Stethoscope,
  LockKeyhole,
  ShieldCheck,
  FileCheck,
  KeyRound,
  Loader2,
} from 'lucide-react';
import { EvolutionSignatureDetailsModal } from './evolution-signature-details-modal';
import type { SignatureSessionData } from '@/lib/signature/types';

type RecordEntry = {
  id: string;
  text: string;
  version: number;
  created_at: string;
  finalized_at: string | null;
  author_id: string;
  finalized_by: string | null;
  status?: string;
  signed_at?: string | null;
  signed_by?: string | null;
  current_signature_id?: string | null;
  current_signature?: {
    id: string;
    signer_user_id: string;
    certificate_subject: string;
    certificate_issuer: string;
    certificate_serial: string;
    certificate_fingerprint: string;
    signed_at: string;
    verification_status: string;
    document_hash: string;
    provider: string;
    canonical_data?: Record<string, unknown>;
  } | null;
  consultation_addenda?: {
    id: string;
    text: string;
    author_id: string;
    created_at: string;
  }[];
};
async function request(patientId: string, action?: string, data?: unknown) {
  const r = await apiFetch(
    '/api/consultations?' +
      (action
        ? 'action=' + action
        : 'patientId=' + encodeURIComponent(patientId)),
    action
      ? {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Consultation-Action': '1',
          },
          body: JSON.stringify(data),
        }
      : undefined,
  );
  const result = (await r.json()) as {
    error?: string;
    consultations: RecordEntry[];
    consultation: RecordEntry;
  };
  if (!r.ok) throw new Error(result.error);
  return result;
}
const date = (v: string) =>
  new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
export default function ClinicalRecord({
  patient,
  onHome,
  onAgenda,
  onUpdated,
  onSelect,
  onOpenId,
  appointmentId,
  onSettings,
}: {
  patient: Patient;
  onHome: () => void;
  onAgenda: () => void;
  onUpdated: (p: Patient) => void;
  onSelect: (p: Patient) => void;
  onOpenId: (id: string) => void;
  appointmentId?: string;
  onSettings?: () => void;
}) {
  const medical = ['owner', 'doctor'].includes(useAccess().role);
  const docs = useDocuments(patient, medical);
  const clinicalContext = useClinicalContext(patient.id, medical);
  const [tab, setTab] = useState(() => {
    if (typeof window !== 'undefined') {
      const savedTab = sessionStorage.getItem('birdid_return_tab');
      if (savedTab) {
        sessionStorage.removeItem('birdid_return_tab');
        return savedTab;
      }
    }
    return medical ? 'consulta' : 'cadastro';
  }),
    [rows, setRows] = useState<RecordEntry[]>([]),
    [current, setCurrent] = useState<RecordEntry | null>(null),
    [text, setText] = useState(''),
    [status, setStatus] = useState('Carregando…'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [finalizing, setFinalizing] = useState(false),
    [panel, setPanel] = useState(true),
    [addendum, setAddendum] = useState(''),
    [dirtyRegistration, setDirtyRegistration] = useState(false),
    [signatureSession, setSignatureSession] = useState<SignatureSessionData | null>(null),
    [signing, setSigning] = useState(false);
  const saved = useRef(''),
    latest = useRef(''),
    flight = useRef(false),
    blocked = useRef(false),
    createId = useRef(crypto.randomUUID()),
    adId = useRef(crypto.randomUUID());
  const dirty = text !== saved.current;
  const hasUnsaved = dirty || !!addendum.trim() || docs.dirty;
  function choose(r: RecordEntry) {
    saved.current = r.text;
    latest.current = r.text;
    setText(r.text);
    setCurrent(r);
    blocked.current = false;
    setError('');
    setStatus(
      r.status === 'SIGNED' || r.signed_at
        ? 'Assinada digitalmente'
        : r.finalized_at
          ? 'Finalizada sem assinatura'
          : 'Salvo',
    );
    setAddendum('');
  }
  async function load() {
    const result = await request(patient.id);
    setRows(result.consultations);
    return result.consultations as RecordEntry[];
  }

  async function checkSignatureSession() {
    try {
      const r = await apiFetch('/api/digital-signature/session');
      if (r.ok) {
        const data = (await r.json()) as {
          active: boolean;
          session: SignatureSessionData | null;
        };
        setSignatureSession(data.active ? data.session : null);
      }
    } catch {
      // Ignore background check failure
    }
  }

  useEffect(() => {
    if (medical) {
      void checkSignatureSession();
    }
  }, [medical]);

  useEffect(() => {
    let active = true;
    if (medical)
      request(patient.id)
        .then((result) => {
          if (active) {
            setRows(result.consultations);
            setStatus('Escolha uma consulta ou inicie uma nova.');
            const returnEvoId =
              typeof window !== 'undefined'
                ? sessionStorage.getItem('birdid_return_evolution_id')
                : null;
            if (returnEvoId) {
              sessionStorage.removeItem('birdid_return_evolution_id');
            }
            const match = result.consultations.find(
              (r: RecordEntry & { appointment_id?: string }) =>
                returnEvoId
                  ? r.id === returnEvoId
                  : appointmentId
                    ? r.appointment_id === appointmentId
                    : !r.finalized_at && r.status !== 'SIGNED',
            );
            if (match) choose(match);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [patient.id, medical, appointmentId]);

  async function persist(finalize = false) {
    if (
      !current ||
      flight.current ||
      blocked.current ||
      current.finalized_at ||
      current.status === 'SIGNED' ||
      current.signed_at
    )
      return;
    flight.current = true;
    setFinalizing(finalize);
    setBusy(true);
    setStatus('Salvando…');
    const snapshot = latest.current;
    try {
      const result = await request(patient.id, finalize ? 'finalize' : 'save', {
        id: current.id,
        version: current.version,
        text: snapshot,
      });
      saved.current = snapshot;
      setCurrent(result.consultation);
      setRows((old) =>
        old.map((r) =>
          r.id === current.id ? { ...r, ...result.consultation } : r,
        ),
      );
      setStatus(latest.current === snapshot ? 'Salvo' : 'Alterações pendentes');
      setError('');
    } catch (e) {
      blocked.current = true;
      setError((e as Error).message);
      setStatus('Não salvo — seu texto permanece nesta tela');
    } finally {
      flight.current = false;
      setFinalizing(false);
      setBusy(false);
    }
  }

  async function handleSignEvolution() {
    if (!current || busy || signing) return;
    setError('');
    setSigning(true);
    setStatus('Assinando evolução com certificado Bird ID…');
    try {
      // Salva rascunho apenas se a consulta ainda não estiver finalizada
      if (dirty && !current.finalized_at) {
        await persist(false);
      }
      const r = await apiFetch('/api/digital-signature/sign-evolution', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Action': '1',
        },
        body: JSON.stringify({ evolutionId: current.id }),
      });
      const data = (await r.json()) as {
        error?: string;
        success?: boolean;
      };
      if (!r.ok) {
        throw new Error(data.error || 'Falha ao assinar evolução digitalmente.');
      }
      const list = await load();
      const updated = list.find((item) => item.id === current.id);
      if (updated) choose(updated);
      setStatus('Evolução assinada digitalmente com sucesso!');
    } catch (e) {
      setError((e as Error).message);
      setStatus('Erro na assinatura digital');
    } finally {
      setSigning(false);
    }
  }

  async function handleConnectAndSign() {
    if (!current) return;
    try {
      if (dirty && !current.finalized_at) {
        await persist(false);
      }
      if (typeof window !== 'undefined' && patient?.id) {
        sessionStorage.setItem('birdid_return_patient_id', patient.id);
        sessionStorage.setItem('birdid_return_tab', 'consulta');
        sessionStorage.setItem('birdid_return_evolution_id', current.id);
      }
      const r = await apiFetch('/api/digital-signature/birdid/authorize');
      const data = (await r.json()) as {
        authorizationUrl?: string;
        error?: string;
      };
      if (!r.ok)
        throw new Error(data.error || 'Falha ao iniciar autorização Bird ID');
      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (
      !dirty ||
      busy ||
      signing ||
      !current ||
      current.finalized_at ||
      current.status === 'SIGNED' ||
      current.signed_at ||
      blocked.current
    )
      return;
    const timer = setTimeout(() => void persist(), 800);
    return () => clearTimeout(timer);
  }, [text, current, busy, signing]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsaved || busy || dirtyRegistration) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsaved, busy, dirtyRegistration]);
  function leave(action: () => void) {
    if (busy || docs.busy) return;
    if (
      (hasUnsaved || dirtyRegistration) &&
      !window.confirm('Há alterações não salvas. Sair e descartá-las?')
    )
      return;
    action();
  }
  async function create() {
    setBusy(true);
    try {
      const r = await request(patient.id, 'create', {
        id: createId.current,
        patient_id: patient.id,
        appointment_id: appointmentId,
      });
      choose(r.consultation);
      createId.current = crypto.randomUUID();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function append() {
    if (!current) return;
    setBusy(true);
    try {
      await request(patient.id, 'addendum', {
        id: current.id,
        addendum_id: adId.current,
        text: addendum,
      });
      adId.current = crypto.randomUUID();
      const list = await load();
      choose(list.find((r) => r.id === current.id)!);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [modal, setModal] = useState('');
  function closeModal() {
    if (modal === 'documento' && !docs.close()) return;
    setModal('');
  }
  const [view, setView] = useState('consulta');
  const displayName = patient.social_name || patient.name;
  const isSigned =
    current?.status === 'SIGNED' ||
    !!current?.signed_at ||
    !!current?.current_signature_id;
  const isFinalizedUnsigned = !!current?.finalized_at && !isSigned;
  const finalized = !!current?.finalized_at || isSigned;
  const ready = !!current;
  const visitDate = new Date(
    current?.created_at || Date.now(),
  ).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const save = status;
  async function finish() {
    await persist(true);
    closeModal();
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (modal === 'documento' && !docs.close()) return;
        setModal('busca');
      }
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modal, docs.dirty, docs.busy]);
  useEffect(() => {
    if (!modal) return;
    const oldOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    return () => {
      window.document.body.style.overflow = oldOverflow;
    };
  }, [modal]);
  return (
    <div className="app-shell">
      <NavigationRail
        active="consultation"
        onAgenda={() => leave(onAgenda)}
        onPatients={() => leave(onHome)}
        onSettings={onSettings ? () => leave(onSettings) : undefined}
      />
      <div className="main-shell">
        <TopBar onOpenSearch={() => setModal('busca')} />
        <main>
          <div className="breadcrumb">
            <button onClick={() => leave(onAgenda)}>Consultório</button>
            <ChevronRight size={13} />
            <span>
              {view === 'consulta'
                ? 'Atendimento'
                : view === 'agenda'
                  ? 'Agenda'
                  : 'Pacientes'}
            </span>
          </div>
          {view === 'consulta' ? (
            <>
              <section className="patient-head">
                <div className="patient-title">
                  <span className="avatar patient">
                    {initials(displayName)}
                  </span>
                  <div>
                    <div className="eyebrow">CADASTRO DO PACIENTE</div>
                    <h1>{displayName}</h1>
                    <div className="patient-meta">
                      {age(patient.dob)} <span>•</span>{' '}
                      {patient.phone || 'Telefone não informado'}
                    </div>
                  </div>
                </div>
                <div className="encounter-badge">
                  <span className="dot" />
                  {finalized
                    ? 'Finalizada'
                    : current
                      ? 'Em atendimento'
                      : 'Nova consulta'}
                  <small>{visitDate}</small>
                </div>
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
                {medical && (
                  <button
                    className={tab === 'importados' ? 'selected' : ''}
                    onClick={() => setTab('importados')}
                  >
                    Histórico importado
                  </button>
                )}
                <div className="tabs-spacer" />
                {medical && (
                  <FHIRExport
                    key={patient.id}
                    patientId={patient.id}
                    patientName={displayName}
                  />
                )}
                {tab === 'consulta' && (
                  <button
                    onClick={() => setPanel(!panel)}
                    aria-expanded={panel}
                  >
                    {panel ? (
                      <PanelLeftClose size={16} />
                    ) : (
                      <PanelLeftOpen size={16} />
                    )}
                    <span>
                      {panel ? 'Recolher histórico' : 'Mostrar histórico'}
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
              />
              {medical && tab === 'importados' && (
                <ImportedHistory key={patient.id} patientId={patient.id} />
              )}
              {medical && tab === 'documentos' && (
                <DocumentHistory
                  docs={docs}
                  onOpen={(d, duplicate) => {
                    docs.open(d, undefined, duplicate);
                    setModal('documento');
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
                  {panel && (
                    <aside className="clinical-sidebar">
                      <ClinicalContextSummary
                        context={clinicalContext}
                        onEdit={() => setModal('contexto')}
                      />
                      <section className="history-card">
                        <div className="card-heading">
                          <span>
                            <Clock3 size={16} /> Histórico de consultas
                          </span>
                        </div>
                        {!rows.length && (
                          <p className="muted">Nenhuma consulta registrada.</p>
                        )}
                        {rows.map((r) => (
                          <button
                            key={r.id}
                            className="consultation-history-link"
                            aria-current={
                              current?.id === r.id ? 'true' : undefined
                            }
                            disabled={busy}
                            onClick={() => leave(() => choose(r))}
                          >
                            <span className="history-date">
                              {date(r.created_at)}
                            </span>
                            <strong>
                              {r.status === 'SIGNED' || r.signed_at
                                ? '✓ Assinada digitalmente'
                                : r.finalized_at
                                  ? 'Finalizada (não assinada)'
                                  : 'Em atendimento'}
                            </strong>
                            <span>
                              {r.text.slice(0, 150) || 'Rascunho vazio'}
                              {r.text.length > 150 ? '…' : ''}
                            </span>
                          </button>
                        ))}
                      </section>
                    </aside>
                  )}
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
                      <span>
                        <FileText size={16} /> Texto livre
                      </span>
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
                    {isSigned ? (
                      <div className="signed-evolution-banner">
                        <div className="signed-badge-header">
                          <ShieldCheck size={20} className="signed-badge-icon" />
                          <div>
                            <strong>Evolução assinada digitalmente (ICP-Brasil)</strong>
                            <p>
                              Assinada em {date(current.signed_at || current.created_at)}
                              {current.current_signature?.certificate_subject
                                ? ` por ${current.current_signature.certificate_subject.match(/CN=([^,\n/]+)/i)?.[1] || current.current_signature.certificate_subject}`
                                : ''}
                              . Registro eletrônico nativo imutável.
                            </p>
                          </div>
                          <button
                            type="button"
                            className="secondary compact-btn"
                            onClick={() => setModal('assinatura-detalhes')}
                          >
                            <FileCheck size={15} /> Ver detalhes da assinatura
                          </button>
                        </div>
                      </div>
                    ) : isFinalizedUnsigned ? (
                      <div className="unsigned-finalized-banner">
                        <div className="unsigned-finalized-header">
                          <div className="unsigned-badge-icon">
                            <KeyRound size={20} />
                          </div>
                          <div className="unsigned-badge-text">
                            <strong>Consulta finalizada sem assinatura digital</strong>
                            <p>
                              Finalizada em {current?.finalized_at && date(current.finalized_at)}.
                              Você pode assinar este registro eletrônico agora com seu certificado digital ICP-Brasil.
                            </p>
                          </div>
                          {signatureSession ? (
                            <button
                              type="button"
                              className="primary signature-btn compact-btn"
                              disabled={busy || signing}
                              onClick={() => void handleSignEvolution()}
                            >
                              {signing ? (
                                <>
                                  <Loader2 size={14} className="spin" /> Assinando…
                                </>
                              ) : (
                                <>
                                  <ShieldCheck size={15} /> Assinar agora (ICP-Brasil)
                                </>
                              )}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="primary signature-connect-btn compact-btn"
                              disabled={busy || signing}
                              onClick={() => void handleConnectAndSign()}
                            >
                              <KeyRound size={15} /> Conectar Bird ID para assinar
                            </button>
                          )}
                        </div>
                      </div>
                    ) : finalized ? (
                      <div className="finalized-info">
                        <LockKeyhole size={15} /> Finalizada em{' '}
                        {current?.finalized_at && date(current.finalized_at)}.
                        Correções por adendos. Sem assinatura digital.
                      </div>
                    ) : null}
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
                    <footer className="editor-actions">
                      <button
                        className="secondary"
                        onClick={() => {
                          docs.open(undefined, current?.id);
                          setModal('documento');
                        }}
                      >
                        <FileText size={16} /> Novo documento
                      </button>
                      {isSigned ? (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setModal('assinatura-detalhes')}
                          >
                            <FileCheck size={16} /> Detalhes da assinatura
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setModal('reiniciar')}
                          >
                            Registrar adendo
                          </button>
                        </>
                      ) : isFinalizedUnsigned ? (
                        <div className="editor-action-buttons">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setModal('reiniciar')}
                          >
                            Registrar adendo
                          </button>

                          {signatureSession ? (
                            <button
                              type="button"
                              className="primary signature-btn"
                              disabled={busy || signing}
                              onClick={() => void handleSignEvolution()}
                            >
                              {signing ? (
                                <>
                                  <Loader2 size={16} className="spin" /> Assinando ICP-Brasil…
                                </>
                              ) : (
                                <>
                                  <ShieldCheck size={17} /> Assinar evolução (ICP-Brasil)
                                </>
                              )}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="primary signature-connect-btn"
                              disabled={busy || signing}
                              onClick={() => void handleConnectAndSign()}
                            >
                              <KeyRound size={17} /> Conectar Bird ID para assinar
                            </button>
                          )}
                        </div>
                      ) : finalized ? (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setModal('reiniciar')}
                        >
                          Registrar adendo
                        </button>
                      ) : (
                        <div className="editor-action-buttons">
                          <button
                            type="button"
                            className="secondary"
                            disabled={!ready || busy || signing || !dirty}
                            onClick={() => void persist(false)}
                          >
                            Salvar rascunho
                          </button>

                          {signatureSession ? (
                            <button
                              type="button"
                              className="primary signature-btn"
                              disabled={!ready || busy || signing || !text.trim()}
                              onClick={() => void handleSignEvolution()}
                            >
                              {signing ? (
                                <>
                                  <Loader2 size={16} className="spin" /> Assinando ICP-Brasil…
                                </>
                              ) : (
                                <>
                                  <ShieldCheck size={17} /> Finalizar e assinar
                                </>
                              )}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="primary signature-connect-btn"
                              disabled={!ready || busy || signing || !text.trim()}
                              onClick={() => void handleConnectAndSign()}
                            >
                              <KeyRound size={17} /> Conectar Bird ID para assinar
                            </button>
                          )}

                          <button
                            type="button"
                            className="ghost-button"
                            style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}
                            disabled={!ready || busy || signing || !text.trim()}
                            onClick={() => setModal('finalizar')}
                            title="Finalizar consulta sem aplicar assinatura digital ICP-Brasil"
                          >
                            Finalizar sem assinar
                          </button>
                        </div>
                      )}
                    </footer>
                  </section>
                </div>
                <div className="footnote">
                  Ambiente de demonstração. Use apenas dados fictícios. O
                  rascunho é salvo no Supabase.
                </div>
              </div>
            </>
          ) : (
            <section className="listing">
              <div className="listing-heading">
                <div className="eyebrow">CONSULTÓRIO · DEMONSTRAÇÃO</div>
                <h1>{view === 'agenda' ? 'Agenda do dia' : 'Pacientes'}</h1>
                <p>
                  {view === 'agenda'
                    ? 'Terça-feira, 08 de setembro de 2026'
                    : 'Cadastro fictício para experimentar o atendimento.'}
                </p>
              </div>
              <button
                className="appointment"
                onClick={() => leave(() => onOpenId(DEMO_ID))}
              >
                <span className="time">
                  09:00<small>09:50</small>
                </span>
                <span className="avatar patient">HC</span>
                <span className="appointment-name">
                  Helena Costa<small>Retorno · paciente fictícia</small>
                </span>
                <span className="open-label">
                  Abrir consulta <ChevronRight size={18} />
                </span>
              </button>
              <div className="empty-agenda">
                {view === 'agenda'
                  ? 'Nenhum outro atendimento neste dia de demonstração.'
                  : '1 paciente fictícia cadastrada.'}
              </div>
            </section>
          )}
        </main>
      </div>
      {modal === 'assinatura-detalhes' && current && (
        <EvolutionSignatureDetailsModal
          evolutionId={current.id}
          onClose={closeModal}
        />
      )}
      {modal && modal !== 'assinatura-detalhes' && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <section
            className={
              modal === 'contexto'
                ? 'modal context-modal'
                : modal === 'anamnesator'
                  ? 'modal anamnesator-modal'
                : modal === 'documento'
                  ? 'modal document-modal'
                  : 'modal'
            }
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                const nodes = e.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), input, textarea, select',
                );
                const first = nodes[0],
                  last = nodes[nodes.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <button
              className="close"
              autoFocus
              aria-label="Fechar"
              onClick={closeModal}
            >
              <X size={20} />
            </button>
            {modal === 'busca' ? (
              <>
                <h2 id="dialog-title">Buscar paciente</h2>
                <PatientSearch
                  compact
                  onOpen={(p) => {
                    closeModal();
                    leave(() => onSelect(p));
                  }}
                />
              </>
            ) : modal === 'anamnesator' ? (
              <>
                <div className="modal-icon">
                  <Mic />
                </div>
                <h2 id="dialog-title">Anamnesator</h2>
                <p>Grave, transcreva e revise cada etapa antes de incorporar o texto ao prontuário.</p>
                <AnamnesatorAssistant
                  disabled={!current || finalized}
                  onApply={(value, mode) => {
                    const next = mode === 'replace' ? value : [latest.current.trim(), value].filter(Boolean).join('\n\n');
                    latest.current = next;
                    setText(next);
                    setStatus('Alterações pendentes');
                    closeModal();
                  }}
                />
              </>
            ) : modal === 'contexto' ? (
              <ClinicalContextEditor
                context={clinicalContext}
                onClose={closeModal}
              />
            ) : modal === 'finalizar' ? (
              <>
                <h2 id="dialog-title">Finalizar esta consulta?</h2>
                <p>
                  O texto ficará bloqueado para edição. Correções posteriores
                  serão registradas como adendos.
                </p>
                <div className="info-box">
                  Esta ação não aplica assinatura digital nem cria um prontuário
                  válido para uso clínico.
                </div>
                <button className="primary" disabled={busy} onClick={finish}>
                  Confirmar finalização
                </button>
              </>
            ) : modal === 'reiniciar' ? (
              <>
                <h2 id="dialog-title">Registrar adendo</h2>
                <p>
                  O texto original será preservado. O adendo registrará autor e
                  horário.
                </p>
                <textarea
                  className="document-editor"
                  aria-label="Novo adendo"
                  value={addendum}
                  maxLength={100000}
                  disabled={busy}
                  onChange={(e) => setAddendum(e.target.value)}
                />
                <button
                  className="primary"
                  disabled={busy || !addendum.trim()}
                  onClick={() => void append().then(() => setModal(''))}
                >
                  Registrar adendo
                </button>
              </>
            ) : (
              <DocumentEditor docs={docs} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
