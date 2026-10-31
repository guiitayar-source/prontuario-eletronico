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
import type { DocumentProfile } from '@/lib/document-fields';

// One config request per page; the editor footer and the panel share it.
type RceEnvironment = 'hmg' | 'prd' | null;
let rceConfig: Promise<RceEnvironment> | null = null;
export function useRceEnvironment() {
  const [environment, setEnvironment] = useState<RceEnvironment>(null);
  useEffect(() => {
    rceConfig ||= apiFetch('/api/sncr/rce?action=config')
      .then(async (r): Promise<RceEnvironment> => {
        const config = r.ok ? await r.json() : null;
        return config?.enabled === true &&
          (config.environment === 'hmg' || config.environment === 'prd')
          ? config.environment
          : null;
      })
      .catch(() => {
        rceConfig = null;
        return null;
      });
    let alive = true;
    void rceConfig.then((v) => alive && setEnvironment(v));
    return () => {
      alive = false;
    };
  }, []);
  return environment;
}

// Os campos ficam na seção "RCE eletrônica" do editor; aqui só o passo a passo.
export function RcePanel({ docs }: { docs: DocumentsController }) {
  const d = docs.draft!;
  const [enabled, setEnabled] = useState(false),
    [e, setEmission] = useState<RceEmission | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [checked, setChecked] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [preview, setPreview] = useState('');
  const production = useRceEnvironment() === 'prd';
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
      setReviewed(false);
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
      if (!original) setReviewed(true);
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
        production
          ? 'Assinar esta RCE? O número e o conteúdo ficam vinculados a esta emissão, e a receita passa a valer para dispensação. Não é possível alterar depois.'
          : 'Assinar esta RCE de teste? O número e o conteúdo permanecerão vinculados a esta emissão. O arquivo não terá validade para dispensação.',
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
  const state = active?.state;
  const recovering =
    !!state && ['SIGNING', 'SIGNATURE_UNCERTAIN', 'FINALIZING'].includes(state);
  const closed = state === 'BLOCKED' || state === 'CANCELLED';
  // The next action decides the current step; everything before it is done.
  const current = !active
    ? 1
    : state === 'SIGNED'
      ? 6
      : recovering || closed
        ? 5
        : !reviewed
          ? 3
          : !checked
            ? 4
            : 5;
  const missing = active ? [] : missingForRce(fields, docs.profile);
  const alert = error && (
    <p role="alert" className="rce-alert">
      {error} Os dados foram mantidos.
    </p>
  );
  return (
    <section
      aria-label={production ? 'RCE eletrônica' : 'RCE eletrônica de teste'}
      className="rce-flow"
    >
      <header className="rce-flow-head">
        <h3>{production ? 'RCE com numeração SNCR' : 'RCE com numeração SNCR — teste'}</h3>
        <p>
          {production
            ? 'Numeração real da Anvisa e assinatura qualificada ICP-Brasil. Uma medicação por receita.'
            : 'Homologação, sem validade para dispensação. Só paciente fictício e uma medicação por receita.'}
        </p>
      </header>
      <ol className="rce-steps">
        <Step
          current={current}
          n={1}
          title="Dados da RCE"
          detail={active ? 'Conteúdo fixado para esta emissão.' : 'Campos da seção “RCE eletrônica” acima.'}
        >
          {missing.length ? (
            <div className="rce-missing">
              <span>Antes de preparar, falta:</span>
              <ul>
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="rce-step-note">
              Tudo preenchido. Ao preparar, um número do seu lote fica reservado
              para esta receita.
            </p>
          )}
          <button
            className="primary"
            type="button"
            disabled={busy || docs.busy || missing.length > 0}
            onClick={() => void prepare()}
          >
            Preparar e reservar número
          </button>
          {alert}
          <p className="rce-step-note">
            {production ? 'Sem lote?' : 'Sem lote de teste?'}{' '}
            <Link href="/sncr" target="_blank">
              Solicite a numeração no SNCR
            </Link>
            .
          </p>
        </Step>
        <Step
          current={current}
          n={2}
          title="Numeração SNCR"
          detail={
            active?.number ? (
              <>
                Nº <strong>{active.number}</strong>
              </>
            ) : (
              'Reservada do seu lote ao preparar.'
            )
          }
        />
        <Step current={current} n={3} title="Revisar o PDF" detail={production ? 'Modelo oficial da Anvisa.' : 'Modelo oficial da Anvisa, com a marca de homologação.'}>
          <button className="primary" type="button" disabled={busy} onClick={() => void showPdf(false)}>
            {production ? 'Revisar PDF' : 'Revisar PDF de teste'}
          </button>
          {alert}
        </Step>
        <Step current={current} n={4} title="Conferir no SNCR" detail="O número precisa estar no seu CRM/UF.">
          <a
            className="secondary rce-link-button"
            href={production ? 'https://sncr.anvisa.gov.br/' : 'https://sncr-treinamento.anvisa.gov.br/'}
            target="_blank"
            rel="noreferrer"
          >
            {production ? 'Abrir SNCR' : 'Abrir SNCR de treinamento'}
          </a>
          <label className="rce-check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            Revisei a RCE e conferi no SNCR que o número {active?.number} é do
            meu CRM/UF e está disponível.
          </label>
        </Step>
        <Step
          current={current}
          n={5}
          title="Assinar"
          detail={
            docs.signatureSession
              ? `Certificado conectado: ${docs.signatureSession.provider === 'vidaas' ? 'VIDaaS' : 'Bird ID'}.`
              : 'Certificado ainda não conectado nesta sessão.'
          }
        >
          {recovering || closed ? (
            <div className="rce-recovery">
              <p>{rceStateLabels[state!]}</p>
              {recovering && (
                <div className="rce-actions">
                  <button className="secondary" type="button" disabled={busy} onClick={() => void sign()}>
                    Recuperar esta emissão
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => void load().catch((err) => setError(err.message))}
                  >
                    Consultar andamento
                  </button>
                </div>
              )}
              <p className="rce-step-note">
                {production ? 'Para seguir' : 'Para seguir o teste'}, use “Duplicar como novo rascunho” abaixo:
                a cópia recebe outro número.
              </p>
            </div>
          ) : !docs.signatureSession ? (
            <>
              <p className="rce-step-note">
                Conecte o Bird ID logo antes de assinar: a sessão vale poucos
                minutos.
              </p>
              <button
                className="primary"
                type="button"
                disabled={busy || docs.busy}
                onClick={() => void docs.connectSignature('birdid')}
              >
                Conectar Bird ID
              </button>
            </>
          ) : (
            <button className="primary" type="button" disabled={busy || !checked} onClick={() => void sign()}>
              {production ? 'Assinar RCE' : 'Assinar RCE de teste'}
            </button>
          )}
          {alert}
        </Step>
        <Step current={current} n={6} title="Original assinado" detail={state === 'SIGNED' ? rceStateLabels.SIGNED : undefined}>
          <div className="rce-actions">
            <button className="primary" type="button" disabled={busy} onClick={() => void showPdf(true)}>
              Abrir original assinado
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void action({ action: 'recoverOriginal', id: e!.id })
                  .then(() => showPdf(true))
                  .catch((err) => setError(err.message))
                  .finally(() => setBusy(false));
              }}
            >
              Recuperar o mesmo original
            </button>
          </div>
          {alert}
        </Step>
      </ol>
      {state === 'AWAITING_REVIEW' && (
        <button
          className="text-button rce-discard"
          type="button"
          disabled={busy}
          onClick={() => {
            if (!window.confirm('Descartar esta preparação? O número será inutilizado.')) return;
            setBusy(true);
            void action({ action: 'cancel', id: e!.id })
              .then(async () => {
                showEmission(null);
                idRef.current = '';
                setReviewed(false);
                await docs.load();
              })
              .catch((err) => setError(err.message))
              .finally(() => setBusy(false));
          }}
        >
          Descartar preparação (o número não volta)
        </button>
      )}
      {preview && (
        <div className="rce-preview">
          <iframe title={production ? 'RCE' : 'RCE de teste'} src={preview} />
          <a
            href={preview}
            download={`rce${production ? '' : '-teste'}${state === 'SIGNED' ? '-assinada' : ''}.pdf`}
          >
            Baixar este PDF
          </a>
        </div>
      )}
    </section>
  );
}

function Step({
  n,
  current,
  title,
  detail,
  children,
}: {
  n: number;
  current: number;
  title: string;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const state = n < current ? 'done' : n === current ? 'current' : 'pending';
  return (
    <li className="rce-step" data-state={state} aria-current={n === current ? 'step' : undefined}>
      <span className="rce-step-marker" aria-hidden="true">
        {n < current ? '✓' : n}
      </span>
      <div className="rce-step-content">
        <span className="rce-step-title">{title}</span>
        {detail && <span className="rce-step-detail">{detail}</span>}
        {n === current && children && <div className="rce-step-body">{children}</div>}
      </div>
    </li>
  );
}

/** O que falta antes de preparar; mesmas regras que o servidor confere. */
export function missingForRce(
  fields: ReturnType<typeof emptyRceFields>,
  profile: DocumentProfile,
) {
  const out: string[] = [];
  try {
    validateRceFields(fields);
  } catch (err) {
    out.push((err as Error).message + ' (seção “RCE eletrônica”)');
  }
  if (!profile.letterhead_address?.trim() || !profile.letterhead_phone?.trim())
    out.push('Endereço e telefone do consultório (Ajustes › Meus dados profissionais)');
  if (!profile.cpf)
    out.push('Seu CPF, gravado ao conectar o certificado (Ajustes › Assinatura digital)');
  return out;
}

/** Campos do modelo eletrônico oficial da RCE (um medicamento por receita). */
export function RceFieldsEditor({ docs }: { docs: DocumentsController }) {
  const d = docs.draft!;
  const fields = d.rce_fields || emptyRceFields();
  type Key = keyof typeof fields;
  const input = (key: Key, label: string, hint?: string) => (
    <label key={key} className="rce-field">
      <span>{label}</span>
      <input
        value={fields[key]}
        maxLength={key === 'uf' ? 2 : 200}
        placeholder={hint}
        onChange={(event) =>
          docs.setDraft({
            ...d,
            rce_fields: {
              ...fields,
              [key]: key === 'uf' ? event.target.value.toUpperCase() : event.target.value,
            },
          })
        }
      />
    </label>
  );
  return (
    <div className="rce-fields">
      <div className="rce-field-group">
        <h4>Medicamento</h4>
        <div className="rce-field-row rce-field-row-medicine">
          {input('medicine', 'Nome', 'Ex.: Donaren')}
          {input('concentration', 'Concentração', 'Ex.: 50 mg')}
        </div>
        <div className="rce-field-row">
          {input('pharmaceuticalForm', 'Forma farmacêutica', 'Ex.: Comprimido')}
          {input('quantity', 'Quantidade', 'Ex.: 60 (sessenta) comprimidos')}
        </div>
        <label className="rce-field">
          <span>Posologia e orientações</span>
          <textarea
            value={fields.dosage}
            maxLength={10000}
            placeholder="Ex.: Tomar 1 comprimido à noite."
            onChange={(event) =>
              docs.setDraft({
                ...d,
                rce_fields: { ...fields, dosage: event.target.value },
              })
            }
          />
        </label>
      </div>
      <div className="rce-field-group">
        <h4>Prescritor e paciente</h4>
        <div className="rce-field-row rce-field-row-crm">
          {input('crm', 'Seu CRM')}
          {input('uf', 'UF')}
          {input('passport', 'Passaporte do paciente', 'Só se o paciente não tiver CPF')}
        </div>
      </div>
    </div>
  );
}
