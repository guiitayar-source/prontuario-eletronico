// Lógica da importação de prontuários de outro sistema: arquivos e lotes, prévia, destino de
// cada paciente, confirmação, desfazer lote. A tela está em import-panel.tsx.
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import { useAccess } from '../auth';
import { isClinicalRole } from '@/lib/roles';
import {
  MAX_IMPORT_BYTES,
  type Preview,
  type ImportResult,
  type ImportBatch,
} from '@/lib/imports/types';
import { lots, readExports } from '@/lib/imports/files';

/** Chama a API de importação: sem ação, lista os lotes; com ação, envia com a trava de escrita. */
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

/** Estado e ações do painel de importação. `onBusy` avisa a tela enquanto algo está em curso. */
export function useImportPanel(onBusy?: (busy: boolean) => void) {
  const medical = isClinicalRole(useAccess().role);
  const [source, setSource] = useState('Prontuário anterior'),
    [files, setFiles] = useState<File[]>([]),
    [queue, setQueue] = useState<string[]>([]),
    [lot, setLot] = useState({ index: 0, total: 0 }),
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
  useEffect(() => onBusy?.(busy), [busy, onBusy]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (busy) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  async function generate(example?: string) {
    if (!files.length && !example) return;
    setBusy(true);
    setError('');
    setMessage('');
    setResult(null);
    try {
      const payloads = example
        ? [await (await fetch('/examples/import-' + example + '.json')).text()]
        : lots(await readExports(files));
      if (
        payloads.some(
          (p) => new TextEncoder().encode(p).length > MAX_IMPORT_BYTES,
        )
      )
        throw new Error('Escolha arquivos JSON de até 2 MB.');
      setQueue(payloads.slice(1));
      setLot({ index: 1, total: payloads.length });
      await previewLot(payloads[0]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function previewLot(file: string) {
    const d = await call<Preview>('preview', { source, file });
    setPreview(d);
    setConfirmed(false);
    setChoices(
      Object.fromEntries(
        d.plan.patients.map((p) => [
          p.source_id,
          p.errors.length
            ? 'skip'
            : p.linked_id || (p.candidates.length ? '' : 'new'),
        ]),
      ),
    );
  }
  async function cancel() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await call('cancel', { id: preview.id });
      setPreview(null);
      setConfirmed(false);
      if (queue.length)
        setMessage(
          'Importação interrompida. Os lotes restantes não foram enviados.',
        );
      setQueue([]);
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
      setConfirmed(false);
      await refresh();
      if (queue.length) {
        // Próximo lote: nova prévia, que também precisa ser conferida e confirmada.
        const [next, ...rest] = queue;
        setQueue(rest);
        setLot({ index: lot.index + 1, total: lot.total });
        await previewLot(next);
        setMessage(
          `Lote ${lot.index} de ${lot.total} importado. Confira o próximo.`,
        );
      } else {
        setFiles([]);
        setMessage('Importação concluída.');
      }
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
  // O que ainda impede a confirmação, dito por paciente para não ficar só no botão desativado.
  const nameOf = (p: { fields: { name: string } }) =>
    p.fields.name || 'Paciente sem nome';
  const undecided =
    preview?.plan.patients.filter((p) => !choices[p.source_id]) || [];
  const conflicted = chosen.filter((p) =>
    preview?.plan.records.some(
      (r) => r.conflict && r.patient_source === p.source_id,
    ),
  );
  // Mesmo nome ou CPF duas vezes no lote, ambos como cadastro novo: o banco recusa o segundo.
  const key = (v: string) =>
    v
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  const fresh =
    preview?.plan.patients.filter((p) => choices[p.source_id] === 'new') || [];
  const twins = fresh.filter((p) =>
    fresh.some(
      (q) =>
        q !== p &&
        (key(q.fields.name) === key(p.fields.name) ||
          (!!p.fields.cpf && q.fields.cpf === p.fields.cpf)),
    ),
  );
  const pending = [
    twins.length
      ? `Mesmo nome ou CPF mais de uma vez neste lote: ${[...new Set(twins.map(nameOf))].join(', ')}. Importe só um agora ("Não importar este paciente" no outro) e, depois, selecione o .zip do outro sozinho e vincule-o ao cadastro criado.`
      : '',
    undecided.length
      ? `Escolha o destino (vincular ao cadastro existente ou não importar): ${undecided.map(nameOf).join(', ')}.`
      : '',
    conflicted.length
      ? `Registros já importados com conteúdo diferente; marque "Não importar este paciente": ${conflicted.map(nameOf).join(', ')}.`
      : '',
    preview && !undecided.length && !chosen.length
      ? 'Nenhum paciente selecionado para importar.'
      : '',
  ].filter(Boolean);

  /** Troca os arquivos escolhidos; o aviso de erro anterior some. */
  function chooseFiles(list: FileList | null) {
    setFiles(Array.from(list || []));
    setError('');
  }

  /** Muda o destino de um paciente da prévia; a confirmação precisa ser refeita. */
  function chooseDestination(sourceId: string, target: string) {
    setChoices({
      ...choices,
      [sourceId]: target,
    });
    setConfirmed(false);
  }

  return {
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
  };
}
