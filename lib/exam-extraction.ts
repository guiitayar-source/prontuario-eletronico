import type { ExamDefinition, ExamValue } from './exams';

/** Boundary for a local/external extractor. Proposals are NOT results.
 * Missing/ambiguous values stay absent. Only a reviewed proposal can be
 * submitted to the results API. Provider credentials stay server-side.
 */
export type ExamExtractionProposal = {
  schemaVersion: 1;
  attachmentId: string;
  provider: string;
  model: string;
  extractedAt: string;
  warnings: string[];
  exams: {
    definitionId: string | null;
    originalName: string;
    collectedOn: string | null;
    laboratory: string | null;
    method: string | null;
    specimen: string | null;
    fields: {
      fieldId: string | null;
      originalName: string;
      suggested: Partial<ExamValue>;
      page: number | null;
      originalText: string;
      confidence: number | null;
      warnings: string[];
    }[];
  }[];
};

export type DocumentTranscriptionProposal = {
  attachmentId: string;
  provider: string;
  model: string;
  extractedAt: string;
  transcription: string;
  warnings: string[];
};

export function proposalValues(
  exam: ExamExtractionProposal['exams'][number],
  definition: ExamDefinition,
) {
  const values: Record<string, ExamValue> = {};
  for (const field of exam.fields) {
    if (
      !field.fieldId ||
      !definition.fields.some((f) => f.id === field.fieldId)
    )
      continue;
    const value = field.suggested.value?.trim();
    if (!value) continue;
    values[field.fieldId] = {
      value,
      unit: field.suggested.unit?.trim() || '',
      reference: field.suggested.reference?.trim() || '',
    };
  }
  return values;
}
