'use client';
import { apiFetch as fetch } from '@/lib/supabase/http';
import { useEffect, useState } from 'react';
import { Search, UserRound, ChevronRight } from 'lucide-react';
import { initials, age, type Patient } from '@/lib/patient-fields';

export function PatientSearch({
  onOpen,
  compact = false,
  revision = 0,
}: {
  onOpen: (p: Patient) => void;
  compact?: boolean;
  revision?: number;
}) {
  const [query, setQuery] = useState(''),
    [list, setList] = useState<Patient[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/patients?q=${encodeURIComponent(query)}&page=${page}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const d = (await r.json()) as {
          patients: Patient[];
          total: number;
          error?: string;
        };
        if (!r.ok) throw new Error(d.error || 'Erro ao carregar cadastros.');
        setList(d.patients);
        setTotal(d.total);
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
  }, [query, page, revision, retry]);
  return (
    <div className={compact ? 'patient-search compact' : 'patient-search'}>
      <label className="registry-search">
        <Search size={18} />
        <input
          autoFocus={compact}
          aria-label="Buscar pacientes"
          placeholder="Buscar por nome, CPF, telefone ou e-mail"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
      </label>
      {error ? (
        <div className="capture-error" role="alert">
          {error}
          <button onClick={() => setRetry((x) => x + 1)}>
            Tentar novamente
          </button>
        </div>
      ) : busy ? (
        <p className="registry-empty" role="status">
          Carregando pacientes…
        </p>
      ) : (
        <>
          <div className="directory-count">
            {total}{' '}
            {total === 1 ? 'paciente encontrado' : 'pacientes encontrados'}
          </div>
          {list.map((p) => (
            <button
              className="directory-row"
              key={p.id}
              onClick={() => onOpen(p)}
            >
              <span className="avatar patient">
                {initials(p.social_name || p.name)}
              </span>
              <span className="directory-person">
                <strong>{p.social_name || p.name}</strong>
                <small>
                  {p.social_name ? `${p.name} · ` : ''}
                  {age(p.dob)}
                </small>
              </span>
              <span className="directory-contact">
                {p.phone || 'Telefone não informado'}
                <small>{p.email}</small>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
          {!list.length && (
            <div className="registry-empty">
              <UserRound size={30} />
              <h3>Nenhum paciente encontrado</h3>
              <p>Confira a busca ou adicione um novo cadastro.</p>
            </div>
          )}
          {total > 50 && (
            <div className="directory-pagination">
              <button
                className="secondary"
                disabled={!page}
                onClick={() => setPage(page - 1)}
              >
                Anterior
              </button>
              <span>
                Página {page + 1} de {Math.ceil(total / 50)}
              </span>
              <button
                className="secondary"
                disabled={(page + 1) * 50 >= total}
                onClick={() => setPage(page + 1)}
              >
                Próxima
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
