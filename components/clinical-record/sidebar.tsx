'use client';
import { Clock3 } from 'lucide-react';
import { ClinicalContextSummary, type ClinicalContextController } from '../clinical-context';
import { CollapsibleCard } from '../collapsible-card';
import { date, type RecordEntry } from './types';

/** Painel lateral do atendimento: contexto clínico e histórico de consultas. */
export function RecordSidebar({
  context,
  onEditContext,
  rows,
  currentId,
  busy,
  onChoose,
}: {
  context: ClinicalContextController;
  onEditContext: () => void;
  rows: RecordEntry[];
  currentId?: string;
  busy: boolean;
  onChoose: (r: RecordEntry) => void;
}) {
  return (
    <aside className="clinical-sidebar" aria-label="Contexto e histórico">
      <ClinicalContextSummary
        context={context}
        onEdit={onEditContext}
      />
      <CollapsibleCard
        storageKey="historico"
        title="Histórico de consultas"
        icon={<Clock3 size={16} aria-hidden />}
      >
        {!rows.length && (
          <p className="muted">Nenhuma consulta registrada.</p>
        )}
        {rows.map((r) => (
          <button
            key={r.id}
            className="consultation-history-link"
            aria-current={
              currentId === r.id ? 'true' : undefined
            }
            disabled={busy}
            onClick={() => onChoose(r)}
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
      </CollapsibleCard>
    </aside>
  );
}
