'use client';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import {
  documentKinds,
  documentTemplate,
  type ClinicalDocument,
} from '@/lib/document-fields';
import type { Patient } from '@/lib/patient-fields';
type Profile = { physician_name: string; physician_registration: string };
export function useDocuments(patient: Patient, enabled = true) {
  const [rows, setRows] = useState<ClinicalDocument[]>([]),
    [profile, setProfile] = useState<Profile>({
      physician_name: '',
      physician_registration: '',
    }),
    [draft, setDraft] = useState<ClinicalDocument | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(''),
    [preview, setPreview] = useState('');
  const previewRef = useRef(''),
    saving = useRef(false);
  async function load() {
    const r = await apiFetch(
      '/api/documents?patientId=' + encodeURIComponent(patient.id),
    );
    const data = (await r.json()) as {
      documents: ClinicalDocument[];
      profile: Profile | null;
      error?: string;
    };
    if (!r.ok) throw new Error(data.error);
    setRows(data.documents);
    if (data.profile) setProfile(data.profile);
  }
  useEffect(() => {
    if (enabled) void load().catch((e) => setError(e.message));
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [patient.id, enabled]);
  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = '';
    setPreview('');
  }
  function open(
    d?: ClinicalDocument,
    consultationId?: string,
    duplicate = false,
    initialText = '',
  ) {
    clearPreview();
    setError('');
    const next = d
      ? {
          ...d,
          ...(duplicate
            ? {
                id: crypto.randomUUID(),
                version: 0,
                author_id: undefined,
                updated_at: undefined,
              }
            : {}),
        }
      : {
          id: crypto.randomUUID(),
          patient_id: patient.id,
          consultation_id: consultationId || null,
          kind: documentKinds[0],
          patient_name: patient.social_name || patient.name,
          ...profile,
          document_date: new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Sao_Paulo',
          }).format(new Date()),
          text: initialText,
          version: 0,
        };
    setDraft(next);
    setSaved(JSON.stringify(next));
  }
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  function close() {
    if (busy) return false;
    if (
      dirty &&
      !window.confirm('Descartar as alterações não salvas deste documento?')
    )
      return false;
    setDraft(null);
    clearPreview();
    return true;
  }
  async function save() {
    if (!draft || saving.current) return null;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Document-Action': '1',
        },
        body: JSON.stringify(draft),
      });
      const result = (await r.json()) as {
        document: ClinicalDocument;
        error?: string;
      };
      if (!r.ok) throw new Error(result.error);
      setDraft(result.document);
      setSaved(JSON.stringify(result.document));
      await load();
      return result.document;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function pdf() {
    const d = dirty || draft?.version === 0 ? await save() : draft;
    if (!d) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch(
        `/api/documents?action=pdf&patientId=${encodeURIComponent(patient.id)}&id=${d.id}`,
      );
      if (!r.ok) {
        const e = (await r.json()) as { error: string };
        throw new Error(e.error);
      }
      clearPreview();
      previewRef.current = URL.createObjectURL(await r.blob());
      setPreview(previewRef.current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return {
    rows,
    draft,
    setDraft: (d: ClinicalDocument) => {
      clearPreview();
      setDraft(d);
    },
    error,
    busy,
    dirty,
    preview,
    load,
    open,
    close,
    save,
    pdf,
  };
}
export type DocumentsController = ReturnType<typeof useDocuments>;
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
          <strong>{d.kind}</strong>
          <span>
            {d.document_date.split('-').reverse().join('/')} · Rascunho · versão{' '}
            {d.version}
            {d.consultation_id ? ' · Vinculado à consulta' : ''}
          </span>
          <div>
            <button className="text-button" onClick={() => onOpen(d)}>
              Abrir
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
export function DocumentEditor({ docs }: { docs: DocumentsController }) {
  const d = docs.draft;
  if (!d) return null;
  function update(fields: Partial<ClinicalDocument>) {
    docs.setDraft({ ...d!, ...fields });
  }
  return (
    <>
      <h2 id="dialog-title">
        {d.version ? 'Editar documento' : 'Novo documento'}
      </h2>
      <p>
        {d.version
          ? 'Rascunho salvo no prontuário. Sem assinatura digital.'
          : d.text
            ? 'Texto inserido em um rascunho não salvo. Confira com o documento original antes de salvar.'
            : 'Novo rascunho ainda não salvo. Sem assinatura digital.'}
      </p>
      {docs.error && (
        <div className="capture-error" role="alert">
          {docs.error} Seu texto foi mantido para revisão.
        </div>
      )}
      <fieldset disabled={docs.busy} style={{ border: 0, padding: 0 }}>
        <label htmlFor="doctype">Tipo de documento</label>
        <select
          id="doctype"
          value={d.kind}
          onChange={(e) => update({ kind: e.target.value })}
        >
          {documentKinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <label>
          Paciente
          <input value={d.patient_name} readOnly />
        </label>
        <label>
          Data
          <input
            type="date"
            value={d.document_date}
            onChange={(e) => update({ document_date: e.target.value })}
          />
        </label>
        <label>
          Nome profissional
          <input
            maxLength={180}
            value={d.physician_name}
            onChange={(e) => update({ physician_name: e.target.value })}
          />
        </label>
        <label>
          CRM/UF e RQE
          <input
            maxLength={120}
            value={d.physician_registration}
            onChange={(e) => update({ physician_registration: e.target.value })}
          />
        </label>
        {d.consultation_id && (
          <label>
            <input
              type="checkbox"
              checked
              onChange={() => update({ consultation_id: null })}
            />{' '}
            Vinculado à consulta selecionada
          </label>
        )}
        <button
          className="secondary"
          onClick={() => {
            if (!d.text || window.confirm('Substituir o texto pelo modelo?'))
              update({ text: documentTemplate(d.kind) });
          }}
        >
          Preparar modelo
        </button>
        <textarea
          className="document-editor"
          aria-label="Texto do documento"
          maxLength={100000}
          value={d.text}
          onChange={(e) => update({ text: e.target.value })}
        />
      </fieldset>
      <div className="editor-actions">
        <button
          className="secondary"
          disabled={docs.busy}
          onClick={() => void docs.save()}
        >
          Salvar rascunho
        </button>
        <button
          className="primary"
          disabled={docs.busy || !d.text.trim()}
          onClick={() => void docs.pdf()}
        >
          Prévia / PDF
        </button>
      </div>
      <small role="status">
        {docs.busy
          ? 'Processando…'
          : docs.dirty
            ? 'Alterações não salvas'
            : d.version
              ? 'Salvo'
              : 'Novo rascunho'}
      </small>
      {docs.preview && (
        <>
          <p>Prévia da versão salva. Use o visualizador para imprimir.</p>
          <iframe
            title="Prévia do documento em PDF"
            src={docs.preview}
            style={{ width: '100%', height: 440, border: '1px solid #ddd' }}
          />
          <a className="secondary" href={docs.preview} download="documento.pdf">
            Baixar PDF
          </a>
        </>
      )}
    </>
  );
}
