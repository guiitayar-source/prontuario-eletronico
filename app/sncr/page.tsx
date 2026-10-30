'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/supabase/http';
import { useAccess } from '@/components/auth';
import {
  prescriptionCategories,
  type PrescriptionCategory,
} from '@/lib/sncr/policy';

const stateLabels: Record<string, string> = {
  ALLOCATED:
    'Todos os números deste lote já foram reservados. Nenhum será reutilizado.',
  AUTH_PENDING: 'Aguardando autenticação do prescritor.',
  AUTH_EXPIRED: 'A autenticação expirou antes da solicitação de numeração.',
  AUTH_FAILED: 'Falha de autenticação. Nenhum pedido de numeração foi enviado.',
  REQUESTING: 'Solicitação em andamento. Não repita o pedido.',
  UNKNOWN:
    'Resultado incerto. É necessária conferência; não solicite outro lote.',
  REJECTED:
    'Solicitação não concluída pelo SNCR. Confira os dados e as cotas antes de iniciar outra.',
  CONTRACT_REVIEW:
    'Retorno preservado para conferência. O lote não está liberado para uso.',
  RECEIVED_UNVERIFIED:
    'Numeração recebida em homologação e em quarentena. O vínculo com o prescritor ainda precisa ser conferido.',
};
type Lot = {
  first: string;
  last: string;
  total: number;
  available: number;
  reserved: number;
  used: number;
  void: number;
};
export default function SncrPreparation() {
  const { clinic, role } = useAccess();
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [category, setCategory] = useState<PrescriptionCategory>('RCE'),
    [crm, setCrm] = useState(''),
    [uf, setUf] = useState('SP'),
    [quantity, setQuantity] = useState(10),
    [message, setMessage] = useState(''),
    [requestId, setRequestId] = useState(''),
    [terminal, setTerminal] = useState(false),
    [review, setReview] = useState(false),
    [requestState, setRequestState] = useState(''),
    [lot, setLot] = useState<Lot | null>(null);
  const callbackHandled = useRef(false);
  const storageKey = 'psywrite:sncr:hmg:' + clinic;

  async function reloadLot() {
    const r = await apiFetch('/api/sncr');
    if (r.ok) setLot((await r.json()).lot);
  }
  async function refresh(id = requestId) {
    if (!id) return;
    const r = await apiFetch('/api/sncr?id=' + encodeURIComponent(id));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    setTerminal(
      ['AUTH_FAILED', 'AUTH_EXPIRED', 'REJECTED'].includes(data.request.state),
    );
    setReview(data.request.state === 'CONTRACT_REVIEW');
    setRequestState(data.request.state);
    setMessage(stateLabels[data.request.state] || 'Conferência necessária.');
  }
  // Rereads the response already stored for this request; no new Anvisa call.
  async function reprocess() {
    setBusy(true);
    try {
      const r = await apiFetch('/api/sncr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SNCR-Action': '1' },
        body: JSON.stringify({ action: 'reprocess', id: requestId }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      await refresh();
      await reloadLot();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!clinic || callbackHandled.current) return;
    callbackHandled.current = true;
    const query = new URLSearchParams(window.location.search);
    const sessionId = query.get('session_id');
    // Remove the one-use secret immediately; no analytics, logs or storage.
    window.history.replaceState({}, '', '/sncr');
    let id = sessionStorage.getItem(storageKey) || '';
    setRequestId(id);
    void (async () => {
      const config = await apiFetch('/api/sncr');
      const status = await config.json();
      if (!config.ok) throw new Error(status.error);
      setEnabled(status.environment === 'hmg');
      setLot(status.lot);
      // Another tab (or a lost sessionStorage) must resume the open request.
      if (!sessionId && status.openRequestId && status.openRequestId !== id) {
        id = status.openRequestId;
        sessionStorage.setItem(storageKey, id);
        setRequestId(id);
      }
      if (!sessionId) {
        if (id && status.environment === 'hmg') await refresh(id);
        return;
      }
      if (!id)
        throw new Error(
          'Não foi encontrada uma solicitação iniciada neste navegador.',
        );
      setBusy(true);
      const r = await apiFetch('/api/sncr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SNCR-Action': '1' },
        body: JSON.stringify({ action: 'complete', id, sessionId }),
      });
      const data = await r.json();
      if (!r.ok) {
        // Only read status after an uncertain response; NEVER repeat the POST.
        await refresh(id).catch(() => {});
        throw new Error(data.error);
      }
      setMessage(stateLabels[data.state] || 'Conferência necessária.');
      await reloadLot();
    })()
      .catch((e) => setMessage(e.message))
      .finally(() => setBusy(false));
    // Run once after AuthGate establishes the clinic; callback must not replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinic]);

  async function start() {
    setBusy(true);
    setMessage('');
    // Retain the id across a lost response/reload. A second click with changed
    // input is rejected by the server instead of allocating another batch.
    const id = requestId || crypto.randomUUID();
    sessionStorage.setItem(storageKey, id);
    setRequestId(id);
    try {
      const r = await apiFetch('/api/sncr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SNCR-Action': '1' },
        body: JSON.stringify({
          action: 'start',
          id,
          input: {
            category,
            conselho: 'CRM',
            documento: crm,
            uf,
            quantidade: quantity,
          },
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      window.location.assign(data.loginUrl);
    } catch (e) {
      setMessage((e as Error).message);
      setBusy(false);
    }
  }
  if (!['owner', 'doctor'].includes(role))
    return (
      <main className="sncr-page">
        <p>Acesso exclusivo do prescritor.</p>
      </main>
    );
  const pending = !!requestId && requestState !== '' && !terminal;
  return (
    <main className="sncr-page">
      <header className="sncr-section">
        <h1>SNCR — numeração de teste</h1>
        <p className="sncr-note">
          Homologação da Anvisa, sem validade para dispensação. Esta página só
          pede e acompanha a numeração; a RCE é feita no editor da receita, no
          passo a passo “RCE com numeração SNCR”.
        </p>
        {!enabled && (
          <p role="status" className="sncr-alert">
            Integração desabilitada neste servidor (SNCR_ENVIRONMENT diferente
            de hmg).
          </p>
        )}
      </header>

      <section className="sncr-section" aria-label="Seu lote">
        <h2>Seu lote de teste</h2>
        {lot ? (
          <dl className="sncr-lot">
            <div>
              <dt>Faixa</dt>
              <dd>
                {lot.first} a {lot.last}
              </dd>
            </div>
            <div>
              <dt>Disponíveis</dt>
              <dd>
                {lot.available} de {lot.total}
              </dd>
            </div>
            <div>
              <dt>Reservados</dt>
              <dd>{lot.reserved}</dd>
            </div>
            <div>
              <dt>Usados</dt>
              <dd>{lot.used}</dd>
            </div>
          </dl>
        ) : (
          <p className="sncr-note">Nenhum lote recebido ainda.</p>
        )}
        <p className="sncr-note">
          Os números ficam em quarentena até a conferência no SNCR, feita na
          própria receita antes de assinar.
        </p>
      </section>

      {requestId && (
        <section className="sncr-section" aria-label="Pedido em aberto">
          <h2>Pedido de numeração</h2>
          <p className="sncr-request">
            <span className="sncr-request-state">{message || 'Consultando…'}</span>
            <span className="sncr-note">Pedido {requestId}</span>
          </p>
          <div className="sncr-actions">
            {review && (
              <button className="primary" type="button" disabled={busy} onClick={() => void reprocess()}>
                Conferir de novo o retorno gravado
              </button>
            )}
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void refresh().catch((e) => setMessage(e.message))}
            >
              Consultar resultado
            </button>
            {terminal && (
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  sessionStorage.removeItem(storageKey);
                  setRequestId('');
                  setRequestState('');
                  setTerminal(false);
                  setMessage('Revise os dados antes de iniciar outra solicitação.');
                }}
              >
                Preparar nova solicitação
              </button>
            )}
          </div>
        </section>
      )}

      <section className="sncr-section" aria-label="Solicitar numeração">
        <h2>Solicitar numeração</h2>
        {pending ? (
          <p className="sncr-note">
            Há um pedido em aberto acima. Um novo pedido só é possível depois
            que ele for resolvido; cada lote gasta cota do prescritor.
          </p>
        ) : (
          <fieldset className="sncr-form" disabled={!enabled || busy}>
            <label className="sncr-field">
              <span>Tipo de receituário</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as PrescriptionCategory)}
              >
                {Object.entries(prescriptionCategories)
                  .filter(([key]) => key !== 'SIMPLES')
                  .map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="sncr-field">
              <span>Seu CRM (só números)</span>
              <input inputMode="numeric" maxLength={15} value={crm} onChange={(e) => setCrm(e.target.value)} />
            </label>
            <label className="sncr-field sncr-field-uf">
              <span>UF</span>
              <input maxLength={2} value={uf} onChange={(e) => setUf(e.target.value.toUpperCase())} />
            </label>
            {!['RCE', 'RET'].includes(category) && (
              <label className="sncr-field">
                <span>Quantidade (10 a 50)</span>
                <input
                  type="number"
                  min={10}
                  max={50}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </label>
            )}
            <p className="sncr-note sncr-form-note">
              {['RCE', 'RET'].includes(category)
                ? 'O SNCR fornece 1.000 números por lote, até 3 pedidos por mês. O login é com a sua conta gov.br (no teste, a conta do gov.br de homologação).'
                : 'Em produção, as notificações dependem de numeração autorizada pela Vigilância Sanitária.'}
            </p>
            <button className="primary" type="button" onClick={() => void start()}>
              Solicitar lote com gov.br
            </button>
          </fieldset>
        )}
        {!requestId && message && (
          <p role="status" className="sncr-alert">
            {message}
          </p>
        )}
      </section>

      <Link href="/" className="sncr-back">
        Voltar ao prontuário
      </Link>
    </main>
  );
}
