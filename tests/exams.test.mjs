import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  searchExams,
  numericExamValue,
  validNumericExamValue,
  activeExamResults,
  examSeries,
  normalizeExamUnit,
  validateDefinition,
  validateResult,
} from '../lib/exams.ts';
import { proposalValues } from '../lib/exam-extraction.ts';
import {
  normalizeDocumentTranscription,
  normalizeExamExtraction,
  geminiOutputText,
  responseOutputText,
} from '../lib/openai-files.ts';
import { exportFHIR } from '../lib/fhir/export.ts';
import {
  adaptSchemaForGemini,
  optimizeImageForAi,
} from '../lib/supabase/ai-files.ts';
const definition = {
  id: 'ast',
  name: 'AST / TGO',
  aliases: ['aspartato aminotransferase', 'transaminases'],
  fields: [{ id: 'value', name: 'AST', type: 'number', unit: 'U/L' }],
};
const result = (id, overrides = {}) => ({
  id,
  definition_id: 'ast',
  collected_on: '2026-09-14',
  created_at: '2026-09-14T12:00:00Z',
  laboratory: 'Lab',
  method: 'M',
  specimen: 'Soro',
  values: { value: { value: '20,5', unit: 'U/L', reference: '10 a 40' } },
  notes: '',
  supersedes_id: null,
  correction_reason: '',
  author_id: 'doctor',
  attachment_id: null,
  source: 'manual',
  provenance: {},
  ...overrides,
});
test('AI proposals are bounded, catalog-matched and remain separate from results', () => {
  const proposal = normalizeExamExtraction(
    {
      warnings: ['Conferir cabeçalho'],
      exams: [
        {
          definitionId: 'ast',
          originalName: 'TGO',
          collectedOn: '2026-09-14',
          laboratory: ' Lab ',
          method: null,
          specimen: 'Soro',
          fields: [
            {
              fieldId: 'value',
              originalName: 'TGO',
              value: '20,5',
              unit: 'U/L',
              reference: '10 a 40',
              page: 1,
              originalText: 'TGO 20,5 U/L',
              confidence: 1.4,
              warnings: [],
            },
            {
              fieldId: 'invented',
              originalName: 'Outro',
              value: '1',
              unit: '',
              reference: '',
              page: 0,
              originalText: 'Outro 1',
              confidence: null,
              warnings: [],
            },
          ],
        },
      ],
    },
    {
      attachmentId: 'attachment',
      provider: 'OpenAI',
      model: 'test',
      extractedAt: '2026-09-15T00:00:00Z',
    },
    [definition],
  );
  assert.equal(proposal.exams[0].fields[0].confidence, 1);
  assert.equal(proposal.exams[0].fields[1].fieldId, null);
  assert.deepEqual(proposalValues(proposal.exams[0], definition), {
    value: { value: '20,5', unit: 'U/L', reference: '10 a 40' },
  });
  assert.equal(
    normalizeDocumentTranscription(
      { transcription: '  texto fiel  ', warnings: [] },
      {
        attachmentId: 'attachment',
        provider: 'OpenAI',
        model: 'test',
        extractedAt: '2026-09-15T00:00:00Z',
      },
    ).transcription,
    'texto fiel',
  );
  assert.equal(
    responseOutputText({
      output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
    }),
    '{"ok":true}',
  );
  assert.equal(
    geminiOutputText({
      candidates: [
        { content: { parts: [{ text: '{"ok":' }, { text: 'true}' }] } },
      ],
    }),
    '{"ok":true}',
  );
});
test('search is accent-insensitive and never merges AST with ALT', () => {
  const defs = [
    definition,
    {
      ...definition,
      id: 'alt',
      name: 'ALT / TGP',
      aliases: ['alanina aminotransferase', 'transaminases'],
    },
  ];
  assert.deepEqual(
    searchExams(defs, 'tGo').map((d) => d.id),
    ['ast'],
  );
  assert.equal(searchExams(defs, 'transaminases').length, 2);
  assert.equal(searchExams(defs, 'ASPARTÁTO')[0].id, 'ast');
  assert.deepEqual(searchExams(defs, ''), []);
});
test('numbers preserve comparators and reject ambiguous punctuation', () => {
  assert.equal(numericExamValue('20,5'), 20.5);
  assert.equal(numericExamValue('1.234,5'), null);
  assert.equal(numericExamValue('< 0,1'), null);
  assert.equal(numericExamValue(''), null);
  assert.equal(validNumericExamValue('< 0,1'), true);
});
test('corrections replace active values, groups series by unit and separates incompatible units', () => {
  const rows = [
    result('old'),
    result('new', { supersedes_id: 'old' }),
    result('different', { method: 'Another', laboratory: 'Another Lab' }),
    result('limit', {
      values: { value: { value: '< 1', unit: 'U/L', reference: '' } },
    }),
    result('incompatible_unit', {
      values: { value: { value: '0,35', unit: 'ukat/L', reference: '' } },
    }),
  ];
  assert.deepEqual(
    activeExamResults(rows).map((r) => r.id),
    ['new', 'different', 'limit', 'incompatible_unit'],
  );
  const series = examSeries(rows, 'value');
  assert.equal(series.length, 2);
  const ulSeries = series.find((s) => s.unit.toLowerCase() === 'u/l');
  assert.ok(ulSeries);
  assert.deepEqual(
    ulSeries.points.map((p) => p.id).sort((a, b) => a.localeCompare(b)),
    ['different', 'new'],
  );
  const ukatSeries = series.find((s) => s.unit.toLowerCase() === 'ukat/l');
  assert.ok(ukatSeries);
  assert.deepEqual(ukatSeries.points.map((p) => p.id), ['incompatible_unit']);
});
test('hemogram equivalent units (milhões/mm3, 10^6/mm3, /µL, /mm3) merge into the same chart series', () => {
  assert.equal(normalizeExamUnit('milhões/mm3').key, 'milhoes/ul');
  assert.equal(normalizeExamUnit('10^6/mm3').key, 'milhoes/ul');
  assert.equal(normalizeExamUnit('milhões/µL').key, 'milhoes/ul');
  assert.equal(normalizeExamUnit('/mm3').key, '/ul');
  assert.equal(normalizeExamUnit('/µL').key, '/ul');

  const hemaciasRows = [
    result('h1', {
      collected_on: '2025-04-29',
      values: { hemacias: { value: '5.23', unit: 'milhões/mm3', reference: '4,1 a 5,3' } },
    }),
    result('h2', {
      collected_on: '2026-07-08',
      values: { hemacias: { value: '4.10', unit: '10^6/mm3', reference: '4,1 a 5,3' } },
    }),
  ];
  const hSeries = examSeries(hemaciasRows, 'hemacias', 'milhões/µL');
  assert.equal(hSeries.length, 1);
  assert.equal(hSeries[0].points.length, 2);
  assert.deepEqual(
    hSeries[0].points.map((p) => p.id).sort((a, b) => a.localeCompare(b)),
    ['h1', 'h2'],
  );
  assert.equal(hSeries[0].unit, 'milhões/µL');

  const leucoRows = [
    result('l1', {
      collected_on: '2025-04-29',
      values: { leucocitos: { value: '6400', unit: '/mm3', reference: '4000 a 10000' } },
    }),
    result('l2', {
      collected_on: '2026-07-08',
      values: { leucocitos: { value: '7100', unit: '/µL', reference: '4000 a 10000' } },
    }),
  ];
  const lSeries = examSeries(leucoRows, 'leucocitos', '/µL');
  assert.equal(lSeries.length, 1);
  assert.equal(lSeries[0].points.length, 2);
  assert.deepEqual(
    lSeries[0].points.map((p) => p.id).sort((a, b) => a.localeCompare(b)),
    ['l1', 'l2'],
  );
});
test('validation rejects impossible dates, unknown fields and missing correction reason', () => {
  validateDefinition(definition);
  validateResult(result('valid'), definition);
  assert.throws(() =>
    validateResult(result('bad', { collected_on: '2026-02-30' }), definition),
  );
  assert.throws(() =>
    validateResult(result('bad', { values: {} }), definition),
  );
  assert.throws(() =>
    validateResult(
      result('bad', {
        values: { other: { value: '2', unit: '', reference: '' } },
      }),
      definition,
    ),
  );
  assert.throws(() =>
    validateResult(result('bad', { supersedes_id: 'old' }), definition),
  );
  assert.throws(() =>
    validateDefinition({
      ...definition,
      fields: [...definition.fields, ...definition.fields],
    }),
  );
  validateResult(
    result('reviewed', {
      attachment_id: 'attachment',
      source: 'ai_reviewed',
      provenance: {
        attachment_id: 'attachment',
        provider: 'OpenAI',
        model: 'test',
        extracted_at: '2026-09-15T00:00:00Z',
        reviewed_at: '2026-09-15T00:01:00Z',
      },
    }),
    definition,
  );
  assert.throws(() =>
    validateResult(
      result('reviewed', {
        attachment_id: 'attachment',
        source: 'ai_reviewed',
        provenance: {
          attachment_id: 'other',
          provider: 'OpenAI',
          model: 'test',
          extracted_at: '2026-09-15T00:00:00Z',
          reviewed_at: '2026-09-15T00:01:00Z',
        },
      }),
      definition,
    ),
  );
});
test('FHIR exports only active results with units and references, no invented LOINC codes', () => {
  const bundle = exportFHIR(
    {
      patient: { id: 'p', clinic_id: 'c', name: 'Synthetic' },
      consultations: [],
      conditions: [],
      medications: [],
      documents: [],
      attachments: [],
      imports: [],
      allergies: [],
      allergy_state: 'unknown',
      exam_definitions: [definition],
      exam_results: [
        result('old'),
        result('new', {
          supersedes_id: 'old',
          correction_reason: 'Transcription',
        }),
      ],
    },
    'https://test.invalid',
  );
  const observations = bundle.entry.filter(
    (e) => e.resource.resourceType === 'Observation',
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].resource.valueQuantity.value, 20.5);
  assert.equal(observations[0].resource.status, 'corrected');
  assert.equal(observations[0].resource.referenceRange[0].text, '10 a 40');
  const report = bundle.entry.find(
    (e) => e.resource.resourceType === 'DiagnosticReport',
  ).resource;
  assert.equal(report.result[0].reference, observations[0].fullUrl);
});

test('adaptSchemaForGemini converts union null types to nullable and preserves structure', () => {
  const schema = {
    type: 'object',
    properties: {
      fieldId: { type: ['string', 'null'] },
      page: { type: ['integer', 'null'] },
      confidence: { type: ['number', 'null'] },
      originalName: { type: 'string' },
    },
  };
  const adapted = adaptSchemaForGemini(schema);
  assert.deepEqual(adapted, {
    type: 'object',
    properties: {
      fieldId: { type: 'string', nullable: true },
      page: { type: 'integer', nullable: true },
      confidence: { type: 'number', nullable: true },
      originalName: { type: 'string' },
    },
  });
});

test('optimizeImageForAi leaves PDF untouched and optimizes images', async () => {
  const pdfBytes = new Uint8Array([37, 80, 68, 70, 45]);
  const pdfRes = await optimizeImageForAi(pdfBytes, 'application/pdf');
  assert.equal(pdfRes.bytes, pdfBytes);
  assert.equal(pdfRes.mime, 'application/pdf');
});
