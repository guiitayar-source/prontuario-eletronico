'use client';
import { useId, useSyncExternalStore } from 'react';
import { ChevronDown } from 'lucide-react';

const STORAGE_PREFIX = 'psywrite_panel_';
const CHANGE_EVENT = 'psywrite-panel-change';
// Guarda o estado também em memória, para funcionar sem localStorage.
const memory = new Map<string, string>();

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function readState(key: string) {
  if (memory.has(key)) return memory.get(key);
  try {
    return localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null; // localStorage indisponível
  }
}

/** Cartão lateral com cabeçalho que recolhe o conteúdo; lembra o estado por `storageKey`. */
export function CollapsibleCard({
  storageKey,
  title,
  icon,
  action,
  children,
}: {
  storageKey: string;
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const stored = useSyncExternalStore(
    subscribe,
    () => readState(storageKey),
    () => null,
  );
  const open = stored !== 'closed';
  const bodyId = useId();

  function toggle() {
    const next = open ? 'closed' : 'open';
    memory.set(storageKey, next);
    try {
      localStorage.setItem(STORAGE_PREFIX + storageKey, next);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <section className={open ? 'side-card' : 'side-card collapsed'}>
      <div className="side-card-heading">
        <button
          type="button"
          className="side-card-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          {icon}
          <span>{title}</span>
          <ChevronDown size={16} className="side-card-chevron" aria-hidden />
        </button>
        {open && action}
      </div>
      <div id={bodyId} className="side-card-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
