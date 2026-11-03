'use client';
import { GripHorizontal, X } from 'lucide-react';
import { useId, useRef, useState, type PointerEvent } from 'react';
import { date, type RecordEntry } from './types';

function entryStatus(entry: RecordEntry) {
  if (entry.status === 'SIGNED' || entry.signed_at)
    return 'Assinada digitalmente';
  return entry.finalized_at ? 'Finalizada sem assinatura' : 'Em atendimento';
}

export function ConsultationHistory({
  entries,
  onOpen,
}: {
  entries: RecordEntry[];
  onOpen: (id: string) => void;
}) {
  return (
    <section className="editor-card consultation-history">
      <h2>Consultas anteriores</h2>
      {entries.length ? (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                className="consultation-history-link"
                onClick={() => onOpen(entry.id)}
              >
                <strong>{date(entry.created_at)}</strong>
                <span>{entryStatus(entry)}</span>
                <span>
                  {entry.text.slice(0, 150) || 'Rascunho vazio'}
                  {entry.text.length > 150 ? '…' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nenhuma consulta anterior registrada.</p>
      )}
    </section>
  );
}

export function ConsultationPreview({
  entry,
  onClose,
  onOpenRecord,
  busy,
}: {
  entry: RecordEntry;
  onClose: () => void;
  onOpenRecord: () => void;
  busy: boolean;
}) {
  const title = useId();
  const windowRef = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || drag.current || !windowRef.current) return;
    const { left, top } = windowRef.current.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX - left,
      y: event.clientY - top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  return (
    <section
      ref={windowRef}
      className="consultation-preview"
      role="dialog"
      aria-labelledby={title}
      style={
        position && {
          left: `clamp(0px, ${position.left}px, 100vw - var(--preview-width))`,
          top: `clamp(0px, ${position.top}px, 100dvh - var(--preview-height))`,
        }
      }
    >
      <header className="consultation-preview-header">
        <button
          className="consultation-preview-grip"
          aria-label="Mover janela da consulta anterior"
          title="Arraste para mover ou use as setas do teclado"
          onPointerDown={startDrag}
          onPointerMove={(event) => {
            const active = drag.current;
            if (active?.pointerId === event.pointerId) {
              setPosition({
                left: event.clientX - active.x,
                top: event.clientY - active.y,
              });
            }
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            const { left, top } = windowRef.current!.getBoundingClientRect();
            switch (event.key) {
              case 'ArrowLeft':
                setPosition({ left: left - 24, top });
                break;
              case 'ArrowRight':
                setPosition({ left: left + 24, top });
                break;
              case 'ArrowUp':
                setPosition({ left, top: top - 24 });
                break;
              case 'ArrowDown':
                setPosition({ left, top: top + 24 });
                break;
              default:
                return;
            }
            event.preventDefault();
          }}
        >
          <GripHorizontal size={18} />
        </button>
        <h2 id={title}>Consulta de {date(entry.created_at)}</h2>
        <button
          autoFocus
          aria-label="Fechar consulta anterior"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="consultation-preview-body">
        <span className="muted">{entryStatus(entry)}</span>
        <p>{entry.text || 'Rascunho vazio'}</p>
        {entry.consultation_addenda?.map((addendum) => (
          <article key={addendum.id}>
            <strong>Adendo · {date(addendum.created_at)}</strong>
            <p>{addendum.text}</p>
          </article>
        ))}
      </div>
      <footer className="consultation-preview-footer">
        <button className="secondary" disabled={busy} onClick={onOpenRecord}>
          Abrir no editor
        </button>
      </footer>
    </section>
  );
}
