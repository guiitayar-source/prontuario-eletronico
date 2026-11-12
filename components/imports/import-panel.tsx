'use client';
// Importar prontuários de outro sistema (Pacientes → Importar e exportar): escolher os
// arquivos, revisar a prévia de cada lote e confirmar; desfazer lotes já importados.
// A lógica está em use-import-panel.ts.
import { fieldGroups } from '@/lib/patient-fields';
import { Entry, displayDate } from './entry';
import { useImportPanel } from './use-import-panel';

// Rótulo de cada campo do cadastro, para mostrar os dados que vieram da origem.
const fieldLabels = Object.fromEntries(
  fieldGroups.flatMap((g) => g.fields.map(([key, label]) => [key, label])),
);

export function ImportPanel({
  onOpenPatient,
  onBusy,
}: {
  onOpenPatient: (id: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const {
    medical,
    source,
    setSource,
    files,
    chooseFiles,
    lot,
    preview,
    choices,
    chooseDestination,
    confirmed,
    setConfirmed,
    busy,
    error,
    message,
    result,
    batches,
    chosen,
    blocked,
    twins,
    pending,
    generate,
    cancel,
    commit,
    revert,
  } = useImportPanel(onBusy);
  if (!medical) return <p>Acesso exclusivo da equipe médica.</p>;
  return (
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
            registro(s) importado(s), {result.skipped} repetido(s) ignorado(s).
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
            JSON LGPD ou Bundle FHIR R4, ou os .zip de portabilidade (com o JSON
            dentro). Selecione vários arquivos de uma vez: eles são divididos em
            lotes de até 30 pacientes, cada um com sua prévia.
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
            Use sempre o mesmo nome para exportações do mesmo sistema. Isso
            permite reconhecer os registros já importados.
          </p>
          <label>
            Arquivos (.json ou .zip)
            <input
              key={result?.id || 'upload'}
              type="file"
              multiple
              accept=".json,.zip,application/json,application/zip"
              disabled={busy}
              onChange={(e) => chooseFiles(e.target.files)}
            />
          </label>
          <div className="import-actions">
            <button
              className="primary"
              disabled={busy || !files.length || source.trim().length < 2}
              onClick={() => void generate()}
            >
              {busy
                ? 'Analisando…'
                : files.length > 1
                  ? `Gerar prévia (${files.length} arquivos)`
                  : 'Gerar prévia'}
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
            precisam ser anexados separadamente.
          </p>
        </section>
      ) : (
        <section className="import-card">
          <h2>2. Revisar e escolher os pacientes</h2>
          <p>
            {preview.plan.format === 'lgpd' ? 'Portabilidade LGPD' : 'FHIR R4'}{' '}
            · {preview.plan.patients.length} paciente(s) ·{' '}
            {preview.plan.records.length} registro(s). Prévia válida por uma
            hora.
            {lot.total > 1 && ` Lote ${lot.index} de ${lot.total}.`}
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
                {p.fields.cpf || 'Não informado'} · Origem: {p.source_id}
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
                  onChange={(e) => chooseDestination(p.source_id, e.target.value)}
                >
                  <option value="">
                    Selecione após conferir a identificação
                  </option>
                  {!p.errors.length && !p.candidates.length && !p.linked_id && (
                    <option value="new">Criar novo cadastro</option>
                  )}
                  {!p.errors.length &&
                    p.candidates
                      .filter((c) => !p.linked_id || c.id === p.linked_id)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          Vincular a {c.name} · {displayDate(c.dob)} · CPF{' '}
                          {c.cpf || 'não informado'}
                        </option>
                      ))}
                  <option value="skip">Não importar este paciente</option>
                </select>
              </label>
              {p.linked_id && (
                <p className="capture-notice">
                  Este paciente da origem já possui vínculo. Confira o destino
                  para continuar.
                </p>
              )}
              {p.candidates.length > 0 && (
                <p className="muted">
                  O cadastro existente será preservado. A importação acrescenta
                  apenas o histórico.
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
                          ID já importado com conteúdo diferente. Revise a
                          origem ou ignore este paciente.
                        </p>
                      )}
                      <Entry record={r} />
                    </div>
                  ))}
              </div>
            </article>
          ))}
          {pending.map((m) => (
            <p key={m} className="capture-error">
              {m}
            </p>
          ))}
          <label className="import-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Conferi os pacientes, os destinos e os avisos; confirmo a importação
            do histórico selecionado.
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
                twins.length > 0 ||
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
          Desfazer retira os registros do lote do histórico ativo e mantém a
          auditoria e os cadastros de pacientes.
        </p>
        {!batches.length && (
          <p className="muted">Nenhuma importação concluída.</p>
        )}
        {batches.map((b) => (
          <article className="import-batch" key={b.id}>
            <div>
              <strong>{b.source}</strong>
              <p>
                {displayDate(b.committed_at)} · {b.result.imported} registro(s)
                · {b.state === 'reverted' ? 'Desfeita' : 'Concluída'}
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
  );
}
