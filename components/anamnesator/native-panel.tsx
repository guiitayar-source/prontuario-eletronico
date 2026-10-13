'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import type { AnamnesatorTarget } from './index';

type NativeRequest = {
  id: string;
  consultation_id: string;
  patient_label: string;
  source: 'android' | 'desktop';
  state: 'waiting' | 'linked' | 'received' | 'cancelled';
  pair_expires_at: string;
  device_expires_at: string | null;
  transcription: string;
  draft: string;
  revision: number;
};
type Pair = {
  id: string;
  app_url: string;
  qr: string;
  pair_expires_at: string;
};
async function request(action: string, data?: unknown) {
  const response = await apiFetch(
    '/api/anamnesator?' + action,
    data === undefined
      ? undefined
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Anamnesator-Action': '1',
          },
          body: JSON.stringify(data),
        },
  );
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload.error || 'Não foi possível acessar o Anamnesator.');
  return payload;
}

export function AnamnesatorNativePanel({
  target,
}: {
  target: AnamnesatorTarget | null;
}) {
  const [rows, setRows] = useState<NativeRequest[]>([]);
  const [pair, setPair] = useState<Pair | null>(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const consultation = target?.consultationId;
  useEffect(() => {
    if (!consultation) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        if (document.visibilityState !== 'hidden') {
          const result = await request(
            'consultationId=' + encodeURIComponent(consultation!),
          );
          if (active) {
            setRows(result.requests);
            setError('');
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 5000);
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [consultation]);
  async function create() {
    if (!consultation || target?.disabled) return;
    setBusy(true);
    setError('');
    setPair(null);
    setQr('');
    try {
      const value = (await request('action=create', {
        consultation_id: consultation,
      })) as Pair;
      setPair(value);
      const { toDataURL } = await import('qrcode');
      setQr(await toDataURL(value.qr, { width: 240, margin: 2 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(value: string) {
    setBusy(true);
    setError('');
    try {
      await request('action=cancel', { id: value });
      setRows((old) =>
        old.map((r) => (r.id === value ? { ...r, state: 'cancelled' } : r)),
      );
      if (pair?.id === value) {
        setPair(null);
        setQr('');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!consultation)
    return <p>Abra um atendimento para vincular o Anamnesator Android.</p>;
  const linked =
    pair && rows.find((r) => r.id === pair.id && r.state !== 'waiting');
  return (
    <div className="anamnesator-assistant">
      <p>
        Grave no app Anamnesator Android. O áudio vai pelo Tailscale ao PC de
        casa; somente o texto retorna ao prontuário.
      </p>
      {error && (
        <div className="capture-error" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="primary"
        disabled={busy || target?.disabled}
        onClick={() => void create()}
      >
        Vincular app ao atendimento
      </button>
      {pair && !linked && (
        <div className="info-box">
          <p>
            Abra o app neste celular ou leia o QR pelo Anamnesator Android. O
            vínculo pode ser usado uma vez e expira em 10 minutos.
          </p>
          <a className="button" href={pair.app_url}>
            Abrir Anamnesator Android
          </a>
          {qr && (
            <img
              src={qr}
              width={240}
              height={240}
              alt="QR para vincular o aplicativo a este atendimento"
            />
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void cancel(pair.id)}
          >
            Cancelar vínculo
          </button>
        </div>
      )}
      {rows.map((value) => (
        <details key={value.id} open={value.state === 'received'}>
          <summary>
            {value.state === 'received'
              ? value.source === 'desktop'
                ? 'Texto recebido do computador'
                : 'Texto recebido do Android'
              : value.state === 'cancelled'
                ? 'Vínculo cancelado'
                : Date.parse(
                      value.device_expires_at || value.pair_expires_at,
                    ) <= Date.now()
                  ? 'Vínculo expirado'
                  : value.state === 'linked'
                    ? 'App vinculado · aguardando resultado'
                    : 'Aguardando o app'}
          </summary>
          {value.transcription && (
            <label>
              Transcrição · revise antes de inserir
              <textarea readOnly value={value.transcription} />
              <button
                type="button"
                className="secondary"
                disabled={target?.disabled}
                onClick={() => target?.apply(value.transcription, 'append')}
              >
                Acrescentar transcrição à evolução
              </button>
            </label>
          )}
          {value.draft && (
            <label>
              Rascunho clínico · revise antes de inserir
              <textarea readOnly value={value.draft} />
              <button
                type="button"
                className="secondary"
                disabled={target?.disabled}
                onClick={() => target?.apply(value.draft, 'append')}
              >
                Acrescentar rascunho à evolução
              </button>
            </label>
          )}
          {value.source === 'android' && value.state !== 'cancelled' && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void cancel(value.id)}
            >
              Encerrar autorização do app
            </button>
          )}
        </details>
      ))}
    </div>
  );
}
