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
    [review, setReview] = useState(false);
  const callbackHandled = useRef(false);
  const storageKey = 'psywrite:sncr:hmg:' + clinic;

  async function refresh(id = requestId) {
    if (!id) return;
    const r = await apiFetch('/api/sncr?id=' + encodeURIComponent(id));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    setTerminal(
      ['AUTH_FAILED', 'AUTH_EXPIRED', 'REJECTED'].includes(data.request.state),
    );
    setReview(data.request.state === 'CONTRACT_REVIEW');
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
    const id = sessionStorage.getItem(storageKey) || '';
    setRequestId(id);
    void (async () => {
      const config = await apiFetch('/api/sncr');
      const status = await config.json();
      if (!config.ok) throw new Error(status.error);
      setEnabled(status.environment === 'hmg');
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
      <main>
        <p>Acesso exclusivo do prescritor.</p>
      </main>
    );
  return (
    <main style={{ maxWidth: 720, padding: 24, margin: 'auto' }}>
      <h1>SNCR — numeração de teste</h1>
      <p>
        Ambiente de homologação, sem validade para dispensação. Esta tela
        solicita somente numeração e não utiliza dados de pacientes. Para a RCE,
        após receber o lote, volte ao editor da receita de um paciente fictício
        e use “Preparar RCE de teste para revisar”. Confira o vínculo do número
        com seu CRM/UF antes de assinar.
      </p>
      <p>
        A emissão de teste está implementada para RCE, com uma medicação por
        receita. RET e notificações têm somente a solicitação de numeração; a
        emissão dessas categorias continua indisponível.
      </p>
      <p>
        A autenticação exige a conta gov.br de um profissional com inscrição
        ativa. Não há credenciais fixas de parceiro. A assinatura ICP-Brasil é
        uma etapa independente.
      </p>
      {!enabled && (
        <p role="status">
          Integração desabilitada. A equipe técnica precisa configurar o
          ambiente de homologação e aplicar a migração local antes de testar.
        </p>
      )}
      <fieldset disabled={!enabled || busy}>
        <legend>Solicitar numeração de teste</legend>
        <label>
          Tipo de receituário
          <select
            value={category}
            onChange={(e) =>
              setCategory(e.target.value as PrescriptionCategory)
            }
          >
            {Object.entries(prescriptionCategories).filter(([key]) => key !== 'SIMPLES').map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Seu CRM
          <input
            inputMode="numeric"
            maxLength={15}
            value={crm}
            onChange={(e) => setCrm(e.target.value)}
          />
        </label>
        <label>
          UF do CRM
          <input
            maxLength={2}
            value={uf}
            onChange={(e) => setUf(e.target.value.toUpperCase())}
          />
        </label>
        {!['RCE', 'RET'].includes(category) && (
          <label>
            Quantidade (10 a 50)
            <input
              type="number"
              min={10}
              max={50}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </label>
        )}
        <p>
          {['RCE', 'RET'].includes(category)
            ? 'O SNCR fornece 1.000 números por lote. As cotas são do prescritor.'
            : 'Em produção, as notificações dependem de numeração autorizada pela Vigilância Sanitária.'}
        </p>
        <button type="button" onClick={() => void start()}>
          Solicitar lote de teste com gov.br
        </button>
      </fieldset>
      {requestId && (
        <p>
          Solicitação: {requestId}{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh().catch((e) => setMessage(e.message))}
          >
            Consultar resultado
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {review && (
        <button type="button" disabled={busy} onClick={() => void reprocess()}>
          Conferir de novo o retorno gravado
        </button>
      )}
      {terminal && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            sessionStorage.removeItem(storageKey);
            setRequestId('');
            setTerminal(false);
            setMessage('Revise os dados antes de iniciar outra solicitação.');
          }}
        >
          Preparar nova solicitação
        </button>
      )}
      <p>
        Após rejeição ou falha de autenticação confirmada, uma nova tentativa
        exige iniciar outra solicitação. Resultados incertos e lotes em
        quarentena exigem conferência pela equipe técnica.
      </p>
      <Link href="/">Voltar ao prontuário</Link>
    </main>
  );
}
