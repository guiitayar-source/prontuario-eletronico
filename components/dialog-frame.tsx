'use client';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), a[href], input, textarea, select';

/**
 * Moldura padrão de diálogo: fundo que fecha ao clicar fora, foco preso com Tab e botão
 * de fechar. O Esc fica com quem abre o diálogo (normalmente um atalho global da tela).
 */
export function DialogFrame({
  className = 'modal',
  labelledBy = 'dialog-title',
  closeLabel = 'Fechar',
  onClose,
  children,
}: {
  className?: string;
  labelledBy?: string;
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- clique no fundo fecha; pelo teclado, Esc
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- onKeyDown prende o foco dentro do diálogo */}
      <section
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          const nodes = e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE);
          const first = nodes[0],
            last = nodes[nodes.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }}
      >
        <button className="close" autoFocus aria-label={closeLabel} onClick={onClose}>
          <X size={20} />
        </button>
        {children}
      </section>
    </div>
  );
}
