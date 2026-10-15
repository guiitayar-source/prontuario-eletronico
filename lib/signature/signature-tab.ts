import { useEffect, useRef } from 'react';
import { apiFetch } from '@/lib/supabase/http';

/**
 * Autenticação no certificado em nuvem (Bird ID ou VIDaaS) em uma aba separada. Navegar a aba
 * atual destruiria o que vive na memória da página (gravação e transcrição do Anamnesator, por
 * exemplo).
 *
 * A aba é aberta no clique, antes de qualquer `await`, para o bloqueador de pop-up não barrá-la.
 * Na volta, `app/page.tsx` avisa as demais abas pelo canal abaixo e a aba original fecha a nova.
 */
const CHANNEL = 'psywrite-birdid';
const WAIT_LIMIT_MS = 10 * 60 * 1000;

export type SignatureTabResult =
  | { status: 'connected' }
  | { status: 'error'; message: string };

/** Abre a aba em branco. Retorna `null` se o navegador bloqueou (use o redirecionamento). */
export function openSignatureTab(label: string): Window | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined')
    return null;
  const tab = window.open('', '_blank');
  if (!tab) return null;
  try {
    // O site do provedor não deve enxergar esta aplicação por window.opener.
    tab.opener = null;
    tab.document.title = label;
    tab.document.body.textContent = `Abrindo o ${label}…`;
  } catch {
    // Aba sem acesso ao documento: segue só com a navegação.
  }
  return tab;
}

/** Endereço de login no provedor, com o estado OAuth já salvo no servidor. */
export async function fetchSignatureAuthorizationUrl(
  provider: string,
): Promise<string> {
  const r = await apiFetch(
    `/api/digital-signature/birdid/authorize?provider=${encodeURIComponent(provider)}`,
  );
  const data = (await r.json()) as {
    authorizationUrl?: string;
    error?: string;
  };
  if (!r.ok || !data.authorizationUrl)
    throw new Error(
      data.error || 'Falha ao iniciar a autenticação do certificado digital.',
    );
  return data.authorizationUrl;
}

/** Leva a aba ao provedor e a fecha quando a autenticação terminar (ou ela for abandonada). */
export function sendTabToProvider(tab: Window, authorizationUrl: string) {
  tab.location.href = authorizationUrl;
  const channel = new BroadcastChannel(CHANNEL);
  const started = Date.now();
  const end = () => {
    clearInterval(timer);
    channel.close();
    if (!tab.closed) tab.close();
  };
  const timer = setInterval(() => {
    if (tab.closed || Date.now() - started > WAIT_LIMIT_MS) end();
  }, 1000);
  channel.onmessage = end;
}

/** Chamado pela aba que voltou do provedor, para avisar a aba original. */
export function announceSignatureResult(result: SignatureTabResult) {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(result);
  channel.close();
}

/** Escuta o resultado da autenticação feita em outra aba. */
export function useSignatureResult(
  handler: (result: SignatureTabResult) => void,
) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<SignatureTabResult>) =>
      latest.current(event.data);
    return () => channel.close();
  }, []);
}
