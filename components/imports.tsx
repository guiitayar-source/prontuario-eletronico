'use client';
import { useEffect, useState } from 'react';
import {
  Activity,
  CalendarDays,
  Users,
  Stethoscope,
  Upload,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch } from '@/lib/supabase/http';
import { useAccess } from './auth';
import { fieldGroups } from '@/lib/patient-fields';
const fieldLabels = Object.fromEntries(
  fieldGroups.flatMap((g) => g.fields.map(([key, label]) => [key, label])),
);
import {
  MAX_IMPORT_BYTES,
  kindLabels,
  type Preview,
  type ImportResult,
  type ImportBatch,
  type ImportedEntry,
} from '@/lib/imports/types';
async function call<T>(action?: string, data?: unknown): Promise<T> {
  const r = await apiFetch(
    '/api/imports' + (action ? '?action=' + action : ''),
    action
      ? {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Import-Action': '1',
          },
          body: JSON.stringify(data),
        }
      : undefined,
  );
  const value = (await r.json()) as T & { error?: string };
  if (!r.ok)
    throw new Error(value.error || 'Não foi possível concluir a importação.');
  return value;
}
function displayDate(value: string | null) {
  if (!value) return 'Não informada';
  if (value.length === 10) return value.split('-').reverse().join('/');
  return new Date(value).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
}
function Entry({ record }: { record: ImportedEntry }) {
  return (
    <details className="import-entry">
      <summary>
        <span>{kindLabels[record.kind]}</span> <strong>{record.title}</strong> ·{' '}
        {displayDate(record.occurred_at)}
      </summary>
      <dl>
        <dt>Data na origem</dt>
        <dd>{displayDate(record.occurred_at)}</dd>
        <dt>Registro criado na origem</dt>
        <dd>{displayDate(record.source_created_at)}</dd>
        <dt>Situação na origem</dt>
        <dd>{record.source_status || 'Não informada'}</dd>
        <dt>ID na origem</dt>
        <dd>{record.source_id}</dd>
      </dl>
      <pre>{record.text || 'Sem texto clínico no arquivo.'}</pre>
    </details>
  );
}
export default function Imports({
  onPatients,
  onAgenda,
  onTeam,
  onOpenPatient,
}: {
  onPatients: () => void;
  onAgenda: () => void;
  onTeam: () => void;
  onOpenPatient: (id: string) => void;
}) {
  const medical = ['owner', 'doctor'].includes(useAccess().role);
  const [source, setSource] = useState('Prontuário anterior'),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [choices, setChoices] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [result, setResult] = useState<ImportResult | null>(null),
    [batches, setBatches] = useState<ImportBatch[]>([]);
  async function refresh() {
    const d = await call<{ batches: ImportBatch[] }>();
    setBatches(d.batches);
  }
  useEffect(() => {
    let active = true;
    if (medical)
      void call<{ batches: ImportBatch[] }>()
        .then((d) => {
          if (active) setBatches(d.batches);
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [medical]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (busy) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  async function generate(example?: string) {
    if (!file && !example) return;
    setBusy(true);
    setError('');
    setMessage('');
    setResult(null);
    try {
      const selectedFile = example
        ? new File(
            [
              await (
                await fetch('/examples/import-' + example + '.json')
              ).text(),
            ],
            'exemplo.json',
            { type: 'application/json' },
          )
        : file!;
      if (selectedFile.size > MAX_IMPORT_BYTES)
        throw new Error('Escolha um JSON de até 2 MB.');
      const d = await call<Preview>('preview', {
        source,
        file: await selectedFile.text(),
      });
      setPreview(d);
      setConfirmed(false);
      setChoices(
        Object.fromEntries(
          d.plan.patients.map((p) => [
            p.source_id,
            p.errors.length ? 'skip' : p.candidates.length ? '' : 'new',
          ]),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await call('cancel', { id: preview.id });
      setPreview(null);
      setConfirmed(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const d = await call<{ result: ImportResult }>('commit', {
        id: preview.id,
        confirmed,
        choices: preview.plan.patients.map((p) => ({
          source_id: p.source_id,
          target: choices[p.source_id],
        })),
      });
      setResult(d.result);
      setPreview(null);
      setFile(null);
      setConfirmed(false);
      setMessage('Importação concluída.');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revert(batch: ImportBatch) {
    if (
      !window.confirm(
        'Desfazer esta importação? Os registros deste lote sairão do histórico ativo. Cadastros de pacientes, alterações locais e auditoria serão preservados.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await call('revert', { id: batch.id });
      setMessage(
        'Importação desfeita. Cadastros de pacientes e auditoria preservados.',
      );
      setResult(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const chosen =
    preview?.plan.patients.filter(
      (p) => choices[p.source_id] && choices[p.source_id] !== 'skip',
    ) || [];
  const blocked = preview?.plan.records.some(
    (r) => r.conflict && chosen.some((p) => p.source_id === r.patient_source),
  );
  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand">
          <Activity size={23} />
        </div>
        <nav aria-label="Navegação principal">
          <button className="nav-item" disabled={busy} onClick={onAgenda}>
            <CalendarDays size={21} />
            <span>Agenda</span>
          </button>
          <button className="nav-item" disabled={busy} onClick={onPatients}>
            <Users size={21} />
            <span>Pacientes</span>
          </button>
          <button className="nav-item" disabled={busy} onClick={onPatients}>
            <Stethoscope size={21} />
            <span>Consulta</span>
          </button>
          <button className="nav-item" disabled={busy} onClick={onTeam}>
            <ShieldCheck size={21} />
            <span>Equipe</span>
          </button>
          <button className="nav-item active" aria-current="page">
            <Upload size={21} />
            <span>Importar</span>
          </button>
        </nav>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="wordmark">
            meu prontuário<span>CONSULTÓRIO</span>
          </div>
          <span className="demo-label">Protótipo · dados fictícios</span>
        </header>
        <main className="imports-page">
          <div className="registry-title">
            <div>
              <div className="eyebrow">CONTINUIDADE DO CUIDADO</div>
              <h1>Importar prontuários</h1>
              <p>
                Traga o cadastro e o histórico do sistema anterior, com revisão
                antes de gravar.
              </p>
            </div>
          </div>
          {!medical ? (
            <p>Acesso exclusivo da equipe médica.</p>
          ) : (
            <>
              {error && (
                <p role="alert" className="capture-error">
                  {error}
                </p>
              )}
              {message && <output className="capture-notice">{message}</output>}
              {result && (
                <section className="import-card">
                  <h2>Resultado</h2>
                  <p>
                    {result.created} cadastro(s) criado(s), {result.imported}{' '}
                    registro(s) importado(s), {result.skipped} repetido(s)
                    ignorado(s).
                  </p>
                  {result.patients.map((p) => (
                    <button
                      key={p.id}
                      className="secondary"
                      onClick={() => onOpenPatient(p.id)}
                    >
                      Abrir {p.name}
                    </button>
                  ))}
                </section>
              )}
              {!preview ? (
                <section className="import-card">
                  <h2>1. Escolher a exportação</h2>
                  <p>
                    JSON LGPD ou Bundle FHIR R4 · até 2 MB, 30 pacientes e 500
                    registros.
                  </p>
                  <label>
                    Sistema de origem
                    <input
                      value={source}
                      maxLength={80}
                      disabled={busy}
                      onChange={(e) => setSource(e.target.value)}
                    />
                  </label>
                  <p className="muted">
                    Use sempre o mesmo nome para exportações do mesmo sistema.
                    Isso permite reconhecer os registros já importados.
                  </p>
                  <label>
                    Arquivo JSON
                    <input
                      key={result?.id || 'upload'}
                      type="file"
                      accept=".json,application/json"
                      disabled={busy}
                      onChange={(e) => {
                        setFile(e.target.files?.[0] || null);
                        setError('');
                      }}
                    />
                  </label>
                  <div className="import-actions">
                    <button
                      className="primary"
                      disabled={busy || !file || source.trim().length < 2}
                      onClick={() => void generate()}
                    >
                      {busy ? 'Analisando…' : 'Gerar prévia'}
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void generate('lgpd')}
                    >
                      Testar exemplo fictício
                    </button>
                    <a href="/examples/import-lgpd.json" download>
                      Exemplo LGPD fictício
                    </a>
                    <a href="/examples/import-fhir-r4.json" download>
                      Exemplo FHIR fictício
                    </a>
                  </div>
                  <p className="muted">
                    Dados clínicos entram no Histórico importado. PDFs e imagens
                    precisam ser anexados separadamente. Nesta etapa, use dados
                    fictícios.
                  </p>
                </section>
              ) : (
                <section className="import-card">
                  <h2>2. Revisar e escolher os pacientes</h2>
                  <p>
                    {preview.plan.format === 'lgpd'
                      ? 'Portabilidade LGPD'
                      : 'FHIR R4'}{' '}
                    · {preview.plan.patients.length} paciente(s) ·{' '}
                    {preview.plan.records.length} registro(s). Prévia válida por
                    uma hora.
                  </p>
                  <details className="import-entry" open>
                    <summary>
                      Avisos da importação ({preview.plan.warnings.length})
                    </summary>
                    <ul>
                      {preview.plan.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </details>
                  {preview.plan.patients.map((p) => (
                    <article key={p.source_id} className="import-patient">
                      <h3>{p.fields.name || 'Paciente sem nome'}</h3>
                      <p>
                        Nascimento: {displayDate(p.fields.dob || null)} · CPF:{' '}
                        {p.fields.cpf || 'Não informado'} · Origem:{' '}
                        {p.source_id}
                      </p>
                      {p.warnings.map((w, i) => (
                        <p key={i} className="capture-notice">
                          {w}
                        </p>
                      ))}
                      {p.errors.map((w, i) => (
                        <p key={i} className="capture-error">
                          {w}
                        </p>
                      ))}
                      <details>
                        <summary>Conferir dados cadastrais</summary>
                        <dl>
                          {Object.entries(p.fields)
                            .filter(([, v]) => v)
                            .map(([k, v]) => (
                              <div key={k}>
                                <dt>{fieldLabels[k] || k}</dt>
                                <dd>{v}</dd>
                              </div>
                            ))}
                        </dl>
                      </details>
                      <label>
                        Destino do paciente
                        <select
                          disabled={busy}
                          value={choices[p.source_id] || ''}
                          onChange={(e) => {
                            setChoices({
                              ...choices,
                              [p.source_id]: e.target.value,
                            });
                            setConfirmed(false);
                          }}
                        >
                          <option value="">
                            Selecione após conferir a identificação
                          </option>
                          {!p.errors.length &&
                            !p.candidates.length &&
                            !p.linked_id && (
                              <option value="new">Criar novo cadastro</option>
                            )}
                          {!p.errors.length &&
                            p.candidates
                              .filter(
                                (c) => !p.linked_id || c.id === p.linked_id,
                              )
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  Vincular a {c.name} · {displayDate(c.dob)} ·
                                  CPF {c.cpf || 'não informado'}
                                </option>
                              ))}
                          <option value="skip">
                            Não importar este paciente
                          </option>
                        </select>
                      </label>
                      {p.linked_id && (
                        <p className="capture-notice">
                          Este paciente da origem já possui vínculo. Confira o
                          destino para continuar.
                        </p>
                      )}
                      {p.candidates.length > 0 && (
                        <p className="muted">
                          O cadastro existente será preservado. A importação
                          acrescenta apenas o histórico.
                        </p>
                      )}
                      <div>
                        {preview.plan.records
                          .filter((r) => r.patient_source === p.source_id)
                          .map((r) => (
                            <div key={r.kind + ':' + r.source_id}>
                              {r.duplicate && (
                                <p className="capture-notice">
                                  Já importado: será ignorado.
                                </p>
                              )}
                              {r.conflict && (
                                <p className="capture-error">
                                  ID já importado com conteúdo diferente. Revise
                                  a origem ou ignore este paciente.
                                </p>
                              )}
                              <Entry record={r} />
                            </div>
                          ))}
                      </div>
                    </article>
                  ))}
                  <label className="import-confirm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    Conferi os pacientes, os destinos e os avisos; confirmo a
                    importação do histórico selecionado.
                  </label>
                  <div className="import-actions">
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void cancel()}
                    >
                      Cancelar prévia
                    </button>
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        !confirmed ||
                        !chosen.length ||
                        !!blocked ||
                        preview.plan.patients.some((p) => !choices[p.source_id])
                      }
                      onClick={() => void commit()}
                    >
                      {busy ? 'Processando…' : 'Confirmar importação'}
                    </button>
                  </div>
                </section>
              )}
              <section className="import-card">
                <h2>Importações recentes</h2>
                <p>
                  Desfazer retira os registros do lote do histórico ativo e
                  mantém a auditoria e os cadastros de pacientes.
                </p>
                {!batches.length && (
                  <p className="muted">Nenhuma importação concluída.</p>
                )}
                {batches.map((b) => (
                  <article className="import-batch" key={b.id}>
                    <div>
                      <strong>{b.source}</strong>
                      <p>
                        {displayDate(b.committed_at)} · {b.result.imported}{' '}
                        registro(s) ·{' '}
                        {b.state === 'reverted' ? 'Desfeita' : 'Concluída'}
                      </p>
                    </div>
                    {b.state === 'committed' && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void revert(b)}
                      >
                        Desfazer lote
                      </button>
                    )}
                  </article>
                ))}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
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
