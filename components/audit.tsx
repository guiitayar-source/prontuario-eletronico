'use client';
import { useMemo, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import { Modal } from './modal';
import {
  ScrollText,
  Search,
  RefreshCw,
  X,
  Copy,
  Check,
  User,
  Cpu,
  Layers,
} from 'lucide-react';

export type AuditEvent = {
  id: number;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  occurred_at: string;
};

const ACTION_MAP: Record<
  string,
  { label: string; variant: 'green' | 'blue' | 'purple' | 'amber' | 'red' | 'gray' }
> = {
  import_apply: { label: 'Importação aplicada', variant: 'green' },
  import_undo: { label: 'Importação revertida', variant: 'red' },
  export_snapshot: { label: 'Exportação solicitada', variant: 'purple' },
  enable_clinic_mfa: { label: 'MFA exigido na clínica', variant: 'amber' },
  consultation_finalize: { label: 'Consulta finalizada', variant: 'blue' },
  patient_create: { label: 'Paciente cadastrado', variant: 'green' },
  patient_update: { label: 'Paciente atualizado', variant: 'blue' },
  document_create: { label: 'Documento emitido', variant: 'blue' },
  document_update: { label: 'Documento editado', variant: 'blue' },
  invite: { label: 'Integrante convidado', variant: 'green' },
  role_change: { label: 'Papel alterado', variant: 'amber' },
  revoke: { label: 'Acesso revogado', variant: 'red' },
};

export function Audit() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | 'imports' | 'clinical' | 'security'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/audit');
      if (!r.ok) throw new Error('Não foi possível carregar a auditoria.');
      setEvents(((await r.json()) as { events: AuditEvent[] }).events);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 1800);
  }

  const filteredEvents = useMemo(() => {
    if (!events) return [];
    return events.filter((e) => {
      // Category filter
      if (category === 'imports') {
        const isImport =
          e.action.includes('import') ||
          e.action.includes('export') ||
          e.entity_type.includes('import');
        if (!isImport) return false;
      } else if (category === 'clinical') {
        const isClinical =
          e.action.includes('consultation') ||
          e.action.includes('document') ||
          e.action.includes('patient') ||
          ['patients', 'consultations', 'clinical_documents', 'clinical_context'].includes(
            e.entity_type,
          );
        if (!isClinical) return false;
      } else if (category === 'security') {
        const isSec =
          e.action.includes('mfa') ||
          e.action.includes('invite') ||
          e.action.includes('role') ||
          e.action.includes('revoke') ||
          ['clinics', 'clinic_members'].includes(e.entity_type);
        if (!isSec) return false;
      }

      // Search filter
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      const meta = ACTION_MAP[e.action];
      return (
        e.action.toLowerCase().includes(q) ||
        (meta?.label && meta.label.toLowerCase().includes(q)) ||
        e.entity_type.toLowerCase().includes(q) ||
        e.entity_id.toLowerCase().includes(q) ||
        (e.actor_id && e.actor_id.toLowerCase().includes(q))
      );
    });
  }, [events, category, search]);

  return (
    <>
      <button
        type="button"
        className="header-btn"
        disabled={busy}
        onClick={load}
        title="Consultar eventos de auditoria da clínica"
      >
        <ScrollText size={15} />
        <span>Auditoria</span>
      </button>

      {error && !events && (
        <span role="alert" className="header-alert">
          {error}
        </span>
      )}

      {events && (
        <Modal
          label="Auditoria da clínica"
          className="audit-modal-dialog"
          onClose={() => setEvents(null)}
        >
          <div className="audit-modal-container">
            {/* Header fixo */}
            <div className="audit-modal-header">
              <div className="audit-title-group">
                <div className="audit-icon-badge">
                  <ScrollText size={20} />
                </div>
                <div>
                  <div className="audit-title-row">
                    <h2>Auditoria da clínica</h2>
                    <span className="audit-count-badge">
                      {events.length} eventos recentes
                    </span>
                  </div>
                  <p>
                    Registro imutável de operações clínicas, dados, importações e segurança.
                  </p>
                </div>
              </div>
              <div className="audit-header-actions">
                <button
                  type="button"
                  className="audit-btn-icon"
                  title="Atualizar eventos"
                  disabled={busy}
                  onClick={load}
                >
                  <RefreshCw size={16} className={busy ? 'spin' : ''} />
                </button>
                <button
                  type="button"
                  className="audit-btn-icon"
                  title="Fechar"
                  onClick={() => setEvents(null)}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Aviso informativo sucinto */}
            <div className="audit-disclaimer">
              <span>
                Últimos 100 eventos da clínica. A lista cobre alterações persistidas, importações/reversões e snapshots; visualizações diretas de banco exigem auditoria do provedor.
              </span>
            </div>

            {/* Controles de busca e filtro */}
            <div className="audit-controls">
              <div className="audit-search-box">
                <Search size={15} />
                <input
                  type="search"
                  placeholder="Buscar ação, entidade, ID ou conta…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    className="audit-search-clear"
                    onClick={() => setSearch('')}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              <div className="audit-filter-chips">
                <button
                  type="button"
                  className={`audit-chip ${category === 'all' ? 'active' : ''}`}
                  onClick={() => setCategory('all')}
                >
                  Todos ({events.length})
                </button>
                <button
                  type="button"
                  className={`audit-chip ${category === 'imports' ? 'active' : ''}`}
                  onClick={() => setCategory('imports')}
                >
                  Importação / Exportação
                </button>
                <button
                  type="button"
                  className={`audit-chip ${category === 'clinical' ? 'active' : ''}`}
                  onClick={() => setCategory('clinical')}
                >
                  Prontuário & Atendimento
                </button>
                <button
                  type="button"
                  className={`audit-chip ${category === 'security' ? 'active' : ''}`}
                  onClick={() => setCategory('security')}
                >
                  Segurança & Equipe
                </button>
              </div>
            </div>

            {/* Lista de eventos com scroll independente */}
            <div className="audit-list">
              {filteredEvents.length === 0 ? (
                <div className="audit-empty">
                  <Layers size={32} />
                  <p>Nenhum evento encontrado com os filtros selecionados.</p>
                </div>
              ) : (
                filteredEvents.map((e) => {
                  const meta = ACTION_MAP[e.action] || {
                    label: e.action.replace(/_/g, ' '),
                    variant: 'gray',
                  };
                  const dateObj = new Date(e.occurred_at);
                  const formattedDate = dateObj.toLocaleDateString('pt-BR');
                  const formattedTime = dateObj.toLocaleTimeString('pt-BR');

                  return (
                    <div key={e.id} className="audit-item">
                      <div className="audit-item-main">
                        <div className="audit-item-top">
                          <span className={`audit-action-tag ${meta.variant}`}>
                            {meta.label}
                          </span>
                          <span className="audit-raw-action">{e.action}</span>
                          <time className="audit-timestamp" dateTime={e.occurred_at}>
                            {formattedDate} · {formattedTime}
                          </time>
                        </div>

                        <div className="audit-item-body">
                          <div className="audit-entity-row">
                            <span className="audit-entity-type">{e.entity_type}</span>
                            <span className="audit-entity-sep">/</span>
                            <code className="audit-entity-id" title={e.entity_id}>
                              {e.entity_id}
                            </code>
                            <button
                              type="button"
                              className="audit-copy-btn"
                              title="Copiar ID"
                              onClick={() => copy(e.entity_id)}
                            >
                              {copiedId === e.entity_id ? (
                                <Check size={12} className="copy-success" />
                              ) : (
                                <Copy size={12} />
                              )}
                            </button>
                          </div>

                          <div className="audit-actor-row">
                            {e.actor_id ? (
                              <>
                                <User size={12} />
                                <span>Conta:</span>
                                <code title={e.actor_id}>
                                  {e.actor_id.length > 20
                                    ? `${e.actor_id.slice(0, 8)}…${e.actor_id.slice(-6)}`
                                    : e.actor_id}
                                </code>
                              </>
                            ) : (
                              <>
                                <Cpu size={12} />
                                <span>Operação automática do sistema</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Rodapé fixo */}
            <div className="audit-modal-footer">
              <span className="audit-footer-info">
                Exibindo {filteredEvents.length} de {events.length} eventos
              </span>
              <button
                type="button"
                className="audit-btn-close"
                onClick={() => setEvents(null)}
              >
                Fechar
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
