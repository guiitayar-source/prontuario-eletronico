'use client';
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { PatientSearch } from './patients/search';
import type { Patient } from '@/lib/patient-fields';

export function PatientSearchModal({
  isOpen,
  onClose,
  onSelect,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (p: Patient) => void;
}) {
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const oldOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    return () => {
      window.document.body.style.overflow = oldOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            const nodes = e.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input, textarea, select',
            );
            if (!nodes.length) return;
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <button
          className="close"
          autoFocus
          aria-label="Fechar"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <h2 id="dialog-title">Buscar paciente</h2>
        <PatientSearch
          compact
          onOpen={(p) => {
            onClose();
            onSelect(p);
          }}
        />
      </section>
    </div>
  );
}
