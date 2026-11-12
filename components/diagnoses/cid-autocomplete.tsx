'use client';
// Campo de busca no catálogo CID-10 ou CID-11, com lista de sugestões e teclado (setas, Enter,
// Escape). Usado nos diagnósticos do atendimento e no contexto clínico.
import { useEffect, useId, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { apiFetch } from '@/lib/supabase/http';
import type { CidEntry } from './types';

/** Campo com autocomplete sobre o catálogo CID-10 ou CID-11. */
export function CidAutocomplete({
  system = 'cid10',
  placeholder,
  disabled,
  autoFocus,
  onPick,
  onFreeText,
}: {
  system?: 'cid10' | 'icd11';
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onPick: (entry: CidEntry, release: string) => void;
  /** Permite adicionar texto livre, sem código. */
  onFreeText?: (text: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<CidEntry[]>([]),
    [release, setRelease] = useState(''),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    [error, setError] = useState('');
  const boxRef = useRef<HTMLDivElement>(null),
    listId = useId();

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await apiFetch(
          `/api/cid?system=${system}&q=${encodeURIComponent(q)}`,
          { signal: controller.signal },
        );
        const d = (await r.json()) as {
          results: CidEntry[];
          release: string;
          error?: string;
        };
        if (!r.ok) throw new Error(d.error || 'Erro ao buscar no catálogo.');
        setResults(d.results);
        setRelease(d.release);
        setActive(0);
        setError('');
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    }, 150);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, system]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const free = onFreeText && query.trim() ? query.trim() : '';
  const count = results.length + (free ? 1 : 0);
  const choose = (i: number) => {
    const entry = results[i];
    if (entry) onPick(entry, release);
    else if (free) onFreeText?.(free);
    else return;
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="cid-autocomplete" ref={boxRef}>
      <label className="cid-input">
        <Search size={16} aria-hidden />
        <input
          role="combobox"
          aria-label={
            system === 'icd11' ? 'Buscar na CID-11' : 'Buscar diagnóstico CID-10'
          }
          aria-expanded={open && count > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && count ? `${listId}-${active}` : undefined
          }
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, count - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (open && count) choose(active);
            } else if (e.key === 'Escape' && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </label>
      {open && query.trim() && (
        <div className="cid-dropdown" id={listId} role="listbox">
          {error && <p className="cid-dropdown-status">{error}</p>}
          {results.map((x, i) => (
            <button
              type="button"
              role="option"
              id={`${listId}-${i}`}
              aria-selected={i === active}
              className={i === active ? 'cid-option active' : 'cid-option'}
              key={x.code}
              tabIndex={-1}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              <code>{x.code}</code>
              <span>{x.title}</span>
            </button>
          ))}
          {free && (
            <button
              type="button"
              role="option"
              id={`${listId}-${results.length}`}
              aria-selected={active === results.length}
              className={
                active === results.length ? 'cid-option active' : 'cid-option'
              }
              tabIndex={-1}
              onMouseEnter={() => setActive(results.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(results.length)}
            >
              <Plus size={14} aria-hidden />
              <span>Adicionar “{free}” sem código</span>
            </button>
          )}
          {!results.length && !free && !error && (
            <p className="cid-dropdown-status">Nenhum código encontrado.</p>
          )}
        </div>
      )}
    </div>
  );
}
