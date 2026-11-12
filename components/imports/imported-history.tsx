'use client';
// Histórico importado de um paciente, numa aba do prontuário: registros trazidos do sistema
// anterior, 30 por página.
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import type { ImportedEntry } from '@/lib/imports/types';
import { Entry, displayDate } from './entry';

export function ImportedHistory({ patientId }: { patientId: string }) {
  const [records, setRecords] = useState<
      (ImportedEntry & { id: string; source: string; imported_at: string })[]
    >([]),
    [error, setError] = useState(''),
    [page, setPage] = useState(0),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void apiFetch(
      `/api/imports?patientId=${encodeURIComponent(patientId)}&page=${page}`,
    )
      .then(async (r) => {
        const d = (await r.json()) as {
          records: typeof records;
          total: number;
          error?: string;
        };
        if (!r.ok) throw new Error(d.error);
        if (active) {
          setRecords(d.records);
          setTotal(d.total);
          setError('');
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [patientId, page]);
  return (
    <section className="import-card">
      <h2>Histórico importado</h2>
      <p>
        Registros do sistema anterior. A situação e a data são as informadas na
        origem; assinaturas não foram validadas.
      </p>
      {error && (
        <p role="alert" className="capture-error">
          {error}
        </p>
      )}
      {loading ? (
        <p>Carregando histórico…</p>
      ) : (
        !records.length && <p>Nenhum registro importado para este paciente.</p>
      )}
      {records.map((r) => (
        <article key={r.id}>
          <p className="muted">
            {r.source} · Importado em {displayDate(r.imported_at)}
          </p>
          <Entry record={r} />
        </article>
      ))}
      {total > 30 && (
        <div className="import-actions">
          <button
            className="secondary"
            disabled={!page || loading}
            onClick={() => {
              setLoading(true);
              setPage(page - 1);
            }}
          >
            Anterior
          </button>
          <span>
            Página {page + 1} de {Math.ceil(total / 30)}
          </span>
          <button
            className="secondary"
            disabled={(page + 1) * 30 >= total || loading}
            onClick={() => {
              setLoading(true);
              setPage(page + 1);
            }}
          >
            Próxima
          </button>
        </div>
      )}
    </section>
  );
}
