'use client';
import { useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  FileText,
  History,
  Plus,
  Repeat,
  Search,
} from 'lucide-react';
import { documentTemplate, type ClinicalDocument } from '@/lib/document-fields';
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
    [error, setError] = useState(''),
    [view, setView] = useState<'history' | 'templates'>('history'),
    [query, setQuery] = useState(''),
    [draftsOnly, setDraftsOnly] = useState(false);
  const d = docs.draft;
  const patientRows = docs.rows.filter((row) => row.kind === 'Receita');
  const draftCount = patientRows.filter(
    (row) => prescriptionState(row) === 'Rascunho',
  ).length;
  const templateCount = docs.templates.filter(
    (t) => (t.kind || 'Receita') === 'Receita',
  ).length;
  const filteredRows = patientRows.filter(
    (row) =>
      (!draftsOnly || prescriptionState(row) === 'Rascunho') &&
      `${formatDate(row)} ${row.text} ${prescriptionState(row)}`
        .toLocaleLowerCase('pt-BR')
        .includes(query.trim().toLocaleLowerCase('pt-BR')),
  );

  async function newPrescription() {
    if (docs.busy || busy) return;
    setBusy(true);
    setError('');
    try {
      if (docs.dirty && d?.status !== 'SIGNED') {
        const saved = await docs.save();
        if (!saved) return;
      }
      docs.open(
        undefined,
        consultationId,
        false,
        documentTemplate('Receita'),
        'Receita',
      );
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
      <aside
        className="prescription-sidebar"
        aria-label="Receitas do paciente e modelos gerais"
      >
        <div className="prescription-sidebar-heading">
          <span className="prescription-eyebrow">Biblioteca de receitas</span>
          <button
            type="button"
            className="primary prescription-new"
            disabled={docs.busy || busy}
            onClick={() => void newPrescription()}
          >
            <Plus size={16} aria-hidden /> Nova receita
          </button>
          <p className="prescription-hint">
            A receita atual é salva como rascunho ao iniciar outra.
          </p>
        </div>
        <div
          className="prescription-navigation"
          role="group"
          aria-label="Consultar biblioteca"
        >
          <button
            type="button"
            aria-pressed={view === 'history'}
            onClick={() => setView('history')}
          >
            <History size={15} aria-hidden /> Salvas{' '}
            <span>{patientRows.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={view === 'templates'}
            onClick={() => setView('templates')}
          >
            <BookOpen size={15} aria-hidden /> Modelos{' '}
            <span>{templateCount}</span>
          </button>
        </div>
        <section
          hidden={view !== 'history'}
          className="prescription-library-section"
          aria-label="Receitas salvas"
        >
          <div className="prescription-section-heading">
            <h3>Receitas do paciente</h3>
            <p className="prescription-hint">
              Retome um rascunho ou repita uma receita anterior.
            </p>
          </div>
          {patientRows.length > 0 && (
            <>
              <label className="prescription-search">
                <Search size={15} aria-hidden />
                <input
                  type="search"
                  aria-label="Buscar receitas salvas"
                  placeholder="Buscar por texto ou data"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div
                className="prescription-filters"
                role="group"
                aria-label="Filtrar receitas"
              >
                <button
                  type="button"
                  aria-pressed={!draftsOnly}
                  onClick={() => setDraftsOnly(false)}
                >
                  Todas
                </button>
                <button
                  type="button"
                  aria-pressed={draftsOnly}
                  onClick={() => setDraftsOnly(true)}
                >
                  Rascunhos <span>{draftCount}</span>
                </button>
              </div>
            </>
          )}
          {!filteredRows.length && (
            <div className="prescription-empty">
              <FileText size={24} aria-hidden />
              <strong>
                {patientRows.length
                  ? 'Nenhuma receita encontrada'
                  : 'Suas receitas ficam aqui'}
              </strong>
              <p>
                {patientRows.length
                  ? 'Tente outro termo ou consulte todas as receitas.'
                  : 'Use “Salvar rascunho” no editor para continuar depois.'}
              </p>
            </div>
          )}
          <ul
            className="prescription-list"
            aria-label="Lista de receitas salvas"
          >
            {filteredRows.map((row) => (
              <li
                key={row.id}
                className="prescription-library-item"
                data-active={row.id === d?.id || undefined}
              >
                <div className="prescription-item-heading">
                  <strong>{formatDate(row)}</strong>
                  <span
                    className="prescription-state"
                    data-draft={
                      prescriptionState(row) === 'Rascunho' || undefined
                    }
                  >
                    {prescriptionState(row)}
                  </span>
                </div>
                <span className="prescription-summary">
                  {summary(row.text) || 'Sem texto'}
                </span>
                {row.id === d?.id && (
                  <span className="prescription-active-label">
                    Aberta no editor
                  </span>
                )}
                <div className="prescription-item-actions">
                  <button
                    type="button"
                    className="text-button prescription-item-primary"
                    disabled={docs.busy || row.id === d?.id}
                    onClick={() => openPrevious(row, false)}
                  >
                    {prescriptionState(row) === 'Rascunho'
                      ? 'Continuar'
                      : 'Abrir'}{' '}
                    <ArrowRight size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={docs.busy}
                    onClick={() => openPrevious(row, true)}
                    title="Nova receita com o mesmo texto e a data de hoje"
                  >
                    <Repeat size={13} aria-hidden /> Repetir
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section
          hidden={view !== 'templates'}
          className="prescription-library-section"
          aria-label="Modelos de receitas"
        >
          <div className="prescription-section-heading">
            <h3>Meus modelos</h3>
            <p className="prescription-hint">
              Textos prontos para reutilizar nas próximas receitas.
            </p>
          </div>
          <DocumentTemplates
            key={d?.id}
            docs={docs}
            placeholder="Ex.: Sertralina 50 mg"
            searchable
          />
        </section>
        {error && (
          <p role="alert" className="capture-error">
            {error}
          </p>
        )}
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
  if (e?.state === 'CANCELLED' || e?.state === 'BLOCKED')
    return 'Emissão numerada descartada';
  if (row.status === 'SIGNED' || row.status === 'SUPERSEDED') return 'Assinada';
  if (row.status === 'SIGNING') return 'Assinando';
  if (row.status === 'SIGNATURE_FAILED') return 'Falha na assinatura';
  return 'Rascunho';
}
