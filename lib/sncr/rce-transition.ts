// Server only. RCE eletrônica sem numeração SNCR no período de transição (sncrTransitionEnd):
// modelo oficial da Anvisa (rce-pdf.ts) preenchido a partir do documento, assinado com
// certificado ICP-Brasil (RDC 1.000/2025, art. 8º). Campos da Portaria 344, art. 55, na redação
// da RDC 1.000: emitente com endereço completo e telefone; paciente com nome e CPF (ou passaporte).
import type { ClinicalDocument } from '../document-fields.ts';
import { validateRceFields, validateRceSnapshot, type RceSnapshot } from './rce.ts';
import { rcePdf } from './rce-pdf.ts';

export function rceTransitionSnapshot(doc: ClinicalDocument): RceSnapshot {
  if (!doc.rce_fields)
    throw new Error(
      'RCE eletrônica: preencha CRM/UF, medicamento, concentração, forma farmacêutica, quantidade e posologia.',
    );
  const f = validateRceFields(doc.rce_fields);
  const cpf = (doc.patient_cpf || '').replace(/\D/g, '');
  const identifier = cpf || (f.passport ? `Passaporte ${f.passport}` : '');
  if (!identifier)
    throw new Error(
      'RCE eletrônica: informe o CPF do paciente no cadastro (ou o passaporte, se estrangeiro).',
    );
  if (!doc.patient_address || !doc.patient_address_number || !doc.patient_city || !doc.patient_state)
    throw new Error(
      'RCE eletrônica: complete logradouro, número, cidade e UF do paciente no cadastro.',
    );
  if (!doc.letterhead_address?.trim() || !doc.letterhead_phone?.trim())
    throw new Error(
      'RCE eletrônica: informe endereço completo e telefone do consultório nos dados profissionais.',
    );
  return validateRceSnapshot({
    schema: 1,
    patient: {
      name: doc.patient_name,
      identifier,
      address: [
        doc.patient_address,
        `${doc.patient_city}/${doc.patient_state}`,
        doc.patient_zip_code,
      ]
        .filter(Boolean)
        .join(', '),
    },
    prescriber: {
      name: doc.physician_name,
      cpf: doc.prescriber_cpf || '',
      crm: f.crm,
      uf: f.uf,
      address: doc.letterhead_address,
      phone: doc.letterhead_phone,
    },
    medicine: {
      name: f.medicine,
      concentration: f.concentration,
      pharmaceuticalForm: f.pharmaceuticalForm,
      quantity: f.quantity,
      dosage: f.dosage,
    },
    platform: process.env.SNCR_PLATFORM_NAME || 'PsyWrite',
  });
}

/** PDF oficial da RCE eletrônica de transição. A data impressa é a data da assinatura (art. 12). */
export async function rceTransitionPdf(doc: ClinicalDocument, issuedAt: Date) {
  return rcePdf(rceTransitionSnapshot(doc), null, issuedAt, 'transition');
}
