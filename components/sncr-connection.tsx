'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';

type Status = {
  state: string;
  expiresAt?: string | null;
  identityStatus?: string;
};
const labels: Record<string, string> = {
  disabled: 'SNCR não conectado — conexão desabilitada neste ambiente.',
  disconnected: 'SNCR não conectado.',
  pending: 'Autenticação pendente.',
  exchanging: 'Concluindo autenticação.',
  connected:
    'Sessão recebida do SNCR. A identidade ainda não pôde ser comprovada; emissão bloqueada.',
  expired: 'Sessão expirada. Autentique novamente.',
  failed: 'Autorização recusada ou conexão indisponível. Autentique novamente.',
  uncertain: 'Resultado da autenticação incerto. Inicie nova conexão.',
  rejected: 'Sessão rejeitada. Autentique novamente.',
  identity_mismatch:
    'Perfil incompatível com a sessão. Revise seus dados e autentique novamente.',
};
export function SncrConnection() {
  const [status, setStatus] = useState<Status>({ state: 'loading' }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function check() {
    try {
      const r = await apiFetch('/api/sncr/auth');
      const d = await r.json();
      if (!r.ok) throw Error(d.error || 'Consulta SNCR indisponível.');
      setStatus(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void check();
    const focus = () => {
      void check();
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  useEffect(() => {
    if (status.state !== 'connected' || !status.expiresAt) return;
    const timer = setTimeout(
      () => {
        setStatus((s) => ({ ...s, state: 'expired' }));
      },
      Math.max(0, Math.min(30000, Date.parse(status.expiresAt) - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [status]);
  async function connect() {
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/sncr/auth', {
        method: 'POST',
        headers: { 'X-SNCR-Action': '1' },
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || 'Conexão indisponível.');
      setStatus({ state: 'pending' });
      window.location.assign(d.authorizationUrl);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/sncr/auth', {
        method: 'DELETE',
        headers: { 'X-SNCR-Action': '1' },
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || 'Não foi possível desconectar.');
      setStatus(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card" aria-label="Conexão SNCR">
      <h2>Conexão SNCR</h2>
      <p role="status">{labels[status.state] || 'Consultando conexão SNCR…'}</p>
      <p>
        A conexão gov.br é individual e independente do certificado Bird
        ID/VIDaaS. A emissão real permanece bloqueada.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={
          busy || status.state === 'disabled' || status.state === 'loading'
        }
        onClick={() => void connect()}
      >
        Conectar ao SNCR
      </button>{' '}
      {status.state !== 'disabled' && status.state !== 'loading' && (
        <button type="button" disabled={busy} onClick={() => void disconnect()}>
          Desconectar sessão local
        </button>
      )}
      <p>Desconectar aqui não revoga a sessão na Anvisa.</p>
    </section>
  );
}
