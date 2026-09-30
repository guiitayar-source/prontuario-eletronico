'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Plus, Search, Stethoscope, X } from 'lucide-react';
import { apiFetch } from '@/lib/supabase/http';
import { diagnosisBlock } from '@/lib/cid/evolution-block';
import type {
  ClinicalContextController,
  Condition,
  ConsultationDiagnosis,
} from './clinical-context';

export type CidEntry = { code: string; title: string };
type Icd11Suggestion = CidEntry & {
  kind: 'official' | 'compatible' | 'related';
};
export type Icd11Choice = CidEntry & { release: string };

const statusLabel: Record<Condition['status'], string> = {
  hypothesis: 'Hipótese',
  confirmed: 'Confirmado',
  resolved: 'Resolvido',
};
const kindLabel: Record<Icd11Suggestion['kind'], string> = {
  official: 'Correspondência oficial',
  compatible: 'Também corresponde',
  related: 'Mesmo grupo',
};

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

function Icd11Tag({ code, title }: { code: string; title?: string | null }) {
  return (
    <span className="icd11-tag" title={title || undefined}>
      <span className="icd11-badge">CID-11</span> {code}
    </span>
  );
}

type Draft = {
  description: string;
  cid_code: string;
  status: Condition['status'];
  icd11: Icd11Choice | null;
};

/** Diagnósticos considerados no atendimento, exibidos logo abaixo da evolução. */
export function ConsultationDiagnoses({
  context,
  consultationId,
  locked,
  onEvolutionBlock,
}: {
  context: ClinicalContextController;
  consultationId?: string;
  locked: boolean;
  /** Recebe o bloco de diagnósticos a escrever no fim da evolução. */
  onEvolutionBlock?: (block: string) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null),
    [expanded, setExpanded] = useState<string | null>(null);
  const links = context.consultationDiagnoses.filter(
    (x) => x.consultation_id === consultationId,
  );
  // Após uma alteração feita aqui, reescreve o bloco quando a lista recarregar.
  const pendingBlock = useRef(false);
  const blockRef = useRef(onEvolutionBlock);
  blockRef.current = onEvolutionBlock;
  useEffect(() => {
    if (!pendingBlock.current || locked) return;
    pendingBlock.current = false;
    blockRef.current?.(
      diagnosisBlock(
        context.consultationDiagnoses.filter(
          (x) => x.consultation_id === consultationId,
        ),
      ),
    );
  }, [context.consultationDiagnoses, consultationId, locked]);
  async function track(action: Promise<boolean>) {
    if (await action) pendingBlock.current = true;
  }
  const linkedIds = new Set(links.map((x) => x.condition_id));
  const byId = new Map(context.conditions.map((x) => [x.id, x]));
  const previous = context.conditions.filter(
    (x) => x.status !== 'resolved' && !linkedIds.has(x.id),
  );
  const disabled = !consultationId || context.busy;

  function conditionRecord(c: Condition, patch: Partial<Condition>) {
    return {
      ...c,
      ...patch,
      entity: 'condition',
      patient_id: context.patientId,
      consultation_id: consultationId,
    };
  }
  async function add() {
    if (!draft || !consultationId) return;
    const record = {
      ...context.emptyCondition(),
      description: draft.description.trim(),
      cid_code: draft.cid_code,
      status: draft.status,
      icd11_code: draft.icd11?.code || '',
      icd11_title: draft.icd11?.title || '',
      icd11_release: draft.icd11?.release || '',
      consultation_id: consultationId,
    };
    if (await context.save(record)) {
      pendingBlock.current = true;
      setDraft(null);
    }
  }

  return (
    <section className="consultation-diagnoses" aria-labelledby="diagnoses-title">
      <div className="diagnoses-header">
        <h3 id="diagnoses-title">
          <Stethoscope size={16} aria-hidden /> Diagnósticos do atendimento
        </h3>
        {!locked && (
          <small>
            Escritos no fim da evolução e assinados junto com ela
          </small>
        )}
      </div>

      {links.length ? (
        <ul className="diagnoses-list">
          {links.map((link: ConsultationDiagnosis) => {
            const condition = byId.get(link.condition_id);
            const item = locked || !condition ? link : condition;
            return (
              <li key={link.id}>
                <div className="diagnosis-row">
                  <div className="diagnosis-main">
                    <strong>
                      {item.cid_code && <code>{item.cid_code}</code>}
                      {item.description}
                    </strong>
                    {item.icd11_code && (
                      <Icd11Tag code={item.icd11_code} title={item.icd11_title} />
                    )}
                  </div>
                  {locked || !condition ? (
                    <span className="context-item-badge">
                      {statusLabel[link.status]}
                    </span>
                  ) : (
                    <div className="diagnosis-actions">
                      <select
                        aria-label="Situação do diagnóstico"
                        value={condition.status}
                        disabled={disabled}
                        onChange={(e) =>
                          void track(
                            context.save(
                              conditionRecord(condition, {
                                status: e.target.value as Condition['status'],
                              }),
                            ),
                          )
                        }
                      >
                        <option value="hypothesis">Hipótese</option>
                        <option value="confirmed">Confirmado</option>
                        <option value="resolved">Resolvido</option>
                      </select>
                      {condition.cid_code && (
                        <button
                          type="button"
                          className="text-button"
                          aria-expanded={expanded === condition.id}
                          onClick={() =>
                            setExpanded(
                              expanded === condition.id ? null : condition.id,
                            )
                          }
                        >
                          {condition.icd11_code ? 'Alterar CID-11' : 'Ver CID-11'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remover ${condition.description} deste atendimento`}
                        title="Remover deste atendimento (continua no histórico do paciente)"
                        disabled={disabled}
                        onClick={() =>
                          void track(
                            context.link(consultationId!, condition.id, false),
                          )
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                </div>
                {!locked && condition?.cid_code && expanded === condition.id && (
                  <Icd11Suggestions
                    cid10={condition.cid_code}
                    selected={condition.icd11_code}
                    disabled={disabled}
                    onSelect={(choice) =>
                      void track(
                        context.save(
                          conditionRecord(condition, {
                            icd11_code: choice?.code || '',
                            icd11_title: choice?.title || '',
                            icd11_release: choice?.release || '',
                          }),
                        ),
                      )
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">
          {locked
            ? 'Nenhum diagnóstico registrado neste atendimento.'
            : 'Nenhum diagnóstico registrado neste atendimento ainda.'}
        </p>
      )}

      {!locked && previous.length > 0 && (
        <div className="diagnoses-previous">
          <small>Diagnósticos do paciente:</small>
          {previous.map((c) => (
            <button
              type="button"
              key={c.id}
              className="diagnosis-chip"
              disabled={disabled}
              title="Incluir neste atendimento"
              onClick={() =>
                void track(context.link(consultationId!, c.id, true))
              }
            >
              <Plus size={13} aria-hidden />
              {c.cid_code && <code>{c.cid_code}</code>}
              {c.description}
            </button>
          ))}
        </div>
      )}

      {!locked &&
        (draft ? (
          <div className="diagnosis-draft">
            <div className="diagnosis-draft-row">
              <label>
                <span>Descrição</span>
                <input
                  maxLength={500}
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                />
              </label>
              <label>
                <span>Situação</span>
                <select
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      status: e.target.value as Condition['status'],
                    })
                  }
                >
                  <option value="hypothesis">Hipótese</option>
                  <option value="confirmed">Confirmado</option>
                </select>
              </label>
            </div>
            {draft.cid_code ? (
              <Icd11Suggestions
                cid10={draft.cid_code}
                selected={draft.icd11?.code}
                onSelect={(icd11) => setDraft({ ...draft, icd11 })}
              />
            ) : null}
            <div className="diagnosis-draft-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setDraft(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary"
                disabled={disabled || !draft.description.trim()}
                onClick={() => void add()}
              >
                Adicionar ao atendimento
                {draft.cid_code && ` · ${draft.cid_code}`}
                {draft.icd11 && ` + ${draft.icd11.code}`}
              </button>
            </div>
          </div>
        ) : (
          <CidAutocomplete
            disabled={disabled}
            placeholder="Adicionar diagnóstico: digite nome ou código CID-10 (ex.: ansiedade, F41)"
            onPick={(x) =>
              setDraft({
                description: x.title,
                cid_code: x.code,
                status: 'hypothesis',
                icd11: null,
              })
            }
            onFreeText={(text) =>
              setDraft({
                description: text,
                cid_code: '',
                status: 'hypothesis',
                icd11: null,
              })
            }
          />
        ))}
      {context.error && (
        <p className="capture-error" role="alert">
          {context.error}
        </p>
      )}
    </section>
  );
}
