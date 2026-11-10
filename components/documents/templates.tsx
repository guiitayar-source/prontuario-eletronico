'use client';
import { useState } from 'react';
import { ArrowRight, BookOpen, Plus, Save, Search, Trash2 } from 'lucide-react';
import {
  documentTemplate,
  type PrescriptionTemplate,
} from '@/lib/document-fields';
import type { DocumentsController } from './use-documents';

const summary = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^via\s+de\s+administra/i.test(l))
    .slice(0, 2)
    .join(' · ');

/** Texto vazio ou igual ao texto-base do sistema: não vale salvar como modelo. */
export const blankText = (text: string, kind: string) =>
  !text.trim() || text.trim() === documentTemplate(kind).trim();

/**
 * Modelos do próprio profissional para o tipo do documento aberto: usar, acrescentar,
 * excluir e salvar o texto atual como modelo. Valem para todos os pacientes.
 */
export function DocumentTemplates({
  docs,
  placeholder,
  searchable = false,
}: {
  docs: DocumentsController;
  placeholder: string;
  searchable?: boolean;
}) {
  const [naming, setNaming] = useState(false),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [query, setQuery] = useState('');
  const d = docs.draft;
  if (!d) return null;
  const kind = d.kind;
  const editable =
    d.status !== 'SIGNED' && d.status !== 'SUPERSEDED' && !docs.busy;
  const list = docs.templates.filter((t) => (t.kind || 'Receita') === kind);
  const filteredList = list.filter((t) =>
    `${t.name} ${t.text}`
      .toLocaleLowerCase('pt-BR')
      .includes(query.trim().toLocaleLowerCase('pt-BR')),
  );
  const isBlank = blankText(d.text, kind);

  function apply(t: PrescriptionTemplate, append: boolean) {
    if (!d || !editable) return;
    setMessage('');
    if (append && !isBlank) {
      docs.setDraft({ ...d, text: `${d.text.trim()}\n\n${t.text.trim()}` });
      return;
    }
    if (
      !isBlank &&
      !window.confirm(`Substituir o texto atual pelo modelo “${t.name}”?`)
    )
      return;
    docs.setDraft({ ...d, text: t.text });
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!d || !name.trim() || isBlank) return;
    const existing = list.find(
      (t) => t.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (
      existing &&
      !window.confirm(`Já existe o modelo “${existing.name}”. Substituir?`)
    )
      return;
    void run(async () => {
      await docs.saveTemplate({
        id: existing?.id || crypto.randomUUID(),
        kind,
        name: name.trim(),
        text: d.text,
      });
      setNaming(false);
      setName('');
      setMessage('Modelo salvo.');
    });
  }

  function remove(t: PrescriptionTemplate) {
    if (!window.confirm(`Excluir o modelo “${t.name}”?`)) return;
    void run(() => docs.deleteTemplate(t.id));
  }

  return (
    <div className="document-templates">
      {searchable && list.length > 0 && (
        <label className="prescription-search">
          <Search size={15} aria-hidden />
          <input
            type="search"
            aria-label="Buscar modelos"
            placeholder="Buscar modelo ou medicamento"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      {!list.length && (
        <div className="prescription-empty">
          <BookOpen size={24} aria-hidden />
          <strong>Crie seu primeiro modelo</strong>
          <p>
            Escreva o texto da {kind.toLowerCase()} e use “Salvar como modelo”.
          </p>
        </div>
      )}
      {list.length > 0 && !filteredList.length && (
        <p className="prescription-hint" role="status">
          Nenhum modelo encontrado. Tente outro termo.
        </p>
      )}
      <ul className="prescription-list" aria-label="Modelos salvos">
        {filteredList.map((t) => (
          <li key={t.id} className="prescription-library-item">
            <strong>{t.name}</strong>
            <span className="prescription-summary">{summary(t.text)}</span>
            <div className="prescription-item-actions">
              <button
                type="button"
                className="text-button prescription-item-primary"
                disabled={!editable || busy}
                onClick={() => apply(t, false)}
              >
                Usar <ArrowRight size={13} aria-hidden />
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!editable || busy || isBlank}
                onClick={() => apply(t, true)}
                title="Acrescentar ao final do texto atual"
              >
                <Plus size={13} aria-hidden /> Acrescentar
              </button>
              <button
                type="button"
                className="text-button danger prescription-delete-template"
                disabled={busy}
                aria-label={`Excluir modelo ${t.name}`}
                title={`Excluir modelo ${t.name}`}
                onClick={() => remove(t)}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
          </li>
        ))}
      </ul>
      {naming ? (
        <div className="document-template-save">
          <input
            aria-label="Nome do modelo"
            maxLength={80}
            placeholder={placeholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
            }}
          />
          <button
            type="button"
            className="secondary"
            disabled={busy || !name.trim()}
            onClick={save}
          >
            Salvar
          </button>
          <button
            type="button"
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
          type="button"
          className="secondary prescription-save-template"
          disabled={isBlank || busy || !editable}
          onClick={() => setNaming(true)}
        >
          <Save size={14} aria-hidden /> Salvar como modelo
        </button>
      )}
      <p className="document-template-note">
        Valem para todos os pacientes. Não inclua dados de pacientes.
      </p>
      {error && (
        <p role="alert" className="capture-error">
          {error}
        </p>
      )}
      {message && <output className="capture-notice">{message}</output>}
    </div>
  );
}
