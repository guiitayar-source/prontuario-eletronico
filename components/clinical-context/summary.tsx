'use client';
import { ClipboardList } from 'lucide-react';
import { CollapsibleCard } from '../collapsible-card';
import { conditionLabel, type ClinicalContextController } from './use-clinical-context';

export function ClinicalContextSummary({
  context,
  onEdit,
}: {
  context: ClinicalContextController;
  onEdit: () => void;
}) {
  const activeM = context.medications.filter((x) => x.status === 'active'),
    activeA = context.allergies.filter((x) => x.status === 'active'),
    activeC = context.conditions.filter((x) => x.status !== 'resolved');
  return (
    <CollapsibleCard
      storageKey="contexto"
      title="Contexto clínico"
      icon={<ClipboardList size={16} aria-hidden />}
      action={
        <button className="text-button" onClick={onEdit}>
          Editar
        </button>
      }
    >
      <section className="mini-section">
        <div className="card-heading">
          <span>Diagnósticos e hipóteses</span>
        </div>
        {activeC.length ? (
          activeC.map((x) => (
            <p key={x.id}>
              <strong>
                {x.cid_code && `${x.cid_code} · `}
                {x.description}
              </strong>
              {x.icd11_code && (
                <>
                  <br />
                  <small>CID-11 {x.icd11_code}</small>
                </>
              )}
              <br />
              <small>{conditionLabel[x.status]}</small>
            </p>
          ))
        ) : (
          <p className="muted">Nenhum diagnóstico cadastrado.</p>
        )}
      </section>
      <section className="mini-section">
        <div className="card-heading">
          <span>Medicamentos atuais</span>
        </div>
        {activeM.length ? (
          activeM.map((x) => (
            <p key={x.id}>
              <strong>{x.name}</strong>
              {x.dose && <> · {x.dose}</>}
              {x.instructions && (
                <>
                  <br />
                  <small>{x.instructions}</small>
                </>
              )}
            </p>
          ))
        ) : (
          <p className="muted">Nenhum medicamento em uso.</p>
        )}
      </section>
      <section className="mini-section">
        <div className="card-heading">
          <span>Alergias</span>
        </div>
        {context.allergyState.state === 'none' ? (
          <p>Nega alergias conhecidas.</p>
        ) : context.allergyState.state === 'unknown' ? (
          <p className="muted">Não informadas</p>
        ) : activeA.length ? (
          activeA.map((x) => (
            <p key={x.id}>
              <strong>{x.substance}</strong>
              {x.reaction && (
                <>
                  <br />
                  <small>{x.reaction}</small>
                </>
              )}
            </p>
          ))
        ) : (
          <p className="muted">Alergias indicadas, sem item ativo.</p>
        )}
      </section>
      {context.error && (
        <p className="capture-error" role="alert">
          {context.error}
        </p>
      )}
    </CollapsibleCard>
  );
}
