import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import type { SignatureSessionData } from '@/lib/signature/types';

// setTimeout estoura acima de ~24,8 dias; sessões de assinatura duram horas.
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * Sessão do certificado em nuvem (Bird ID ou VIDaaS) vista pela tela. Quando a validação expira
 * com a página aberta, a sessão some sozinha no horário de `expiresAt` (ou na próxima vez que a
 * aba volta ao foco, se o navegador segurou o timer) e `expired` guarda o provedor que expirou,
 * para a tela oferecer "revalidar" em vez de seguir mostrando o certificado como conectado.
 */
export function useSignatureSession(enabled = true) {
  const [session, setSession] = useState<SignatureSessionData | null>(null),
    [expired, setExpired] = useState<string | null>(null);
  const known = useRef<SignatureSessionData | null>(null);

  function apply(next: SignatureSessionData | null) {
    const previous = known.current;
    known.current = next;
    setSession(next);
    if (next) setExpired(null);
    else if (previous) setExpired(previous.provider);
  }

  async function check() {
    try {
      const r = await apiFetch('/api/digital-signature/session');
      if (r.ok) {
        const data = (await r.json()) as {
          active: boolean;
          session: SignatureSessionData | null;
        };
        apply(data.active ? data.session : null);
      }
    } catch {
      // Falha na checagem em segundo plano: mantém o que a tela já sabe.
    }
  }

  /** O servidor recusou a assinatura por falta de sessão válida. */
  function markExpired() {
    const provider = known.current?.provider ?? expired;
    known.current = null;
    setSession(null);
    if (provider) setExpired(provider);
  }

  function clear() {
    known.current = null;
    setSession(null);
    setExpired(null);
  }

  useEffect(() => {
    if (enabled) void check();
    // check não é estável entre renderizações; só interessa ao habilitar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const expiresAt = session?.expiresAt;
  useEffect(() => {
    if (!enabled || !expiresAt) return;
    const lapse = () => {
      if (known.current && Date.parse(known.current.expiresAt) <= Date.now())
        markExpired();
    };
    const timer = setTimeout(
      lapse,
      Math.min(Math.max(Date.parse(expiresAt) - Date.now(), 0), MAX_DELAY_MS),
    );
    // Abas em segundo plano (ou o computador em suspensão) atrasam timers: confere na volta.
    const onVisible = () => {
      if (document.visibilityState === 'visible') lapse();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', lapse);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', lapse);
    };
    // markExpired só lê refs e setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, expiresAt]);

  return { session, expired, check, markExpired, clear };
}
