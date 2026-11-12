'use client';
// Correspondências da CID-11 para um código CID-10 (tabelas da OMS), com busca de outro código,
// e a etiqueta "CID-11" mostrada ao lado de um diagnóstico.
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import { CidAutocomplete } from './cid-autocomplete';
import type { Icd11Choice, Icd11Suggestion } from './types';

const kindLabel: Record<Icd11Suggestion['kind'], string> = {
  official: 'Correspondência oficial',
  compatible: 'Também corresponde',
  related: 'Mesmo grupo',
};

/** Sugestões CID-11 compatíveis com um CID-10, com opção de escolher e salvar. */
export function Icd11Suggestions({
  cid10,
  selected,
  disabled,
  onSelect,
}: {
  cid10: string;
  selected?: string | null;
  disabled?: boolean;
  onSelect: (choice: Icd11Choice | null) => void;
}) {
  const [items, setItems] = useState<Icd11Suggestion[]>([]),
    [release, setRelease] = useState(''),
    [loading, setLoading] = useState(true),
    [searching, setSearching] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    apiFetch(`/api/cid?suggest=${encodeURIComponent(cid10)}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((d: { suggestions?: Icd11Suggestion[]; release?: string }) => {
        setItems(d.suggestions || []);
        setRelease(d.release || '');
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cid10]);

  const groups = (['official', 'compatible', 'related'] as const)
    .map((kind) => [kind, items.filter((x) => x.kind === kind)] as const)
    .filter(([, list]) => list.length);

  return (
    <div className="icd11-suggestions">
      <div className="icd11-heading">
        <span className="icd11-badge">CID-11</span>
        <span>
          Correspondências para <strong>{cid10}</strong>
          {release && <small> · OMS {release}</small>}
        </span>
      </div>
      {loading ? (
        <p className="muted">Buscando correspondências…</p>
      ) : !groups.length ? (
        <p className="muted">A OMS não publica correspondência para este código.</p>
      ) : (
        groups.map(([kind, list]) => (
          <div className="icd11-group" key={kind}>
            <small>{kindLabel[kind]}</small>
            {list.map((x) => (
              <button
                type="button"
                key={x.code}
                disabled={disabled}
                aria-pressed={selected === x.code}
                className={
                  selected === x.code ? 'icd11-chip selected' : 'icd11-chip'
                }
                onClick={() =>
                  onSelect(
                    selected === x.code ? null : { ...x, release },
                  )
                }
              >
                <code>{x.code}</code> {x.title}
              </button>
            ))}
          </div>
        ))
      )}
      {searching ? (
        <CidAutocomplete
          system="icd11"
          autoFocus
          disabled={disabled}
          placeholder="Buscar outro código na CID-11"
          onPick={(x, r) => {
            setSearching(false);
            onSelect({ ...x, release: r });
          }}
        />
      ) : (
        <button
          type="button"
          className="text-button"
          disabled={disabled}
          onClick={() => setSearching(true)}
        >
          Buscar outro código na CID-11
        </button>
      )}
    </div>
  );
}

export function Icd11Tag({ code, title }: { code: string; title?: string | null }) {
  return (
    <span className="icd11-tag" title={title || undefined}>
      <span className="icd11-badge">CID-11</span> {code}
    </span>
  );
}
