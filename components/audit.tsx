'use client';
import { useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import { Modal } from './modal';
type Event = {
  id: number;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  occurred_at: string;
};
export function Audit() {
  const [events, setEvents] = useState<Event[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load() {
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/audit');
      if (!r.ok) throw new Error('Não foi possível carregar a auditoria.');
      setEvents(((await r.json()) as { events: Event[] }).events);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button disabled={busy} onClick={load}>
        Auditoria
      </button>
      {error && <span role="alert">{error}</span>}
      {events && (
        <Modal label="Auditoria da clínica" onClose={() => setEvents(null)}>
          <h2>Auditoria da clínica</h2>
          <p>
            Últimos 100 eventos: alterações, finalizações, importações e
            solicitações de exportação. A solicitação não comprova que o
            download terminou.
          </p>
          <p>
            Leituras diretas do banco exigem consulta aos logs do provedor; esta
            lista não registra toda visualização.
          </p>
          {events.map((e) => (
            <article key={e.id}>
              <strong>
                {new Date(e.occurred_at).toLocaleString('pt-BR')} · {e.action}
              </strong>
              <p>
                {e.entity_type} · {e.entity_id}
                <br />
                Conta: {e.actor_id || 'operação do sistema'}
              </p>
            </article>
          ))}
          <button className="secondary" onClick={() => setEvents(null)}>
            Fechar
          </button>
        </Modal>
      )}
    </>
  );
}
