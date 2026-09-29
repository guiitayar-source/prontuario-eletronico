'use client';
import { useState } from 'react';
import { Plus, Repeat, Trash2 } from 'lucide-react';
import {
  documentTemplate,
  type ClinicalDocument,
  type PrescriptionTemplate,
} from '@/lib/document-fields';
import { DocumentEditor, type DocumentsController } from './documents';

const blank = (text: string) =>
  !text.trim() || text.trim() === documentTemplate('Receita').trim();
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
  const [naming, setNaming] = useState(false),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const d = docs.draft;
  const editable = !!d && d.status !== 'SIGNED' && !docs.busy;
  const previous = docs.rows.filter(
    (row) => row.kind === 'Receita' && row.id !== d?.id,
  );

  function applyTemplate(t: PrescriptionTemplate, append: boolean) {
    if (!d || !editable) return;
    setMessage('');
    if (append && !blank(d.text)) {
      docs.setDraft({ ...d, text: `${d.text.trim()}\n\n${t.text.trim()}` });
      return;
    }
    if (
      !blank(d.text) &&
      !window.confirm(`Substituir o texto atual pelo modelo “${t.name}”?`)
    )
      return;
    docs.setDraft({ ...d, text: t.text });
  }

  async function saveTemplate() {
    if (!d || !name.trim() || blank(d.text)) return;
    const existing = docs.templates.find(
      (t) => t.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (
      existing &&
      !window.confirm(`Já existe o modelo “${existing.name}”. Substituir?`)
    )
      return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await docs.saveTemplate({
        id: existing?.id || crypto.randomUUID(),
        name: name.trim(),
        text: d.text,
      });
      setNaming(false);
      setName('');
      setMessage('Modelo salvo.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate(t: PrescriptionTemplate) {
    if (!window.confirm(`Excluir o modelo “${t.name}”?`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await docs.deleteTemplate(t.id);
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
    setMessage('');
    docs.open(row, repeat ? consultationId : undefined, repeat);
  }

  return (
    <div className="prescription-layout">
      <aside className="prescription-sidebar" aria-label="Modelos e receitas anteriores">
        <section>
          <h3>Meus modelos</h3>
          {!docs.templates.length && (
            <p className="muted">
              Nenhum modelo salvo. Escreva uma receita e use “Salvar como
              modelo”.
            </p>
          )}
          <ul className="prescription-list">
            {docs.templates.map((t) => (
              <li key={t.id}>
                <strong>{t.name}</strong>
                <span className="prescription-summary">{summary(t.text)}</span>
                <div className="prescription-item-actions">
                  <button
                    className="text-button"
                    disabled={!editable || busy}
                    onClick={() => applyTemplate(t, false)}
                  >
                    Usar
                  </button>
                  <button
                    className="text-button"
                    disabled={!editable || busy || blank(d?.text || '')}
                    onClick={() => applyTemplate(t, true)}
                    title="Acrescentar ao final do texto atual"
                  >
                    <Plus size={13} /> Acrescentar
                  </button>
                  <button
                    className="text-button danger"
                    disabled={busy}
                    aria-label={`Excluir modelo ${t.name}`}
                    onClick={() => void removeTemplate(t)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {naming ? (
            <div className="document-template-save">
              <input
                aria-label="Nome do modelo de receita"
                maxLength={80}
                placeholder="Ex.: Sertralina 50 mg"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveTemplate();
                }}
              />
              <button
                className="secondary"
                disabled={busy || !name.trim()}
                onClick={() => void saveTemplate()}
              >
                Salvar
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setNaming(false);
                  setName('');
                }}
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              className="secondary"
              disabled={!d || blank(d.text) || busy}
              onClick={() => setNaming(true)}
            >
              Salvar como modelo
            </button>
          )}
          <p className="document-template-note">
            Os modelos ficam na sua conta. Não inclua dados de pacientes.
          </p>
          {error && (
            <p role="alert" className="capture-error">
              {error}
            </p>
          )}
          {message && <output className="capture-notice">{message}</output>}
        </section>
        <section>
          <h3>Receitas anteriores</h3>
          {!previous.length && (
            <p className="muted">Nenhuma receita anterior deste paciente.</p>
          )}
          <ul className="prescription-list">
            {previous.map((row) => (
              <li key={row.id}>
                <strong>
                  {formatDate(row)}
                  {row.status === 'SIGNED' ? ' · Assinada' : ''}
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
                    disabled={docs.busy}
                    onClick={() => openPrevious(row, false)}
                  >
                    Abrir
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </aside>
      <div className="prescription-editor">
        <DocumentEditor docs={docs} prescription />
      </div>
    </div>
  );
}
