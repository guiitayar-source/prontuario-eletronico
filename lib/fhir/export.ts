import { createHash, randomUUID } from 'node:crypto';

// SQL owns the snapshot schema; FHIR resources are assembled dynamically below.
// oxlint-disable-next-line typescript/no-explicit-any
type Row = Record<string, any>;
export type Snapshot = {
  patient: Row;
  consultations: Row[];
  conditions: Row[];
  medications: Row[];
  documents: Row[];
  attachments: Row[];
  imports: Row[];
  allergies: Row[];
  allergy_state: string | null;
};
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const narrative = (text: string) => ({
  status: 'generated',
  div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${escape(text).replace(/\n/g, '<br/>')}</p></div>`,
});
const terminology = (name: string, code: string) => ({
  coding: [{ system: `http://terminology.hl7.org/CodeSystem/${name}`, code }],
});

/** A collection, not a signed FHIR document or executable prescription order. */
export function exportFHIR(
  s: Snapshot,
  origin: string,
  embedded: Map<string, Buffer> = new Map(),
) {
  const entries: { fullUrl: string; resource: Row }[] = [];
  const id = (type: string, source: string) => {
    const hash = createHash('sha1')
      .update(Buffer.from('9bd21a963ec44567b8211375e5f02840', 'hex'))
      .update(JSON.stringify([s.patient.clinic_id, type, source]))
      .digest()
      .subarray(0, 16);
    hash[6] = (hash[6] & 15) | 0x50;
    hash[8] = (hash[8] & 63) | 0x80;
    return hash
      .toString('hex')
      .replace(
        /^(........)(....)(....)(....)(............)$/,
        '$1-$2-$3-$4-$5',
      );
  };
  const ref = (type: string, source: string) => ({
    reference: `urn:uuid:${id(type, source)}`,
  });
  const add = (type: string, source: string, data: Row) => {
    const resource = { resourceType: type, id: id(type, source), ...data };
    entries.push({ fullUrl: ref(type, source).reference, resource });
    return resource;
  };
  const p = s.patient,
    subject = ref('Patient', p.id);
  const patient: Row = {
    name: [{ use: 'official', text: p.name }],
    identifier: [{ system: `${origin}/identifiers/patients`, value: p.id }],
  };
  if (p.social_name) patient.name.push({ use: 'usual', text: p.social_name });
  if (p.cpf)
    patient.identifier.push({
      system: 'http://hl7.org.br/fhir/r4/NamingSystem/cpf',
      value: p.cpf,
    });
  if (p.dob) patient.birthDate = p.dob;
  const telecom = [
    ['phone', p.phone],
    ['phone', p.secondary_phone],
    ['email', p.email],
  ]
    .filter(([, v]) => v)
    .map(([system, value]) => ({ system, value }));
  if (telecom.length) patient.telecom = telecom;
  const address = [p.street, p.address_number, p.complement, p.neighborhood]
    .filter(Boolean)
    .join(', ');
  if (address || p.city || p.state || p.zip_code)
    patient.address = [
      {
        ...(address ? { line: [address] } : {}),
        ...(p.city ? { city: p.city } : {}),
        ...(p.state ? { state: p.state } : {}),
        ...(p.zip_code ? { postalCode: p.zip_code } : {}),
      },
    ];
  // The free-text gender field is not an administrative sex code. Preserve it in the supplement.
  add('Patient', p.id, patient);
  const textDocument = (
    source: string,
    title: string,
    text: string,
    extra: Row = {},
  ) =>
    add('DocumentReference', source, {
      status: 'current',
      subject,
      type: { text: title },
      content: [
        {
          attachment: {
            contentType: 'text/plain; charset=utf-8',
            title,
            data: Buffer.from(text || '(sem texto)').toString('base64'),
          },
        },
      ],
      ...extra,
    });
  const demographics = Object.entries(p)
    .filter(
      ([key, value]) =>
        value && !['search_text', 'draft_key', 'clinic_id'].includes(key),
    )
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  textDocument(
    'demographics:' + p.id,
    'Informações cadastrais complementares',
    demographics,
  );
  for (const v of s.consultations) {
    const text = [
      v.text || '(sem texto)',
      ...(v.addenda || []).map(
        (a: Row) => `Adendo registrado em ${a.created_at}:\n${a.text}`,
      ),
    ].join('\n\n');
    add('Encounter', v.id, {
      status: v.finalized_at ? 'finished' : 'in-progress',
      class: {
        system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        code: 'AMB',
      },
      subject,
      period: {
        start: v.created_at,
        ...(v.finalized_at ? { end: v.finalized_at } : {}),
      },
      text: narrative(text),
    });
  }
  for (const c of s.conditions)
    add('Condition', c.id, {
      subject,
      clinicalStatus: terminology(
        'condition-clinical',
        c.status === 'resolved' ? 'resolved' : 'active',
      ),
      ...(c.status === 'resolved'
        ? {}
        : {
            verificationStatus: terminology(
              'condition-ver-status',
              c.status === 'hypothesis' ? 'provisional' : 'confirmed',
            ),
          }),
      code: {
        text: c.description,
        ...(c.cid_code
          ? {
              coding: [
                { system: 'http://hl7.org/fhir/sid/icd-10', code: c.cid_code },
              ],
            }
          : {}),
      },
      recordedDate: c.created_at,
      ...(c.notes ? { note: [{ text: c.notes }] } : {}),
    });
  for (const m of s.medications)
    add('MedicationRequest', m.id, {
      status: m.status === 'stopped' ? 'stopped' : 'active',
      intent: 'plan',
      subject,
      medicationCodeableConcept: { text: m.name },
      ...([m.dose, m.instructions].filter(Boolean).length
        ? {
            dosageInstruction: [
              { text: [m.dose, m.instructions].filter(Boolean).join('\n') },
            ],
          }
        : {}),
      note: [
        {
          text: 'Lista de medicamentos registrada no PsyWrite. Exportada como plano terapêutico; não constitui receita assinada.',
        },
      ],
    });
  for (const d of s.documents)
    textDocument(
      'document:' + d.id,
      d.kind,
      `${d.kind}\nData do documento: ${d.document_date}\n${d.physician_name}\n${d.physician_registration}\n\n${d.text}`,
      {
        docStatus: 'preliminary',
        date: d.created_at,
        ...(d.consultation_id
          ? { context: { encounter: [ref('Encounter', d.consultation_id)] } }
          : {}),
      },
    );
  for (const a of s.attachments) {
    const data = embedded.get(a.id);
    add('DocumentReference', 'attachment:' + a.id, {
      status: 'current',
      subject,
      type: { text: a.category },
      date: a.created_at,
      content: [
        {
          attachment: {
            contentType: a.mime,
            title: a.name,
            size: a.size,
            creation: a.created_at,
            ...(data
              ? { data: data.toString('base64') }
              : {
                  url: `${origin}/api/fhir?patientId=${encodeURIComponent(p.id)}&attachment=${encodeURIComponent(a.id)}&clinicId=${encodeURIComponent(p.clinic_id)}`,
                }),
          },
        },
      ],
    });
  }
  for (const r of s.imports)
    textDocument(
      'import:' + r.id,
      r.title || 'Histórico importado',
      [
        `Origem: ${r.source}`,
        `Tipo original: ${r.kind}`,
        `Identificador original: ${r.source_id}`,
        `Data clínica original: ${r.occurred_at || 'não informada'}`,
        `Estado original: ${r.source_status || 'não informado'}`,
        r.text,
      ].join('\n'),
      {
        description:
          'Registro histórico importado, preservado como texto; não promovido a diagnóstico ou prescrição atual.',
      },
    );
  textDocument(
    'allergies:' + p.id,
    'Estado de alergias registrado',
    [
      `Estado: ${s.allergy_state || 'unknown'}`,
      ...s.allergies.map(
        (a) =>
          `${a.substance}: ${a.reaction || 'reação não informada'} (${a.status})`,
      ),
    ].join('\n'),
  );
  return {
    resourceType: 'Bundle',
    id: randomUUID(),
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: entries,
  };
}
