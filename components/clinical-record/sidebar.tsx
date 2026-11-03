'use client';
import {
  ClinicalContextSummary,
  type ClinicalContextController,
} from '../clinical-context';

export function RecordSidebar({
  context,
  onEditContext,
}: {
  context: ClinicalContextController;
  onEditContext: () => void;
}) {
  return (
    <aside className="clinical-sidebar" aria-label="Contexto clínico">
      <ClinicalContextSummary context={context} onEdit={onEditContext} />
    </aside>
  );
}
