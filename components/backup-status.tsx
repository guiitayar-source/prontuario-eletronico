'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import { backupWarnings, type BackupStatus } from '@/lib/backup-status';

const date = (value: string) =>
  new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
export function BackupStatusPanel() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copiedAt, setCopiedAt] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(Date.now);
  async function load() {
    const r = await apiFetch('/api/backup-status');
    const data = await r.json();
    if (!r.ok)
      throw new Error(data.error || 'Não foi possível consultar os backups.');
    setStatus(data);
    setNow(Date.now());
  }
  useEffect(() => {
    let active = true;
    void apiFetch('/api/backup-status')
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok)
          throw new Error(
            data.error || 'Não foi possível consultar os backups.',
          );
        if (active) setStatus(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function declareCopy() {
    if (!status?.verified || !confirmed || !copiedAt) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/backup-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Backup-Action': '1' },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          verified_event_id: status.verified.id,
          copied_at: new Date(copiedAt + ':00-03:00').toISOString(),
        }),
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(
          data.error || 'Não foi possível registrar a declaração.',
        );
      setConfirmed(false);
      setCopiedAt('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <h2>Recuperação por backup</h2>
      <p>
        Verificações comunicadas pela rotina de backup e cópias externas
        declaradas pelo titular.
      </p>
      {error && (
        <p role="alert" className="capture-error">
          {error}
        </p>
      )}
      {!status && !error && <p>Carregando…</p>}
      {status && (
        <>
          <dl>
            <dt>Último backup verificado automaticamente</dt>
            <dd>
              {status.verified
                ? date(status.verified.occurred_at)
                : 'Sem informação'}
            </dd>
            {status.verified && (
              <>
                <dt>Dados copiados a partir de</dt>
                <dd>{date(status.verified.backup_at)}</dd>
                <dt>Duração do ensaio de restauração e conferência</dt>
                <dd>{status.verified.verification_seconds} segundos</dd>
              </>
            )}
            <dt>Última cópia externa declarada</dt>
            <dd>
              {status.external
                ? `${date(status.external.occurred_at)} — dados de ${date(status.external.backup_at)}`
                : 'Sem declaração'}
            </dd>
          </dl>
          {backupWarnings(status, now).map((message) => (
            <p role="status" key={message}>
              {message}
            </p>
          ))}
          <p className="muted">
            Avisos após 36 horas para o backup e 7 dias para os dados da cópia
            externa. A declaração não verifica o destino externo. O ensaio não
            mede todo o tempo necessário para retomar o atendimento.
          </p>
          {status.available && status.verified && (
            <form
              className="context-form"
              onSubmit={(e) => {
                e.preventDefault();
                void declareCopy();
              }}
            >
              <label>
                Data da cópia externa (UTC−03)
                <input
                  type="datetime-local"
                  required
                  value={copiedAt}
                  onChange={(e) => setCopiedAt(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                Confirmo que copiei o backup verificado acima para um destino
                independente do computador de origem.
              </label>
              <button disabled={busy || !confirmed}>
                Registrar declaração de cópia externa
              </button>
            </form>
          )}
        </>
      )}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        Atualizar situação dos backups
      </button>
    </section>
  );
}
