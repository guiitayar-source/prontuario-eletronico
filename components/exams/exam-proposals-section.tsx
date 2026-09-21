'use client';
import type { ExamDefinition } from '@/lib/exams';
import type { ExamExtractionProposal } from '@/lib/exam-extraction';

const dateLabel = (date: string) => date.split('-').reverse().join('/');

export type ExamProposalsSectionProps = {
  extraction: ExamExtractionProposal;
  definitions: ExamDefinition[];
  onDismiss: () => void;
  onReviewProposal: (
    exam: ExamExtractionProposal['exams'][number],
    index: number,
  ) => void;
};

export function ExamProposalsSection({
  extraction,
  definitions,
  onDismiss,
  onReviewProposal,
}: ExamProposalsSectionProps) {
  return (
    <section className="exam-proposals" aria-label="Sugestões da IA">
      <div className="exam-proposal-heading">
        <div>
          <h3>Sugestões para revisar</h3>
          <small>
            {extraction.provider} · {extraction.model} · estimativas de confiança
            não garantem exatidão
          </small>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={onDismiss}
        >
          Descartar sugestões
        </button>
      </div>
      {extraction.warnings.length > 0 && (
        <ul className="exam-ai-warnings">
          {extraction.warnings.map((warning, index) => (
            <li key={`${warning}-${index}`}>{warning}</li>
          ))}
        </ul>
      )}
      {extraction.exams.map((exam, index) => {
        const definition = definitions.find(
          (item) => item.id === exam.definitionId,
        );
        const values = exam.fields.filter((field) =>
          field.suggested.value?.trim(),
        ).length;
        return (
          <article
            className="exam-proposal"
            key={`${exam.originalName}-${index}`}
          >
            <div>
              <strong>{definition?.name || exam.originalName}</strong>
              <small>
                {definition
                  ? `${values} valor(es) sugerido(s)${
                      exam.collectedOn
                        ? ` · coleta ${dateLabel(exam.collectedOn)}`
                        : ''
                    }`
                  : 'Sem correspondência segura com o catálogo'}
              </small>
            </div>
            <button
              type="button"
              className="secondary"
              disabled={!definition || values === 0}
              onClick={() => onReviewProposal(exam, index)}
            >
              Revisar e preencher
            </button>
          </article>
        );
      })}
      {!extraction.exams.length && (
        <p>Nenhum resultado foi identificado neste arquivo.</p>
      )}
    </section>
  );
}

export default ExamProposalsSection;
