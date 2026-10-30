'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/supabase/http';
import {
  emptyRceFields,
  rceClinicalText,
  rceStateLabels,
  validateRceFields,
} from '@/lib/sncr/rce';
import type { RceEmission } from '@/lib/sncr/rce-workflow';
import type { DocumentsController } from './use-documents';

export function RcePanel({
  docs,
  fieldsShownAbove = false,
}: {
  docs: DocumentsController;
  /** Os campos já aparecem no editor (RCE eletrônica de transição); não repetir aqui. */
  fieldsShownAbove?: boolean;
}) {
  const d = docs.draft!;
  const [enabled, setEnabled] = useState(false),
    [e, setEmission] = useState<RceEmission | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [checked, setChecked] = useState(false),
    [preview, setPreview] = useState('');
  const idRef = useRef(''),
    previewRef = useRef('');
  const fields = d.rce_fields || emptyRceFields();
  const active = e || d.rce_emission;
  function showEmission(emission: RceEmission | null) {
    setEmission(emission);
    docs.markRceEmission(
      d.id,
      emission
        ? {
            id: emission.id,
            state: emission.state,
            number: emission.number,
            environment: emission.environment,
          }
        : null,
    );
  }
  async function load() {
    const r = await apiFetch(
      '/api/sncr/rce?documentId=' + encodeURIComponent(d.id),
    );
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    showEmission(data.emission);
    if (data.emission) idRef.current = data.emission.id;
  }
  useEffect(() => {
    let alive = true;
    void apiFetch('/api/sncr/rce?action=config')
      .then(async (r) => {
        const config = await r.json();
        if (!alive) return;
        setEnabled(r.ok && config.enabled);
        if (r.ok && config.enabled && d.version) await load();
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
    // The document ID is the identity of this panel. State is loaded explicitly after actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id]);
  if (!enabled) return null;
  async function action(payload: Record<string, unknown>) {
    const r = await apiFetch('/api/sncr/rce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-RCE-Action': '1' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    return data;
  }
  async function prepare() {
    setBusy(true);
    setError('');
    try {
      const f = validateRceFields(fields);
      if (
        d.text.trim() &&
        d.text !== rceClinicalText(f) &&
        !window.confirm(
          'O texto desta receita será substituído pelos campos preenchidos abaixo. Confira se todas as orientações estão na posologia. Continuar?',
        )
      ) {
        // A blocked dialog also returns false; never leave the click silent.
        setError(
          'Preparação cancelada: o texto da receita não foi substituído pelos campos da RCE.',
        );
        return;
      }
      const saved = await docs.save({
        rce_fields: f,
        text: rceClinicalText(f),
      });
      if (!saved) {
        setError(
          'A receita não foi salva. Confira o aviso no topo do editor e tente de novo.',
        );
        return;
      }
      idRef.current ||= crypto.randomUUID();
      const data = await action({
        action: 'prepare',
        id: idRef.current,
        documentId: saved.id,
        version: saved.version,
      });
      showEmission(data.emission);
      setChecked(false);
      await docs.load();
    } catch (err) {
      setError((err as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function showPdf(original = false) {
    if (!e) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch(
        `/api/sncr/rce?action=${original ? 'original' : 'preview'}&id=${e.id}`,
      );
      if (!r.ok) throw new Error((await r.json()).error);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = URL.createObjectURL(await r.blob());
      setPreview(previewRef.current);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sign() {
    if (
      !e ||
      !checked ||
      !window.confirm(
        'Assinar esta RCE de teste? O número e o conteúdo permanecerão vinculados a esta emissão. O arquivo não terá validade para dispensação.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      const data = await action({
        action: 'sign',
        id: e.id,
        reviewedHash: e.snapshot_hash,
        numberChecked: checked,
      });
      showEmission(data.emission);
      await docs.load();
    } catch (err) {
      setError((err as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="RCE eletrônica de teste"
      style={{
        border: '1px solid var(--border)',
        padding: 16,
        margin: '16px 0',
      }}
    >
      <h3>RCE eletrônica — teste</h3>
      <p>
        Homologação, sem validade para dispensação. Use somente um paciente
        fictício. Nesta versão, uma medicação por receita.
      </p>
      {error && active && <p role="alert">{error} Os dados foram mantidos.</p>}
      {!active ? (
        <>
          <p>
            Preencha os campos que serão impressos no modelo eletrônico. A
            posologia deve conter todas as orientações ao paciente.
          </p>
          <fieldset disabled={busy || docs.busy}>
            {!fieldsShownAbove && <RceFieldsEditor docs={docs} />}
            <button className="primary" type="button" onClick={() => void prepare()}>
              Preparar RCE de teste para revisar
            </button>
          </fieldset>
          {error && <p role="alert">{error} Os dados foram mantidos.</p>}
          <p>
            Se faltar numeração,{' '}
            <Link href="/sncr" target="_blank">
              conecte o SNCR e solicite um lote de teste
            </Link>
            . O rascunho fica nesta tela.
          </p>
        </>
      ) : (
        <>
          <p role="status">{rceStateLabels[active.state]}</p>
          <p>
            Número: <strong>{active.number}</strong>
          </p>
          {e && (
            <>
              <p>
                Prescritor: {e.snapshot.prescriber.name}, CRM{' '}
                {e.snapshot.prescriber.crm}/{e.snapshot.prescriber.uf}.
                Paciente: {e.snapshot.patient.name}.
              </p>
              <p>
                {e.snapshot.medicine.name} — {e.snapshot.medicine.concentration}
                , {e.snapshot.medicine.pharmaceuticalForm}. Quantidade:{' '}
                {e.snapshot.medicine.quantity}.
              </p>
              <p style={{ whiteSpace: 'pre-wrap' }}>
                {e.snapshot.medicine.dosage}
              </p>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => void showPdf(e.state === 'SIGNED')}
              >
                {e.state === 'SIGNED'
                  ? 'Abrir original assinado de teste'
                  : 'Revisar PDF de teste'}
              </button>
              {e.state === 'SIGNED' && (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError('');
                    void action({ action: 'recoverOriginal', id: e.id })
                      .then(() => showPdf(true))
                      .catch((err) => setError(err.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Recuperar o mesmo original
                </button>
              )}
              {e.state !== 'SIGNED' && e.state !== 'BLOCKED' && (
                <>
                  <p>
                    <a
                      href="https://sncr-treinamento.anvisa.gov.br/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Abrir SNCR de treinamento para conferir este número
                    </a>
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => setChecked(event.target.checked)}
                    />{' '}
                    Revisei a RCE e conferi no SNCR que o número acima pertence
                    ao meu CRM/UF e está disponível.
                  </label>
                  <button
                    className="primary"
                    type="button"
                    disabled={busy || !checked}
                    onClick={() => void sign()}
                  >
                    {['SIGNING', 'SIGNATURE_UNCERTAIN', 'FINALIZING'].includes(
                      e.state,
                    )
                      ? 'Recuperar esta emissão'
                      : 'Assinar RCE de teste'}
                  </button>
                </>
              )}
              {e.state === 'AWAITING_REVIEW' && (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        'Descartar esta preparação? O número será inutilizado.',
                      )
                    )
                      return;
                    setBusy(true);
                    void action({ action: 'cancel', id: e.id })
                      .then(async () => {
                        showEmission(null);
                        idRef.current = '';
                        await docs.load();
                      })
                      .catch((err) => setError(err.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Descartar preparação
                </button>
              )}
            </>
          )}
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => void load().catch((err) => setError(err.message))}
          >
            Consultar andamento
          </button>
        </>
      )}
      {preview && (
        <>
          <iframe
            title="RCE de teste"
            src={preview}
            style={{
              width: '100%',
              height: 600,
              border: '1px solid var(--border)',
            }}
          />
          <a href={preview} download="rce-teste.pdf">
            Baixar PDF de teste
          </a>
        </>
      )}
    </section>
  );
}

/** Campos do modelo eletrônico oficial da RCE (um medicamento por receita). */
export function RceFieldsEditor({ docs }: { docs: DocumentsController }) {
  const d = docs.draft!;
  const fields = d.rce_fields || emptyRceFields();
  return (
    <>
        {(
          [
            ['crm', 'Seu CRM'],
            ['uf', 'UF do CRM'],
            ['passport', 'Passaporte, apenas se o paciente não tiver CPF'],
            ['medicine', 'Medicamento'],
            ['concentration', 'Concentração'],
            ['pharmaceuticalForm', 'Forma farmacêutica'],
            ['quantity', 'Quantidade'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              value={fields[key]}
              maxLength={key === 'uf' ? 2 : 200}
              onChange={(event) =>
                docs.setDraft({
                  ...d,
                  rce_fields: {
                    ...fields,
                    [key]:
                      key === 'uf'
                        ? event.target.value.toUpperCase()
                        : event.target.value,
                  },
                })
              }
            />
          </label>
        ))}
        <label>
          Posologia e orientações
          <textarea
            value={fields.dosage}
            maxLength={10000}
            onChange={(event) =>
              docs.setDraft({
                ...d,
                rce_fields: { ...fields, dosage: event.target.value },
              })
            }
          />
        </label>
    </>
  );
}
