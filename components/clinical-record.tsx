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
import { DEMO_ID, initials, age, type Patient } from '@/lib/patient-fields';
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
} from 'lucide-react';
type RecordEntry = {
  id: string;
  text: string;
  version: number;
  created_at: string;
  finalized_at: string | null;
  author_id: string;
  finalized_by: string | null;
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
  const [tab, setTab] = useState(medical ? 'consulta' : 'cadastro'),
    [rows, setRows] = useState<RecordEntry[]>([]),
    [current, setCurrent] = useState<RecordEntry | null>(null),
    [text, setText] = useState(''),
    [status, setStatus] = useState('Carregando…'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [finalizing, setFinalizing] = useState(false),
    [panel, setPanel] = useState(true),
    [addendum, setAddendum] = useState(''),
    [dirtyRegistration, setDirtyRegistration] = useState(false);
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
    setStatus('Salvo');
    setAddendum('');
  }
  async function load() {
    const result = await request(patient.id);
    setRows(result.consultations);
    return result.consultations as RecordEntry[];
  }
  useEffect(() => {
    let active = true;
    if (medical)
      request(patient.id)
        .then((result) => {
          if (active) {
            setRows(result.consultations);
            setStatus('Escolha uma consulta ou inicie uma nova.');
            const match = result.consultations.find(
              (r: RecordEntry & { appointment_id?: string }) =>
                appointmentId
                  ? r.appointment_id === appointmentId
                  : !r.finalized_at,
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
    if (!current || flight.current || blocked.current || current.finalized_at)
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
  useEffect(() => {
    if (!dirty || busy || !current || current.finalized_at || blocked.current)
      return;
    const timer = setTimeout(() => void persist(), 800);
    return () => clearTimeout(timer);
  }, [text, current, busy]);
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
  const finalized = !!current?.finalized_at;
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
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
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
      <aside className="rail">
        <div className="brand">
          <Activity size={23} />
        </div>
        <nav aria-label="Navegação principal">
          {[
            { id: 'agenda', icon: CalendarDays, label: 'Agenda' },
            { id: 'pacientes', icon: Users, label: 'Pacientes' },
            { id: 'consulta', icon: Stethoscope, label: 'Consulta' },
            ...(onSettings
              ? [{ id: 'ajustes', icon: Palette, label: 'Ajustes' }]
              : []),
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              className={view === id ? 'nav-item active' : 'nav-item'}
              onClick={() =>
                id === 'pacientes'
                  ? leave(onHome)
                  : id === 'agenda'
                    ? leave(onAgenda)
                    : id === 'ajustes'
                      ? leave(onSettings!)
                      : setView(id)
              }
              aria-current={view === id ? 'page' : undefined}
            >
              <Icon size={21} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <span className="avatar doctor">G</span>
          <span>{medical ? 'Médico' : 'Administrativo'}</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="wordmark">
            meu prontuário<span>CONSULTÓRIO</span>
          </div>
          <button className="search" onClick={() => setModal('busca')}>
            <Search size={16} /> Buscar paciente <kbd>Ctrl K</kbd>
          </button>
          <span className="demo-label">Protótipo · dados fictícios</span>
        </header>
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
                              {r.finalized_at
                                ? 'Consulta finalizada'
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
                        {finalized ? 'Finalizada' : 'Rascunho'}
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
                      readOnly={finalized || finalizing}
                      maxLength={100000}
                      placeholder={
                        current
                          ? 'Escreva livremente sobre o atendimento…'
                          : 'Clique em Nova consulta para começar…'
                      }
                      spellCheck
                    />
                    {finalized && (
                      <div className="finalized-info">
                        <LockKeyhole size={15} /> Finalizada em{' '}
                        {current?.finalized_at && date(current.finalized_at)}.
                        Correções por adendos. Sem assinatura digital.
                      </div>
                    )}
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
                      {finalized ? (
                        <button
                          className="secondary"
                          onClick={() => setModal('reiniciar')}
                        >
                          Registrar adendo
                        </button>
                      ) : (
                        <button
                          className="primary"
                          disabled={
                            !ready || busy || !text.trim() || blocked.current
                          }
                          onClick={() => setModal('finalizar')}
                        >
                          Finalizar consulta <Check size={17} />
                        </button>
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
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <section
            className={modal === 'contexto' ? 'modal context-modal' : 'modal'}
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
                <p>
                  Este será o ponto de integração com o aplicativo que você já
                  utiliza.
                </p>
                <ol>
                  <li>Receber a transcrição do Anamnesator.</li>
                  <li>Revisar e editar a transcrição.</li>
                  <li>Gerar e revisar o rascunho da evolução.</li>
                  <li>Incorporar o texto aprovado à consulta.</li>
                </ol>
                <div className="info-box">
                  Integração ainda não conectada. Nenhum áudio é capturado ou
                  enviado neste protótipo.
                </div>
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
