'use client';
import type { ClinicalDocument } from '@/lib/document-fields';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import type { DocumentsController } from './use-documents';
export function DocumentHistory({
  docs,
  onOpen,
}: {
  docs: DocumentsController;
  onOpen: (d: ClinicalDocument, duplicate?: boolean) => void;
}) {
  return (
    <section className="history-card">
      <div className="card-heading">
        <span>Documentos salvos</span>
        <button
          className="text-button"
          onClick={() => void docs.load().catch(() => {})}
        >
          Atualizar
        </button>
      </div>
      {docs.error && !docs.draft && <p role="alert">{docs.error}</p>}
      {!docs.rows.length && (
        <p className="muted">Nenhum documento salvo para este paciente.</p>
      )}
      {docs.rows.map((d) => (
        <div className="consultation-history-link" key={d.id}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <strong>{d.kind}</strong>
            {d.status === 'SIGNED' ? (
              <span style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--success)', fontSize: '11px', padding: '2px 8px', borderRadius: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <CheckCircle2 size={12} /> Assinado ICP-Brasil
              </span>
            ) : d.status === 'SIGNING' ? (
              <span style={{ backgroundColor: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '11px', padding: '2px 8px', borderRadius: '12px', fontWeight: 600 }}>
                ⏳ Assinando...
              </span>
            ) : d.status === 'SIGNATURE_FAILED' ? (
              <span style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '11px', padding: '2px 8px', borderRadius: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <AlertCircle size={12} /> Falha na assinatura
              </span>
            ) : (
              <span style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: '11px', padding: '2px 8px', borderRadius: '12px' }}>
                Rascunho
              </span>
            )}
          </div>
          <span>
            {(d.document_date ? d.document_date.split('-').reverse().join('/') : 'Sem data')} · versão{' '}
            {d.version}
            {d.consultation_id ? ' · Vinculado à consulta' : ''}
          </span>
          <div>
            <button className="text-button" onClick={() => onOpen(d)}>
              {d.status === 'SIGNED' ? 'Visualizar' : 'Abrir'}
            </button>{' '}
            ·{' '}
            <button className="text-button" onClick={() => onOpen(d, true)}>
              Duplicar
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
