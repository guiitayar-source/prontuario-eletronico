'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import {
  isSignatureProviderId,
  signatureProviderLabel,
  type SignatureProviderId,
} from '@/lib/signature/providers';

/**
 * Qual certificado em nuvem o médico usa (Bird ID ou VIDaaS). A escolha fica neste navegador e
 * só aparece em Ajustes quando o servidor tem mais de um provedor configurado; com um só, é ele.
 */
const KEY = 'psywrite-signature-provider';
let configured: SignatureProviderId[] = [];
let chosen: string | null = null;
let started = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function load() {
  if (started) return;
  started = true;
  try {
    chosen = localStorage.getItem(KEY);
  } catch {
    // Sem armazenamento local: vale o primeiro provedor configurado.
  }
  apiFetch('/api/digital-signature/providers')
    .then((r) => (r.ok ? r.json() : { providers: [] }))
    .then((data: { providers?: unknown[] }) => {
      configured = (data.providers || []).filter(isSignatureProviderId);
      notify();
    })
    .catch(() => {
      started = false;
    });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => `${configured.join(',')}|${chosen ?? ''}`;

export function useSignatureProvider(enabled = true) {
  useSyncExternalStore(subscribe, snapshot, () => '|');
  useEffect(() => {
    if (enabled) load();
  }, [enabled]);
  // Sem a lista (ainda carregando, ou nada configurado), a tela segue falando do Bird ID.
  const providers: SignatureProviderId[] = configured.length
    ? configured
    : ['birdid'];
  const id = providers.find((provider) => provider === chosen) ?? providers[0];
  return {
    id,
    label: signatureProviderLabel(id),
    providers,
    choose(next: SignatureProviderId) {
      chosen = next;
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // A escolha vale só até recarregar a página.
      }
      notify();
    },
  };
}

/** Seletor para Ajustes; não aparece quando só um provedor está disponível. */
export function SignatureProviderPicker() {
  const signature = useSignatureProvider();
  if (signature.providers.length < 2) return null;
  return (
    <label>
      Certificado em nuvem
      <select
        value={signature.id}
        onChange={(e) => {
          if (isSignatureProviderId(e.target.value))
            signature.choose(e.target.value);
        }}
      >
        {signature.providers.map((provider) => (
          <option key={provider} value={provider}>
            {signatureProviderLabel(provider)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Aviso de validação expirada com a página aberta: revalida sem recarregar. */
export function SignatureExpiredNotice({
  provider,
  busy,
  onRevalidate,
}: {
  provider: string;
  busy?: boolean;
  onRevalidate: () => void;
}) {
  const label = signatureProviderLabel(provider);
  return (
    <div className="capture-error" role="alert">
      <span>
        A validação do {label} expirou. Revalide o certificado para assinar;
        o que está nesta tela continua aqui.
      </span>
      <button type="button" disabled={busy} onClick={onRevalidate}>
        Revalidar {label}
      </button>
    </div>
  );
}
