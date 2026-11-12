// Lógica dos diagnósticos do atendimento: o que está ligado à consulta, o que o paciente já tem,
// o rascunho de um diagnóstico novo e o bloco escrito no fim da evolução.
// A tela está em consultation-diagnoses.tsx.
import { useEffect, useRef, useState } from 'react';
import { diagnosisBlock } from '@/lib/cid/evolution-block';
import type { ClinicalContextController, Condition } from '../clinical-context';
import type { CidEntry, Icd11Choice } from './types';

export type Draft = {
  description: string;
  cid_code: string;
  status: Condition['status'];
  icd11: Icd11Choice | null;
};

export type ConsultationDiagnosesProps = {
  context: ClinicalContextController;
  consultationId?: string;
  locked: boolean;
  /** Recebe o bloco de diagnósticos a escrever no fim da evolução. */
  onEvolutionBlock?: (block: string) => void;
};

/** Estado e ações dos diagnósticos do atendimento. */
export function useConsultationDiagnoses({
  context,
  consultationId,
  locked,
  onEvolutionBlock,
}: ConsultationDiagnosesProps) {
  const [draft, setDraft] = useState<Draft | null>(null),
    [expanded, setExpanded] = useState<string | null>(null);
  const links = context.consultationDiagnoses.filter(
    (x) => x.consultation_id === consultationId,
  );
  // Após uma alteração feita aqui, reescreve o bloco quando a lista recarregar.
  const pendingBlock = useRef(false);
  const blockRef = useRef(onEvolutionBlock);
  blockRef.current = onEvolutionBlock;
  useEffect(() => {
    if (!pendingBlock.current || locked) return;
    pendingBlock.current = false;
    blockRef.current?.(
      diagnosisBlock(
        context.consultationDiagnoses.filter(
          (x) => x.consultation_id === consultationId,
        ),
      ),
    );
  }, [context.consultationDiagnoses, consultationId, locked]);
  async function track(action: Promise<boolean>) {
    if (await action) pendingBlock.current = true;
  }
  const linkedIds = new Set(links.map((x) => x.condition_id));
  const byId = new Map(context.conditions.map((x) => [x.id, x]));
  const previous = context.conditions.filter(
    (x) => x.status !== 'resolved' && !linkedIds.has(x.id),
  );
  const disabled = !consultationId || context.busy;

  function conditionRecord(c: Condition, patch: Partial<Condition>) {
    return {
      ...c,
      ...patch,
      entity: 'condition',
      patient_id: context.patientId,
      consultation_id: consultationId,
    };
  }
  async function add() {
    if (!draft || !consultationId) return;
    const record = {
      ...context.emptyCondition(),
      description: draft.description.trim(),
      cid_code: draft.cid_code,
      status: draft.status,
      icd11_code: draft.icd11?.code || '',
      icd11_title: draft.icd11?.title || '',
      icd11_release: draft.icd11?.release || '',
      consultation_id: consultationId,
    };
    if (await context.save(record)) {
      pendingBlock.current = true;
      setDraft(null);
    }
  }

  /** Muda a situação de um diagnóstico já incluído no atendimento. */
  function changeStatus(condition: Condition, status: Condition['status']) {
    void track(context.save(conditionRecord(condition, { status })));
  }

  /** Tira o diagnóstico deste atendimento; ele continua no histórico do paciente. */
  function unlink(condition: Condition) {
    void track(context.link(consultationId!, condition.id, false));
  }

  /** Escolhe (ou desfaz, com `null`) o código CID-11 de um diagnóstico já incluído. */
  function chooseIcd11(condition: Condition, choice: Icd11Choice | null) {
    void track(
      context.save(
        conditionRecord(condition, {
          icd11_code: choice?.code || '',
          icd11_title: choice?.title || '',
          icd11_release: choice?.release || '',
        }),
      ),
    );
  }

  /** Inclui neste atendimento um diagnóstico que o paciente já tinha. */
  function include(c: Condition) {
    void track(context.link(consultationId!, c.id, true));
  }

  /** Começa um diagnóstico novo a partir de um código do catálogo CID-10. */
  function startDraft(x: CidEntry) {
    setDraft({
      description: x.title,
      cid_code: x.code,
      status: 'hypothesis',
      icd11: null,
    });
  }

  /** Começa um diagnóstico novo só com texto, sem código. */
  function startFreeDraft(text: string) {
    setDraft({
      description: text,
      cid_code: '',
      status: 'hypothesis',
      icd11: null,
    });
  }

  return {
    draft,
    setDraft,
    expanded,
    setExpanded,
    links,
    byId,
    previous,
    disabled,
    add,
    changeStatus,
    unlink,
    chooseIcd11,
    include,
    startDraft,
    startFreeDraft,
  };
}
