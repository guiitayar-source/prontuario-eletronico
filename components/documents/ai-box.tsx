'use client';
import type { ClinicalDocument } from '@/lib/document-fields';
import { Sparkles, Trash2 } from 'lucide-react';
import { useDocumentAi } from './use-document-ai';
export function DocumentAiBox({
  document: d,
  onApply,
}: {
  document: ClinicalDocument;
  onApply: (text: string) => void;
}) {
  const {
    open,
    setOpen,
    models,
    templates,
    modelId,
    setModelId,
    templateId,
    instructions,
    setInstructions,
    templateName,
    setTemplateName,
    showTemplateName,
    setShowTemplateName,
    setSavingAsNew,
    includeConsultation,
    setIncludeConsultation,
    includeClinicalContext,
    setIncludeClinicalContext,
    includeCurrentText,
    setIncludeCurrentText,
    proposal,
    setProposal,
    applyMode,
    setApplyMode,
    usage,
    usedModel,
    busy,
    loading,
    error,
    message,
    setMessage,
    matchingTemplates,
    toggle,
    selectTemplate,
    saveTemplate,
    deleteTemplate,
    generate,
    apply,
  } = useDocumentAi(d, onApply);

  return (
    <div className="document-ai">
      <button
        className="secondary document-ai-trigger"
        onClick={toggle}
        type="button"
      >
        <Sparkles size={15} /> Criar com IA
      </button>
      {open && (
        <section className="document-ai-box" aria-label="Criar rascunho com IA">
          <div className="document-ai-heading">
            <div>
              <strong>Criar rascunho com IA</strong>
              <span>
                Você escolhe o que será enviado e revisa antes de salvar.
              </span>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={() => setOpen(false)}
            >
              Recolher
            </button>
          </div>

          {loading ? (
            <p className="muted">Carregando modelos…</p>
          ) : (
            <>
              <div className="document-ai-grid">
                <label>
                  Modelo de instruções
                  <select
                    value={templateId}
                    onChange={(event) => selectTemplate(event.target.value)}
                  >
                    <option value="">Sem modelo salvo</option>
                    {matchingTemplates.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Modelo de IA
                  <select
                    value={modelId}
                    onChange={(event) => {
                      setModelId(event.target.value);
                      window.localStorage.setItem(
                        'psywrite-document-ai-model',
                        event.target.value,
                      );
                    }}
                  >
                    {!modelId && (
                      <option value="">Nenhum modelo configurado</option>
                    )}
                    {models.map((item) => (
                      <option
                        key={item.id}
                        value={item.id}
                        disabled={!item.configured}
                      >
                        {item.label}
                        {item.configured ? '' : ' · não configurado'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label>
                Instruções para este documento
                <textarea
                  className="document-ai-instructions"
                  maxLength={12000}
                  placeholder="Ex.: escreva um relatório conciso para continuidade do tratamento, destacando evolução e conduta."
                  value={instructions}
                  onChange={(event) => {
                    setInstructions(event.target.value);
                    setMessage('');
                  }}
                />
              </label>

              <div className="document-template-actions">
                {!showTemplateName ? (
                  <div className="document-template-choices">
                    {templateId && (
                      <button
                        className="text-button"
                        type="button"
                        disabled={!instructions.trim() || busy}
                        onClick={() => {
                          setSavingAsNew(false);
                          setShowTemplateName(true);
                        }}
                      >
                        Atualizar modelo
                      </button>
                    )}
                    <button
                      className="text-button"
                      type="button"
                      disabled={!instructions.trim() || busy}
                      onClick={() => {
                        setSavingAsNew(true);
                        setTemplateName('');
                        setShowTemplateName(true);
                      }}
                    >
                      Salvar como novo modelo
                    </button>
                  </div>
                ) : (
                  <div className="document-template-save">
                    <input
                      aria-label="Nome do modelo de instruções"
                      maxLength={80}
                      placeholder="Nome do modelo"
                      value={templateName}
                      onChange={(event) => setTemplateName(event.target.value)}
                    />
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => void saveTemplate()}
                    >
                      Salvar
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setShowTemplateName(false);
                        setSavingAsNew(false);
                        setTemplateName(
                          templates.find((item) => item.id === templateId)
                            ?.name || '',
                        );
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                )}
                {templateId && (
                  <button
                    className="text-button danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteTemplate()}
                  >
                    <Trash2 size={14} /> Excluir modelo
                  </button>
                )}
              </div>
              <p className="document-template-note">
                Os modelos ficam na sua conta. Salve somente orientações
                reutilizáveis, sem informações de pacientes.
              </p>

              <fieldset className="document-ai-context">
                <legend>Contexto enviado</legend>
                <p>
                  Nome do paciente, tipo e data do documento são sempre
                  enviados.
                </p>
                {d.consultation_id && (
                  <label>
                    <input
                      type="checkbox"
                      checked={includeConsultation}
                      onChange={(event) =>
                        setIncludeConsultation(event.target.checked)
                      }
                    />
                    Consulta vinculada e seus adendos
                  </label>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={includeClinicalContext}
                    onChange={(event) =>
                      setIncludeClinicalContext(event.target.checked)
                    }
                  />
                  Condições, medicamentos e alergias atuais
                </label>
                {d.text.trim() && (
                  <label>
                    <input
                      type="checkbox"
                      checked={includeCurrentText}
                      onChange={(event) =>
                        setIncludeCurrentText(event.target.checked)
                      }
                    />
                    Texto já escrito neste documento
                  </label>
                )}
              </fieldset>

              {error && (
                <div className="capture-error" role="alert">
                  {error}
                </div>
              )}
              {message && (
                <output className="document-ai-message">{message}</output>
              )}

              <button
                className="primary document-ai-generate"
                type="button"
                disabled={busy || !modelId}
                onClick={() => void generate()}
              >
                <Sparkles size={15} />{' '}
                {busy
                  ? 'Gerando rascunho…'
                  : proposal
                    ? 'Gerar novamente'
                    : 'Gerar rascunho'}
              </button>

              {proposal && (
                <div className="document-ai-result">
                  <div className="document-ai-result-meta">
                    <strong>Rascunho gerado</strong>
                    <span>
                      {usedModel}
                      {usage?.totalTokens
                        ? ` · ${usage.totalTokens.toLocaleString('pt-BR')} tokens`
                        : ''}
                    </span>
                  </div>
                  <textarea
                    aria-label="Rascunho gerado pela IA"
                    value={proposal}
                    onChange={(event) => setProposal(event.target.value)}
                  />
                  {d.text.trim() && (
                    <div className="document-ai-apply-mode">
                      <span>Ao inserir:</span>
                      <label>
                        <input
                          type="radio"
                          name={`ai-apply-${d.id}`}
                          checked={applyMode === 'replace'}
                          onChange={() => setApplyMode('replace')}
                        />
                        Substituir o texto atual
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`ai-apply-${d.id}`}
                          checked={applyMode === 'append'}
                          onChange={() => setApplyMode('append')}
                        />
                        Acrescentar ao final
                      </label>
                    </div>
                  )}
                  <button
                    className="secondary"
                    type="button"
                    disabled={!proposal.trim()}
                    onClick={apply}
                  >
                    Inserir no documento
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
