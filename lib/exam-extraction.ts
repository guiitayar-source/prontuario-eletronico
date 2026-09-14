import type { ExamValue } from './exams';

/** Boundary for a future local/external extractor. Proposals are NOT results.
 * Missing/ambiguous values stay absent. Only a reviewed manual result can be
 * submitted to the current API. Provider credentials must stay server-side.
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
      page: number;
      originalText: string;
      confidence: number | null;
      warnings: string[];
    }[];
  }[];
};
