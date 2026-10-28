'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/supabase/http';
export default function SncrConnectionReturn() {
  const started = useRef(false),
    [message, setMessage] = useState('Concluindo conexão SNCR…');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const invalid =
      new URLSearchParams(window.location.search).get('result') === 'invalid';
    window.history.replaceState({}, '', window.location.pathname);
    if (invalid) {
      setMessage(
        'Retorno inválido ou expirado. Inicie nova conexão nos Ajustes.',
      );
      return;
    }
    void apiFetch('/api/sncr/auth/complete', {
      method: 'POST',
      headers: { 'X-SNCR-Action': '1' },
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok)
          throw Error(d.error || 'Não foi possível concluir a conexão.');
        setMessage(
          'Sessão SNCR recebida. Identidade ainda não comprovada; emissão real permanece bloqueada.',
        );
      })
      .catch((e) => setMessage((e as Error).message));
  }, []);
  return (
    <main style={{ maxWidth: 640, margin: '4rem auto', padding: '1rem' }}>
      <h1>Conexão SNCR</h1>
      <p role="status">{message}</p>
      <Link href="/">Voltar ao PsyWrite</Link>
    </main>
  );
}
