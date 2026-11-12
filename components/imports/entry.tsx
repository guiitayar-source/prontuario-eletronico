'use client';
// Um registro importado (consulta, receita…) como item que abre para mostrar os detalhes, e a
// data no formato da tela. Usado na prévia da importação e no histórico importado.
import { kindLabels, type ImportedEntry } from '@/lib/imports/types';

export function displayDate(value: string | null) {
  if (!value) return 'Não informada';
  if (value.length === 10) return value.split('-').reverse().join('/');
  return new Date(value).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
}
export function Entry({ record }: { record: ImportedEntry }) {
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
