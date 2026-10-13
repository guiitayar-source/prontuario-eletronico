import { useEffect, useRef } from 'react';
import { apiFetch } from '@/lib/supabase/http';

/**
 * Autenticação no Bird ID em uma aba separada. Navegar a aba atual destruiria o que vive na
 * memória da página (gravação e transcrição do Anamnesator, por exemplo).
 *
 * A aba é aberta no clique, antes de qualquer `await`, para o bloqueador de pop-up não barrá-la.
 * Na volta, `app/page.tsx` avisa as demais abas pelo canal abaixo e a aba original fecha a nova.
 */
const CHANNEL = 'psywrite-birdid';
const WAIT_LIMIT_MS = 10 * 60 * 1000;

export type BirdIdResult = { status: 'connected' } | { status: 'error'; message: string };

/** Abre a aba em branco. Retorna `null` se o navegador bloqueou (use o redirecionamento). */
export function openBirdIdTab(): Window | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  const tab = window.open('', '_blank');
  if (!tab) return null;
  try {
    // O site do Bird ID não deve enxergar esta aplicação por window.opener.
    tab.opener = null;
    tab.document.title = 'Bird ID';
    tab.document.body.textContent = 'Abrindo o Bird ID…';
  } catch {
    // Aba sem acesso ao documento: segue só com a navegação.
  }
  return tab;
}

export async function fetchBirdIdAuthorizationUrl(): Promise<string> {
  const r = await apiFetch('/api/digital-signature/birdid/authorize');
  const data = (await r.json()) as { authorizationUrl?: string; error?: string };
  if (!r.ok || !data.authorizationUrl)
    throw new Error(data.error || 'Falha ao iniciar autenticação Bird ID');
  return data.authorizationUrl;
}

/** Leva a aba ao Bird ID e a fecha quando a autenticação terminar (ou ela for abandonada). */
export function sendTabToBirdId(tab: Window, authorizationUrl: string) {
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

/** Chamado pela aba que voltou do Bird ID, para avisar a aba original. */
export function announceBirdIdResult(result: BirdIdResult) {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(result);
  channel.close();
}

/** Escuta o resultado da autenticação feita em outra aba. */
export function useBirdIdResult(handler: (result: BirdIdResult) => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<BirdIdResult>) => latest.current(event.data);
    return () => channel.close();
  }, []);
}
