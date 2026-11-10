'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Shield } from 'lucide-react';

const ACKNOWLEDGEMENT_KEY = 'psywrite-spellcheck-privacy-v1';

export function SpellcheckPrivacyNotice() {
  const [open, setOpen] = useState(true);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const contentId = useId();

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(ACKNOWLEDGEMENT_KEY) !== 'acknowledged');
    } catch {
      // Sem armazenamento local, mantém a orientação visível.
    }
  }, []);

  function acknowledge() {
    try {
      localStorage.setItem(ACKNOWLEDGEMENT_KEY, 'acknowledged');
    } catch {
      // Ainda é possível dispensar o aviso nesta tela.
    }
    setOpen(false);
    toggleRef.current?.focus();
  }

  return (
    <div className="spellcheck-privacy">
      <button
        ref={toggleRef}
        type="button"
        className="spellcheck-privacy-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
      >
        <Shield size={15} aria-hidden />
        <span>Privacidade do corretor ortográfico</span>
        <ChevronDown size={15} aria-hidden />
      </button>
      <div id={contentId} className="spellcheck-privacy-content" hidden={!open}>
        <p>
          Alguns corretores enviam o texto digitado a serviços externos. Para
          preservar o sigilo clínico, use a verificação básica/local do
          navegador.
        </p>
        <p>
          No Chrome, acesse{' '}
          <strong>Configurações → Idiomas → Verificação ortográfica</strong>:
          selecione a opção básica e desative a aprimorada, que envia o texto ao
          Google.
        </p>
        <p>
          O PsyWrite não consegue detectar essa configuração nem bloquear esse
          envio. Este aviso não altera as configurações do navegador.
        </p>
        <button type="button" className="secondary" onClick={acknowledge}>
          Entendi
        </button>
      </div>
    </div>
  );
}
