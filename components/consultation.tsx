'use client';
import { PatientDetails, PatientSearch } from '@/components/patients/registry';
import { DEMO_ID, initials, age, type Patient } from '@/lib/patient-fields';
import Attachments from '@/components/capture/desktop';
import { useEffect, useState } from 'react';
import {
  Activity,
  CalendarDays,
  Users,
  Search,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Clock3,
  Check,
  FileText,
  Mic,
  X,
  ArrowUpRight,
  Stethoscope,
  LockKeyhole,
} from 'lucide-react';

const initial =
  'Retorno de acompanhamento. Paciente relata melhora na organização da rotina e na qualidade do sono desde a última consulta. Mantém atividades habituais e acompanhamento psicoterápico.\n\nConversamos sobre as mudanças percebidas no período e as dificuldades que ainda permanecem.\n\n';
const history = [
  {
    date: '11 ago 2026',
    title: 'Consulta de retorno',
    text: 'Paciente refere sono irregular e dificuldade para manter uma rotina de atividades. Relata boa adesão ao acompanhamento. Discutidas estratégias para organizar horários e acompanhar a evolução dos sintomas.',
    plan: 'Manter acompanhamento e reavaliar no próximo retorno. Combinado registro do sono ao longo das semanas.',
  },
  {
    date: '14 jul 2026',
    title: 'Primeira consulta',
    text: 'Primeiro atendimento. Realizado levantamento da história clínica e do contexto atual. Paciente descreve dificuldades de sono e de concentração nas atividades cotidianas.',
    plan: 'Estabelecido plano de acompanhamento e orientado retorno para avaliação longitudinal.',
  },
];
type Saved = { text: string; finalized: boolean };
export default function Consultation({
  patient,
  onHome,
  onUpdated,
  onSelect,
  onOpenId,
  onAgenda,
}: {
  patient: Patient;
  onHome: () => void;
  onUpdated: (p: Patient) => void;
  onSelect: (p: Patient) => void;
  onOpenId: (id: string) => void;
  onAgenda: () => void;
}) {
  const isDemo = patient.id === DEMO_ID;
  const storageKey = 'prontuario-draft-' + patient.draft_key;
  const displayName = patient.social_name || patient.name;
  const visitDate = isDemo
    ? '08 set 2026'
    : new Date().toLocaleDateString('pt-BR');
  const [dirtyRegistration, setDirtyRegistration] = useState(false);
  function leave(action: () => void) {
    if (
      !dirtyRegistration ||
      window.confirm('Descartar as alterações não salvas do cadastro?')
    )
      action();
  }
  const [view, setView] = useState('consulta');
  const [tab, setTab] = useState('consulta');
  const [panel, setPanel] = useState(true);
  const [previous, setPrevious] = useState(0);
  const [text, setText] = useState(isDemo ? initial : '');
  const [finalized, setFinalized] = useState(false);
  const [ready, setReady] = useState(false);
  const [save, setSave] = useState('Carregando rascunho…');
  const [modal, setModal] = useState('');
  const [docType, setDocType] = useState('Declaração de comparecimento');
  const [docText, setDocText] = useState('');
  useEffect(() => {
    try {
      let raw = localStorage.getItem(storageKey);
      if (
        !raw &&
        isDemo &&
        !localStorage.getItem('prontuario-legacy-claimed')
      ) {
        raw = localStorage.getItem('prontuario-demo-v1');
        if (raw) {
          localStorage.setItem(storageKey, raw);
          localStorage.setItem('prontuario-legacy-claimed', storageKey);
        }
      }
      if (raw) {
        const data: Saved = JSON.parse(raw);
        if (
          typeof data.text === 'string' &&
          typeof data.finalized === 'boolean'
        ) {
          setText(data.text);
          setFinalized(data.finalized);
        }
      }
    } catch {
      setSave('Não foi possível recuperar o rascunho');
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    setSave('Salvando neste navegador…');
    const persist = () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ text, finalized }));
        setSave('Salvo neste navegador');
      } catch {
        setSave('Falha ao salvar — mantenha esta tela aberta');
      }
    };
    persist();
  }, [text, finalized, ready]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setModal('busca');
      }
      if (e.key === 'Escape') setModal('');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (modal !== '') {
      const old = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = old;
      };
    }
  }, [modal]);
  const past = history[previous];
  function finish() {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ text, finalized: true }),
      );
      setFinalized(true);
      setModal('');
    } catch {
      setSave('Falha ao salvar — consulta não finalizada');
      setModal('');
    }
  }
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
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              className={view === id ? 'nav-item active' : 'nav-item'}
              onClick={() =>
                id === 'pacientes'
                  ? leave(onHome)
                  : id === 'agenda'
                    ? leave(onAgenda)
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
          <span>Médico</span>
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
                  {finalized ? 'Finalizada · demonstração' : 'Em atendimento'}
                  <small>{visitDate}</small>
                </div>
              </section>
              <div className="patient-tabs">
                <button
                  className={tab === 'consulta' ? 'selected' : ''}
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
                <div className="tabs-spacer" />
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
                key={patient.id}
                patient={patient}
                tab={tab}
                setTab={setTab}
                newDocument={() => {
                  setDocText('');
                  setModal('documento');
                }}
              />
              <div hidden={tab !== 'cadastro'}>
                <PatientDetails
                  patient={patient}
                  onUpdated={onUpdated}
                  onDirty={setDirtyRegistration}
                />
              </div>
              <div hidden={tab !== 'consulta'}>
                <div
                  className={
                    panel && isDemo ? 'workspace' : 'workspace focused'
                  }
                >
                  {panel && isDemo && (
                    <aside className="clinical-sidebar">
                      <div className="section-label">
                        CONTEXTO DO ATENDIMENTO
                      </div>
                      <section className="history-card">
                        <div className="card-heading">
                          <span>
                            <Clock3 size={16} /> Consulta anterior
                          </span>
                          <div>
                            <button
                              aria-label="Consulta mais antiga"
                              disabled={previous === 1}
                              onClick={() => setPrevious(1)}
                            >
                              <ChevronLeft size={17} />
                            </button>
                            <button
                              aria-label="Consulta mais recente"
                              disabled={previous === 0}
                              onClick={() => setPrevious(0)}
                            >
                              <ChevronRight size={17} />
                            </button>
                          </div>
                        </div>
                        <div className="history-date">{past.date}</div>
                        <h3>{past.title}</h3>
                        <p>{past.text}</p>
                        <h4>Conduta registrada</h4>
                        <p>{past.plan}</p>
                        <span className="source-label">
                          <Check size={13} /> Registro fictício de referência
                        </span>
                      </section>
                      <section className="mini-section">
                        <div className="card-heading">
                          <span>Medicamentos atuais</span>
                        </div>
                        <p className="muted">
                          Nenhum medicamento cadastrado neste exemplo.
                        </p>
                      </section>
                      <section className="mini-section">
                        <div className="card-heading">
                          <span>Alergias</span>
                        </div>
                        <p className="muted">Não informadas</p>
                      </section>
                      <div className="note-card">
                        <span className="dot" />
                        <p>
                          Para este retorno
                          <br />
                          <strong>
                            Rever o registro do sono e as mudanças na rotina.
                          </strong>
                        </p>
                      </div>
                    </aside>
                  )}
                  <section className="editor-card">
                    <div className="editor-header">
                      <div>
                        <div className="eyebrow">{visitDate.toUpperCase()}</div>
                        <h2>Evolução da consulta</h2>
                      </div>
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
                    <label className="sr-only" htmlFor="evolution">
                      Evolução em texto livre
                    </label>
                    <textarea
                      id="evolution"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      disabled={!ready}
                      readOnly={finalized}
                      placeholder="Escreva livremente sobre o atendimento…"
                      spellCheck
                    />
                    {finalized && (
                      <div className="finalized-info">
                        <LockKeyhole size={15} /> Finalização demonstrativa.
                        Nenhuma assinatura digital foi aplicada.
                      </div>
                    )}
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
                          setDocText('');
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
                          Reabrir demonstração
                        </button>
                      ) : (
                        <button
                          className="primary"
                          disabled={!ready || !text.trim()}
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
                  rascunho fica salvo somente neste navegador.
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
            if (e.target === e.currentTarget) setModal('');
          }}
        >
          <section
            className="modal"
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
              onClick={() => setModal('')}
            >
              <X size={20} />
            </button>
            {modal === 'busca' ? (
              <>
                <h2 id="dialog-title">Buscar paciente</h2>
                <PatientSearch
                  compact
                  onOpen={(p) => {
                    setModal('');
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
            ) : modal === 'finalizar' ? (
              <>
                <h2 id="dialog-title">Finalizar esta consulta?</h2>
                <p>
                  O texto ficará bloqueado para edição nesta demonstração. No
                  sistema definitivo, correções serão feitas por adendos.
                </p>
                <div className="info-box">
                  Esta ação não aplica assinatura digital nem cria um prontuário
                  válido para uso clínico.
                </div>
                <button className="primary" onClick={finish}>
                  Confirmar finalização demonstrativa
                </button>
              </>
            ) : modal === 'reiniciar' ? (
              <>
                <h2 id="dialog-title">Reabrir demonstração?</h2>
                <p>
                  Você poderá continuar editando o mesmo texto. Esta opção
                  existe apenas para testar a interface.
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    setFinalized(false);
                    setModal('');
                  }}
                >
                  Reabrir texto
                </button>
              </>
            ) : (
              <>
                <h2 id="dialog-title">Novo documento</h2>
                <p>Experimente um rascunho editável com dados fictícios.</p>
                <label htmlFor="doctype">Tipo de documento</label>
                <select
                  id="doctype"
                  value={docType}
                  onChange={(e) => {
                    setDocType(e.target.value);
                    setDocText('');
                  }}
                >
                  <option>Declaração de comparecimento</option>
                  <option>Atestado</option>
                  <option>Relatório</option>
                  <option>Receita</option>
                  <option>Pedido de exames</option>
                  <option>Documento livre</option>
                </select>
                <button
                  className="secondary"
                  onClick={() =>
                    setDocText(
                      docType !== 'Declaração de comparecimento'
                        ? `${docType.toUpperCase()} — RASCUNHO FICTÍCIO\n\nPaciente: ${patient.name}\n\n[Escreva o conteúdo aqui]\n\nSem assinatura e sem validade clínica.`
                        : `DECLARAÇÃO FICTÍCIA — SEM VALIDADE CLÍNICA\n\nPaciente: ${patient.name}\nData: ${visitDate}\n\n[Informe o período de comparecimento]\n\nDocumento sem assinatura.`,
                    )
                  }
                >
                  Preparar rascunho
                </button>
                {docText && (
                  <>
                    <textarea
                      aria-label="Rascunho do documento"
                      className="document-editor"
                      value={docText}
                      onChange={(e) => setDocText(e.target.value)}
                    />
                    <small>
                      Prévia temporária, sem assinatura. Não é salva ao fechar.
                    </small>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
