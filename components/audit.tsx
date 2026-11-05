'use client';
import { useRef, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import { Modal } from './modal';
import { ScrollText } from 'lucide-react';

export type AuditEvent = {
  id: number | string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  occurred_at: string;
};
const actionLabels: Record<string, string> = {
  insert: 'Inclusão',
  update: 'Atualização',
  delete: 'Exclusão',
  import_apply: 'Importação aplicada',
  import_undo: 'Importação revertida',
  export_snapshot: 'Exportação solicitada',
  enable_clinic_mfa: 'MFA exigido na clínica',
  consultation_finalize: 'Consulta finalizada',
  patient_create: 'Paciente cadastrado',
  patient_update: 'Paciente atualizado',
  document_create: 'Documento emitido',
  document_update: 'Documento editado',
  ai_document_request: 'Rascunho solicitado à IA',
  invite: 'Integrante convidado',
  role_change: 'Papel alterado',
  revoke: 'Acesso revogado',
  clinic_plan_change: 'Plano alterado',
};
const emptyFilters = {
  q: '',
  from: '',
  to: '',
  actor: '',
  patient: '',
  operation: '',
  category: 'all',
};
export function Audit() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [next, setNext] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const generation = useRef(0);
  async function load(values = filters, cursor: string | null = null) {
    const ticket = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams(
        Object.entries(values).filter(([, v]) => v),
      );
      if (cursor) params.set('before', cursor);
      const r = await apiFetch('/api/audit?' + params);
      const data = (await r.json()) as {
        events: AuditEvent[];
        next: string | null;
        error?: string;
      };
      if (!r.ok)
        throw new Error(data.error || 'Não foi possível carregar a auditoria.');
      if (ticket !== generation.current) return;
      setEvents((old) =>
        cursor ? [...(old || []), ...data.events] : data.events,
      );
      setApplied(values);
      setNext(data.next);
    } catch (e) {
      if (ticket === generation.current) setError((e as Error).message);
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  function close() {
    generation.current++;
    setEvents(null);
    setBusy(false);
    setError('');
    setCopyMessage('');
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage('ID copiado.');
    } catch {
      setCopyMessage(
        'Não foi possível copiar. Selecione o ID e copie manualmente.',
      );
    }
  }
  return (
    <>
      <button
        type="button"
        className="header-btn"
        disabled={busy}
        onClick={() => {
          setEvents([]);
          void load();
        }}
      >
        <ScrollText size={15} />
        <span>Auditoria</span>
      </button>
      {events && (
        <Modal
          label="Auditoria da clínica"
          className="audit-modal-dialog"
          onClose={close}
        >
          <div className="audit-modal-container">
            <div className="audit-modal-header">
              <div>
                <h2>Auditoria da clínica</h2>
                <p>Histórico de operações registradas pelo sistema.</p>
              </div>
              <button type="button" onClick={close}>
                Fechar
              </button>
            </div>
            <p className="audit-disclaimer">
              Filtros consultam todo o histórico disponível. Leituras diretas do
              banco exigem auditoria do provedor. O filtro por paciente pode não
              localizar eventos antigos de entidades já excluídas.
            </p>
            <form
              className="audit-query-form"
              onSubmit={(e) => {
                e.preventDefault();
                void load();
              }}
            >
              <label>
                Buscar ação, entidade ou ID
                <input
                  value={filters.q}
                  maxLength={180}
                  onChange={(e) =>
                    setFilters({ ...filters, q: e.target.value })
                  }
                />
              </label>
              <label>
                Paciente (nome ou ID)
                <input
                  value={filters.patient}
                  maxLength={180}
                  onChange={(e) =>
                    setFilters({ ...filters, patient: e.target.value })
                  }
                />
              </label>
              <label>
                Profissional (ID da conta)
                <input
                  value={filters.actor}
                  maxLength={36}
                  onChange={(e) =>
                    setFilters({ ...filters, actor: e.target.value })
                  }
                />
              </label>
              <label>
                Operação exata
                <input
                  value={filters.operation}
                  maxLength={80}
                  placeholder="Ex.: update"
                  onChange={(e) =>
                    setFilters({ ...filters, operation: e.target.value })
                  }
                />
              </label>
              <label>
                De (UTC−03)
                <input
                  type="date"
                  value={filters.from}
                  onChange={(e) =>
                    setFilters({ ...filters, from: e.target.value })
                  }
                />
              </label>
              <label>
                Até (UTC−03)
                <input
                  type="date"
                  value={filters.to}
                  onChange={(e) =>
                    setFilters({ ...filters, to: e.target.value })
                  }
                />
              </label>
              <label>
                Categoria
                <select
                  value={filters.category}
                  onChange={(e) =>
                    setFilters({ ...filters, category: e.target.value })
                  }
                >
                  <option value="all">Todas</option>
                  <option value="imports">Importação / Exportação</option>
                  <option value="clinical">Prontuário e atendimento</option>
                  <option value="security">Segurança e equipe</option>
                </select>
              </label>
              <div>
                <button disabled={busy}>Aplicar filtros</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setFilters(emptyFilters);
                    void load(emptyFilters);
                  }}
                >
                  Limpar filtros
                </button>
              </div>
            </form>
            {error && (
              <p role="alert" className="capture-error">
                {error}
              </p>
            )}
            {copyMessage && <p role="status">{copyMessage}</p>}
            <div className="audit-list" aria-busy={busy}>
              {!events.length && (
                <p>{busy ? 'Carregando…' : 'Nenhum evento encontrado.'}</p>
              )}
              {events.map((event) => (
                <article className="audit-item" key={event.id}>
                  <div>
                    <strong>
                      {actionLabels[event.action] ||
                        event.action.replaceAll('_', ' ')}
                    </strong>{' '}
                    <code>{event.action}</code> ·{' '}
                    <time dateTime={event.occurred_at}>
                      {new Date(event.occurred_at).toLocaleString('pt-BR', {
                        timeZone: 'America/Sao_Paulo',
                      })}
                    </time>
                  </div>
                  <div>
                    {event.entity_type} · <code>{event.entity_id}</code>{' '}
                    <button
                      type="button"
                      onClick={() => void copy(event.entity_id)}
                    >
                      Copiar ID
                    </button>
                  </div>
                  <div>
                    Conta:{' '}
                    <code>{event.actor_id || 'Operação automática'}</code>
                  </div>
                </article>
              ))}
            </div>
            <div className="audit-modal-footer">
              <span role="status">{events.length} eventos carregados</span>
              {next && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void load(applied, next)}
                >
                  Carregar mais 100
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void load(applied)}
              >
                Atualizar resultados
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
