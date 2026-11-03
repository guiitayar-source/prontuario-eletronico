'use client';
import { useState } from 'react';
import { Plus, Repeat } from 'lucide-react';
import {
  documentTemplate,
  type ClinicalDocument,
} from '@/lib/document-fields';
import { DocumentEditor, type DocumentsController } from './documents';
import { DocumentTemplates } from './documents/templates';

const formatDate = (d: ClinicalDocument) =>
  d.document_date
    ? d.document_date.split('-').reverse().join('/')
    : d.updated_at
      ? new Date(d.updated_at).toLocaleDateString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
        })
      : 'Sem data';
const summary = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^via\s+de\s+administra/i.test(l))
    .slice(0, 2)
    .join(' · ');

export function PrescriptionWorkspace({
  docs,
  consultationId,
}: {
  docs: DocumentsController;
  consultationId?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const d = docs.draft;
  const patientRows = docs.rows.filter((row) => row.kind === 'Receita');

  async function newPrescription() {
    if (docs.busy || busy) return;
    setBusy(true);
    setError('');
    try {
      if (docs.dirty && d?.status !== 'SIGNED') {
        const saved = await docs.save();
        if (!saved) return;
      }
      docs.open(undefined, consultationId, false, documentTemplate('Receita'), 'Receita');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openPrevious(row: ClinicalDocument, repeat: boolean) {
    if (
      docs.dirty &&
      !window.confirm('Descartar as alterações não salvas desta receita?')
    )
      return;
    docs.open(row, repeat ? consultationId : undefined, repeat);
  }

  return (
    <div className="prescription-layout">
      <aside className="prescription-sidebar" aria-label="Receitas do paciente e modelos gerais">
        <section>
          <h3>Receitas deste paciente</h3>
          <button
            type="button"
            className="secondary prescription-new"
            disabled={docs.busy || busy}
            onClick={() => void newPrescription()}
          >
            <Plus size={15} /> Nova receita
          </button>
          <p className="document-template-note">
            Ao iniciar outra receita, as alterações da atual são salvas como rascunho.
          </p>
          {!patientRows.length && (
            <p className="muted">
              Nenhuma receita salva. “Salvar rascunho” guarda a receita aqui e
              na aba Documentos; “Repetir” copia uma receita com a data de hoje.
            </p>
          )}
          <ul className="prescription-list">
            {patientRows.map((row) => (
              <li key={row.id}>
                <strong>
                  {formatDate(row)}
                  {' · ' + prescriptionState(row)}
                  {row.id === d?.id ? ' · aberta' : ''}
                </strong>
                <span className="prescription-summary">
                  {summary(row.text) || 'Sem texto'}
                </span>
                <div className="prescription-item-actions">
                  <button
                    className="text-button"
                    disabled={docs.busy}
                    onClick={() => openPrevious(row, true)}
                    title="Nova receita com o mesmo texto e a data de hoje"
                  >
                    <Repeat size={13} /> Repetir
                  </button>
                  <button
                    className="text-button"
                    disabled={docs.busy || row.id === d?.id}
                    onClick={() => openPrevious(row, false)}
                  >
                    Abrir
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>Modelos gerais</h3>
          <DocumentTemplates key={d?.id} docs={docs} placeholder="Ex.: Sertralina 50 mg" />
          {error && (
            <p role="alert" className="capture-error">
              {error}
            </p>
          )}
        </section>
      </aside>
      <div className="prescription-editor">
        <DocumentEditor docs={docs} prescription />
      </div>
    </div>
  );
}

/** Estado que a lista mostra: o da RCE com número, quando houver. */
function prescriptionState(row: ClinicalDocument) {
  const e = row.rce_emission;
  if (e?.state === 'SIGNED') return `Assinada · Nº ${e.number}`;
  if (e && ['SIGNING', 'SIGNATURE_UNCERTAIN', 'FINALIZING'].includes(e.state))
    return `Em conferência · Nº ${e.number}`;
  if (e?.state === 'AWAITING_REVIEW') return `Nº ${e.number} reservado`;
  if (e?.state === 'CANCELLED' || e?.state === 'BLOCKED') return 'RCE descartada';
  if (row.status === 'SIGNED' || row.status === 'SUPERSEDED') return 'Assinada';
  if (row.status === 'SIGNING') return 'Assinando';
  if (row.status === 'SIGNATURE_FAILED') return 'Falha na assinatura';
  return 'Rascunho';
}
