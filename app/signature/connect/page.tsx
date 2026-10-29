'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/supabase/http';
import { announceSignatureResult } from '@/lib/signature/signature-tab';
export default function SignatureConnectionReturn() {
  const started = useRef(false),
    [message, setMessage] = useState('Concluindo conexão do certificado…');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const attempt = new URLSearchParams(window.location.search).get('attempt');
    window.history.replaceState({}, '', window.location.pathname);
    const fail = (message: string) => {
      setMessage(message);
      announceSignatureResult({
        status: 'error',
        message,
        attempt: attempt || undefined,
      });
    };
    if (!attempt) {
      fail('Retorno inválido. Inicie nova conexão nos Ajustes.');
      return;
    }
    void apiFetch('/api/digital-signature/birdid/complete', {
      method: 'POST',
      headers: {
        'X-Signature-Action': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ attempt }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok)
          throw Error(data.error || 'Não foi possível concluir a conexão.');
        announceSignatureResult({ status: 'connected', attempt });
        // Mantém o retorno na mesma aba e a recuperação existentes da tela principal.
        window.location.replace('/?signature_status=connected');
      })
      .catch((e) => fail((e as Error).message));
  }, []);
  return (
    <main style={{ maxWidth: 640, margin: '4rem auto', padding: '1rem' }}>
      <h1>Conexão do certificado</h1>
      <p role="status">{message}</p>
      <Link href="/">Voltar ao PsyWrite</Link>
    </main>
  );
}
