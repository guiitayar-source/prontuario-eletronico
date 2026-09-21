'use client';
import type { ExamDefinition, ExamField } from '@/lib/exams';

export const emptyField = (): ExamField => ({
  id: `f_${crypto.randomUUID().replaceAll('-', '')}`,
  name: '',
  type: 'number',
  unit: '',
});

export type ExamDefinitionFormProps = {
  custom: ExamDefinition;
  setCustom: (def: ExamDefinition | null) => void;
  onSave: (event: React.SyntheticEvent<HTMLFormElement>) => Promise<void>;
  busy: boolean;
};

export function ExamDefinitionForm({
  custom,
  setCustom,
  onSave,
  busy,
}: ExamDefinitionFormProps) {
  return (
    <form onSubmit={onSave} className="exam-editor">
      <h3>Novo exame da clínica</h3>
      <p>Defina os parâmetros uma vez para reutilizar em outros pacientes.</p>
      <div className="exam-meta">
        <label>
          Nome
          <input
            required
            maxLength={160}
            value={custom.name}
            onChange={(e) => setCustom({ ...custom, name: e.target.value })}
          />
        </label>
        <label>
          Sinônimos (separados por vírgula)
          <input
            value={custom.aliases.join(',')}
            onChange={(e) =>
              setCustom({
                ...custom,
                aliases: e.target.value.split(','),
              })
            }
          />
        </label>
      </div>
      {custom.fields.map((field, i) => (
        <div className="exam-custom-field" key={field.id}>
          <label>
            Parâmetro {i + 1}
            <input
              required
              maxLength={120}
              value={field.name}
              onChange={(e) =>
                setCustom({
                  ...custom,
                  fields: custom.fields.map((f) =>
                    f.id === field.id ? { ...f, name: e.target.value } : f,
                  ),
                })
              }
            />
          </label>
          <label>
            Tipo
            <select
              aria-label="Tipo"
              value={field.type}
              onChange={(e) =>
                setCustom({
                  ...custom,
                  fields: custom.fields.map((f) =>
                    f.id === field.id
                      ? {
                          ...f,
                          type: e.target.value as ExamField['type'],
                        }
                      : f,
                  ),
                })
              }
            >
              <option value="number">Número</option>
              <option value="text">Texto</option>
              <option value="choice">Opções</option>
            </select>
          </label>
          {field.type === 'choice' ? (
            <label>
              Opções (separadas por vírgula)
              <input
                required
                value={field.options?.join(',') || ''}
                onChange={(e) =>
                  setCustom({
                    ...custom,
                    fields: custom.fields.map((f) =>
                      f.id === field.id
                        ? { ...f, options: e.target.value.split(',') }
                        : f,
                    ),
                  })
                }
              />
            </label>
          ) : (
            <label>
              Unidade sugerida
              <input
                maxLength={40}
                value={field.unit}
                onChange={(e) =>
                  setCustom({
                    ...custom,
                    fields: custom.fields.map((f) =>
                      f.id === field.id ? { ...f, unit: e.target.value } : f,
                    ),
                  })
                }
              />
            </label>
          )}
          <button
            type="button"
            className="text-button"
            disabled={custom.fields.length === 1 || busy}
            onClick={() =>
              setCustom({
                ...custom,
                fields: custom.fields.filter((f) => f.id !== field.id),
              })
            }
          >
            Remover
          </button>
        </div>
      ))}
      <div className="exam-actions">
        <button
          type="button"
          className="secondary"
          disabled={custom.fields.length >= 50 || busy}
          onClick={() =>
            setCustom({
              ...custom,
              fields: [...custom.fields, emptyField()],
            })
          }
        >
          Adicionar parâmetro
        </button>
        <button className="primary" disabled={busy}>
          Salvar modelo e preencher
        </button>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => setCustom(null)}
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}

export default ExamDefinitionForm;
