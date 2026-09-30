'use client';
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type RefObject,
} from 'react';
import { Search } from 'lucide-react';
import { apiFetch as fetch } from '@/lib/supabase/http';
import { initials, age, type Patient } from '@/lib/patient-fields';

const INPUT_ID = 'topbar-patient-search';

/** Move o foco para a busca de pacientes do cabeçalho. */
export function focusPatientSearch() {
  document.getElementById(INPUT_ID)?.focus();
}

type SearchGuard = {
  /** Envolve a abertura do paciente (ex.: confirmar alterações não salvas). */
  beforeSelect?: (open: () => void) => void;
  /** Chamado antes de focar a busca via Ctrl K; retornar false cancela. */
  beforeSearch?: () => boolean;
};
const SearchGuardContext = createContext<RefObject<SearchGuard> | null>(null);

/** Permite à tela atual interceptar a busca do cabeçalho global. */
export function useSearchGuard(guard: SearchGuard) {
  const ref = useContext(SearchGuardContext);
  useEffect(() => {
    if (!ref) return;
    ref.current = guard;
    return () => {
      if (ref.current === guard) ref.current = {};
    };
  });
}

/** Cabeçalho único e fixo do app, com a busca de pacientes, sobre todas as telas. */
export function AppHeader({
  onSelectPatient,
  children,
}: {
  onSelectPatient: (p: Patient) => void;
  children: ReactNode;
}) {
  const guard = useRef<SearchGuard>({});
  return (
    <SearchGuardContext.Provider value={guard}>
      <TopBar
        onSelectPatient={(p) => {
          const open = () => onSelectPatient(p);
          if (guard.current.beforeSelect) guard.current.beforeSelect(open);
          else open();
        }}
        onBeforeSearch={() => guard.current.beforeSearch?.() ?? true}
      />
      {children}
    </SearchGuardContext.Provider>
  );
}

function TopBar({
  onSelectPatient,
  onBeforeSearch,
}: {
  onSelectPatient: (p: Patient) => void;
  onBeforeSearch: () => boolean;
}) {
  const [query, setQuery] = useState(''),
    [open, setOpen] = useState(false),
    [list, setList] = useState<Patient[]>([]),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null),
    boxRef = useRef<HTMLDivElement>(null),
    listId = useId();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!onBeforeSearch()) return;
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onBeforeSearch]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/patients?q=${encodeURIComponent(query.trim())}&page=0`,
          { cache: 'no-store', signal: controller.signal },
        );
        const d = (await r.json()) as {
          patients: Patient[];
          total: number;
          error?: string;
        };
        if (!r.ok) throw new Error(d.error || 'Erro ao carregar cadastros.');
        setList(d.patients.slice(0, 8));
        setTotal(d.total);
        setActive(0);
        setError('');
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, open]);

  const select = (p: Patient) => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    onSelectPatient(p);
  };

  return (
    <header className="topbar app-topbar">
      <div className="wordmark">
        meu prontuário<span>CONSULTÓRIO</span>
      </div>
      <div className="search" ref={boxRef}>
        <Search size={16} />
        <input
          id={INPUT_ID}
          ref={inputRef}
          role="combobox"
          aria-label="Buscar paciente"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && list[active] ? `${listId}-${active}` : undefined
          }
          autoComplete="off"
          placeholder="Buscar paciente"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
              inputRef.current?.blur();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, list.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && open && list[active]) {
              e.preventDefault();
              select(list[active]);
            }
          }}
        />
        <kbd>Ctrl K</kbd>
        {open && (
          <div className="search-dropdown" id={listId} role="listbox">
            {error ? (
              <p className="search-dropdown-status" role="alert">
                {error}
              </p>
            ) : busy && !list.length ? (
              <p className="search-dropdown-status" role="status">
                Carregando pacientes…
              </p>
            ) : !list.length ? (
              <p className="search-dropdown-status">
                Nenhum paciente encontrado
              </p>
            ) : (
              <>
                {list.map((p, i) => (
                  <button
                    type="button"
                    role="option"
                    id={`${listId}-${i}`}
                    aria-selected={i === active}
                    className={
                      i === active ? 'search-result active' : 'search-result'
                    }
                    key={p.id}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(p)}
                  >
                    <span className="avatar patient">
                      {initials(p.social_name || p.name)}
                    </span>
                    <span>
                      <strong>{p.social_name || p.name}</strong>
                      <small>
                        {p.social_name ? `${p.name} · ` : ''}
                        {age(p.dob)}
                        {p.phone ? ` · ${p.phone}` : ''}
                      </small>
                    </span>
                  </button>
                ))}
                {total > list.length && (
                  <p className="search-dropdown-status">
                    Mostrando {list.length} de {total}. Refine a busca.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <span className="demo-label">Protótipo · dados fictícios</span>
    </header>
  );
}

