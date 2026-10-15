import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hidePatientNames,
  neutralFileName,
  PATIENT_MARKER,
  restorePatientName,
} from '../lib/ai/pseudonymize.ts';

test('troca nome civil e social pelo marcador, sem diferenciar maiúsculas', () => {
  const text =
    'Ana Maria Souza veio acompanhada. ANA MARIA SOUZA relata melhora; Aninha prefere ser chamada assim.';
  assert.equal(
    hidePatientNames(text, ['Ana Maria Souza', 'Aninha']),
    `${PATIENT_MARKER} veio acompanhada. ${PATIENT_MARKER} relata melhora; ${PATIENT_MARKER} prefere ser chamada assim.`,
  );
});

test('nome mais longo vence e caracteres especiais não quebram a busca', () => {
  assert.equal(
    hidePatientNames('Ana Maria Souza (Ana Maria) — J. Silva+', [
      'Ana Maria',
      'Ana Maria Souza',
      'J. Silva+',
    ]),
    `${PATIENT_MARKER} (${PATIENT_MARKER}) — ${PATIENT_MARKER}`,
  );
});

test('ignora nomes vazios ou curtos demais', () => {
  assert.equal(
    hidePatientNames('Texto da consulta', ['', null, undefined, 'Al']),
    'Texto da consulta',
  );
});

test('o rascunho volta com o nome que o médico vê', () => {
  assert.equal(
    restorePatientName(
      `Atesto que ${PATIENT_MARKER} esteve em consulta.`,
      'Ana',
    ),
    'Atesto que Ana esteve em consulta.',
  );
});

test('arquivo enviado à IA não leva o nome original', () => {
  assert.equal(neutralFileName('Hemograma Ana Maria Souza.PDF'), 'anexo.pdf');
  assert.equal(neutralFileName('foto'), 'anexo');
});
