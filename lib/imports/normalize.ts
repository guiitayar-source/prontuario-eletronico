import { createHash } from 'node:crypto';
import { validate } from '../patients.ts';
import { fields, type PatientInput } from '../patient-fields.ts';
import { kindLabels, type Kind, type ImportPlan } from './types.ts';
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
function plain(v: unknown): string {
  return str(v)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}
function concept(v: unknown): string {
  const x = obj(v);
  return (
    str(x.text) ||
    arr(x.coding)
      .map((c) =>
        [str(obj(c).code), str(obj(c).display)].filter(Boolean).join(' · '),
      )
      .join('; ')
  );
}
function notes(v: unknown): string {
  return arr(v)
    .map((x) => str(obj(x).text))
    .filter(Boolean)
    .join('\n');
}
function date(v: unknown, warnings: string[], label: string): string | null {
  const s = str(v);
  if (!s) return null;
  const day = s.slice(0, 10);
  const validDay =
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day;
  if (
    validDay &&
    (s.length === 10 ||
      (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(
        s,
      ) &&
        Number.isFinite(Date.parse(s))))
  )
    return s;
  warnings.push(
    `${label}: data ausente de fuso, parcial ou inválida; valor original preservado no texto.`,
  );
  return null;
}
export function normalizeImport(input: unknown): ImportPlan {
  const root = obj(input);
  const plan: ImportPlan = {
    format: root.resourceType === 'Bundle' ? 'fhir-r4' : 'lgpd',
    patients: [],
    records: [],
    warnings: [],
  };
  const warning = (s: string) => {
    if (!plan.warnings.includes(s)) plan.warnings.push(s);
  };
  function patient(source: string, data: Obj) {
    if (!source || source.length > 180)
      throw new Error('Paciente sem identificador de origem válido.');
    if (plan.patients.some((p) => p.source_id === source))
      throw new Error('Identificador de paciente repetido no arquivo.');
    const { p, errors } = validate(data);
    const warnings: string[] = [],
      blocking: string[] = [];
    for (const [field, message] of Object.entries(errors)) {
      if (field === 'name') blocking.push(message);
      else {
        warnings.push(`${field}: ${message} Campo não será gravado.`);
        p[field as keyof PatientInput] = '';
      }
    }
    plan.patients.push({
      source_id: source,
      fields: p,
      warnings,
      errors: blocking,
    });
  }
  function record(
    kind: Kind,
    source: unknown,
    pid: string,
    title: string,
    text: string,
    occurred: unknown,
    created: unknown,
    status: unknown,
  ) {
    if (plan.records.length >= 500)
      throw new Error(
        'Máximo de 500 registros por arquivo. Divida a exportação.',
      );
    const occurred_at = date(occurred, plan.warnings, title),
      source_created_at = date(created, plan.warnings, title);
    const dates = [
      str(occurred) && !occurred_at ? `Data original: ${str(occurred)}` : '',
      str(created) && !source_created_at
        ? `Criação original: ${str(created)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const data = {
      patient_source: pid,
      kind,
      title: title || kindLabels[kind],
      text: [text, dates].filter(Boolean).join('\n'),
      occurred_at,
      source_created_at,
      source_status: str(status),
    };
    if (
      data.title.length > 500 ||
      data.text.length > 100000 ||
      data.source_status.length > 100
    )
      throw new Error(
        'Um registro excede o limite de tamanho. Divida a exportação.',
      );
    const source_id = str(source) || 'content-' + hash(data);
    if (!str(source))
      warning(
        'Há registros sem ID: a detecção de repetição usará o conteúdo; alterações futuras precisarão de revisão.',
      );
    if (source_id.length > 300)
      throw new Error('Identificador de origem acima do limite.');
    const next = { ...data, source_id, fingerprint: hash(data) };
    const old = plan.records.find(
      (r) =>
        r.kind === kind &&
        r.source_id === source_id &&
        r.patient_source === pid,
    );
    if (old) {
      if (old.fingerprint !== next.fingerprint)
        throw new Error(
          'Mesmo identificador com conteúdos diferentes no arquivo. Exporte a versão atual.',
        );
      warning('Itens idênticos repetidos dentro do arquivo foram agrupados.');
      return;
    }
    plan.records.push(next);
  }
  if (plan.format === 'lgpd') {
    if (!root.patient || !('consultations' in root || 'schema_version' in root))
      throw new Error(
        'Formato não reconhecido. Use exportação LGPD JSON ou Bundle FHIR R4.',
      );
    const p = obj(root.patient),
      pid = str(p.id);
    const data: Obj = Object.fromEntries(fields.map((f) => [f, str(p[f])]));
    Object.assign(data, {
      gender: str(p.gender_identity) || str(p.biological_sex),
      emergency_name: str(p.emergency_contact_name),
      emergency_phone: str(p.emergency_contact_phone),
      street: typeof p.address === 'string' ? p.address : str(p.street),
      complement: str(p.address_complement) || str(p.complement),
      admin_notes: str(p.secretary_notes),
    });
    patient(pid, data);
    const sections = [
      'consultations',
      'prescriptions',
      'medications',
      'appointments',
      'allergies',
      'documents',
    ] as const;
    for (const section of sections) {
      if (root[section] != null && !Array.isArray(root[section]))
        throw new Error(`A seção ${section} deve ser uma lista.`);
      for (const value of arr(root[section])) {
        const r = obj(value);
        if (r.patient_id != null && str(r.patient_id) !== pid)
          throw new Error(
            `Registro em ${section} pertence a outro paciente. Importação bloqueada.`,
          );
        const diag = arr(r.diagnosis)
          .map((d) =>
            [str(obj(d).code), str(obj(d).name)].filter(Boolean).join(' · '),
          )
          .join('\n');
        if (section === 'consultations') {
          const pieces = [
            ['Evolução', str(r.hma)],
            ['Plano', str(r.plan)],
            ['Diagnósticos', diag || str(r.diagnosis)],
            ['Exames', str(r.lab_notes)],
            [
              'Exame psíquico',
              Object.entries(obj(r.mse))
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => `${str(k)}: ${str(v)}`)
                .join('\n'),
            ],
          ];
          const content = pieces
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}\n${v}`)
            .join('\n\n');
          if (!content)
            warning('Há consultas sem narrativa clínica no arquivo.');
          record(
            'consultation',
            r.id,
            pid,
            'Consulta importada',
            content,
            r.attended_at,
            r.created_at,
            r.is_inactive === true ? 'inativa na origem' : r.status,
          );
          if (r.signed_at)
            warning(
              'Datas de assinatura da origem não representam assinatura digital validada no PsyWrite.',
            );
          if (r.is_inactive)
            warning(
              'Há consulta marcada inativa na origem; confira o histórico antes de utilizá-la.',
            );
        } else if (section === 'medications') {
          record(
            'medication',
            r.id,
            pid,
            str(r.name) || 'Medicamento sem nome',
            [
              ['Dose', r.dose],
              ['Frequência', r.frequency],
              ['Via', r.route],
              ['Suspenso em', r.stopped_at],
              ['Motivo da suspensão', r.reason_stopped],
              ['Observações', r.notes],
            ]
              .filter(([, v]) => str(v))
              .map(([k, v]) => `${str(k)}: ${str(v)}`)
              .join('\n'),
            r.started_at,
            r.created_at,
            r.status,
          );
        } else if (section === 'prescriptions') {
          const items = obj(r.items);
          const content =
            str(items._freeText) ||
            arr(r.items)
              .map((x) => {
                const i = obj(x);
                return [
                  'name',
                  'medication',
                  'dose',
                  'frequency',
                  'instructions',
                  'quantity',
                ]
                  .map((k) => str(i[k]))
                  .filter(Boolean)
                  .join(' · ');
              })
              .join('\n');
          if (!content)
            warning(
              'Receita sem texto reconhecido; confira a exportação de origem.',
            );
          record(
            'prescription',
            r.id,
            pid,
            'Receita importada',
            [content, str(r.notes)].filter(Boolean).join('\n'),
            r.issued_at,
            r.created_at,
            r.status,
          );
        } else if (section === 'appointments') {
          record(
            'appointment',
            r.id,
            pid,
            str(r.title) || 'Agendamento importado',
            [
              ['Modalidade', r.modality],
              ['Término', r.end_time],
              ['Observações', r.notes],
            ]
              .filter(([, v]) => str(v))
              .map(([k, v]) => `${str(k)}: ${str(v)}`)
              .join('\n'),
            r.start_time,
            r.created_at,
            r.status,
          );
        } else if (section === 'allergies') {
          record(
            'allergy',
            r.id,
            pid,
            str(r.substance) ||
              str(r.name) ||
              str(r.allergen) ||
              'Alergia sem descrição',
            [str(r.reaction), str(r.notes)].filter(Boolean).join('\n'),
            r.onset || r.onset_date,
            r.created_at,
            r.status,
          );
        } else {
          record(
            'document',
            r.id,
            pid,
            str(r.title) || str(r.type) || 'Documento importado',
            str(r.content) || str(r.text) || str(r.notes),
            r.issued_at,
            r.created_at,
            r.status,
          );
          warning(
            'Documentos são importados como texto; PDFs, imagens e assinaturas devem ser anexados separadamente.',
          );
        }
      }
    }
    if (str(p.allergies) || p.nkda === true)
      record(
        'allergy',
        'patient-allergies',
        pid,
        'Alergias informadas no cadastro de origem',
        str(p.allergies) || 'Nega alergias conhecidas na origem.',
        null,
        p.created_at,
        'origem',
      );
    if (str(p.diagnosis))
      record(
        'condition',
        'patient-diagnosis',
        pid,
        'Diagnóstico informado no cadastro',
        str(p.diagnosis),
        null,
        p.created_at,
        'origem',
      );
    for (const section of ['files', 'indicators'])
      if (arr(root[section]).length)
        warning(
          `${section}: ${arr(root[section]).length} item(ns) não importado(s) nesta versão. Preserve a exportação original.`,
        );
    warning(
      'Campos adicionais, consentimentos, credenciais, links externos e tokens da origem não são transferidos.',
    );
  } else {
    if (!['collection', 'document', 'searchset'].includes(str(root.type)))
      throw new Error(
        'Use Bundle de coleção, documento ou busca. Bundles de transações/histórico não são executados.',
      );
    if (!Array.isArray(root.entry)) throw new Error('Bundle sem lista entry.');
    if (arr(root.entry).length > 1000)
      throw new Error('Máximo de 1.000 recursos por arquivo.');
    const entries = arr(root.entry).map((x) => ({
      fullUrl: str(obj(x).fullUrl),
      r: obj(obj(x).resource),
    }));
    const refs = new Map<string, Obj>();
    const patientRefs = new Map<string, string>();
    for (const { fullUrl, r } of entries) {
      const relative = str(r.resourceType) + '/' + str(r.id);
      for (const key of [fullUrl, str(r.id) ? relative : ''].filter(Boolean)) {
        if (refs.has(key))
          throw new Error('Referência FHIR ambígua ou repetida.');
        refs.set(key, r);
      }
      if (r.resourceType === 'Patient') {
        const pid = str(r.id) || fullUrl;
        const names = arr(r.name).map(obj),
          name = names.find((n) => n.use === 'official') || names[0] || {};
        const address = obj(arr(r.address)[0]);
        const contact = arr(r.telecom).map(obj),
          identifier = arr(r.identifier)
            .map(obj)
            .find((x) => /cpf/i.test(str(x.system)));
        patient(pid, {
          name:
            str(name.text) ||
            [...arr(name.given).map(str), str(name.family)]
              .filter(Boolean)
              .join(' '),
          dob: str(r.birthDate),
          cpf: str(identifier?.value),
          gender: str(r.gender),
          phone: str(contact.find((x) => x.system === 'phone')?.value),
          email: str(contact.find((x) => x.system === 'email')?.value),
          street: arr(address.line).map(str).join(' '),
          city: str(address.city),
          state: str(address.state),
          zip_code: str(address.postalCode),
        });
        for (const key of [fullUrl, str(r.id) ? relative : ''].filter(Boolean))
          patientRefs.set(key, pid);
      }
    }
    const resolve = (ref: unknown, owner: Obj): Obj => {
      const s = str(obj(ref).reference);
      return s.startsWith('#')
        ? obj(arr(owner.contained).find((v) => str(obj(v).id) === s.slice(1)))
        : refs.get(s) || {};
    };
    for (const { fullUrl, r } of entries) {
      const type = str(r.resourceType);
      if (['Patient', 'Medication'].includes(type)) continue;
      if (
        ![
          'Encounter',
          'Condition',
          'MedicationRequest',
          'AllergyIntolerance',
        ].includes(type)
      ) {
        warning(`Recurso ${type || 'sem tipo'} não importado nesta versão.`);
        continue;
      }
      const pid = patientRefs.get(str(obj(r.subject || r.patient).reference));
      if (!pid)
        throw new Error(
          `${type}: referência de paciente ausente ou não resolvida dentro do Bundle.`,
        );
      const id = str(r.id) || fullUrl,
        narrative = plain(obj(r.text).div),
        created = obj(r.meta).lastUpdated;
      if (type === 'Encounter')
        record(
          'consultation',
          id,
          pid,
          concept(arr(r.type)[0]) || 'Atendimento importado',
          [
            narrative,
            notes(r.note),
            arr(r.diagnosis)
              .map((d) => concept(resolve(obj(d).condition, r).code))
              .filter(Boolean)
              .join('\n'),
          ]
            .filter(Boolean)
            .join('\n\n'),
          obj(r.period).start,
          null,
          r.status,
        );
      if (type === 'Condition')
        record(
          'condition',
          id,
          pid,
          concept(r.code) || 'Diagnóstico sem descrição',
          [
            notes(r.note),
            narrative,
            `Verificação: ${concept(r.verificationStatus) || 'não informada'}`,
          ]
            .filter(Boolean)
            .join('\n'),
          r.onsetDateTime || obj(r.onsetPeriod).start,
          r.recordedDate,
          concept(r.clinicalStatus),
        );
      if (type === 'MedicationRequest') {
        const medication =
          concept(r.medicationCodeableConcept) ||
          concept(resolve(r.medicationReference, r).code) ||
          str(obj(r.medicationReference).display);
        const quantity = (v: unknown) => {
          const q = obj(v);
          return [str(q.value), str(q.unit) || str(q.code)]
            .filter(Boolean)
            .join(' ');
        };
        const dosage = arr(r.dosageInstruction)
          .map((v) => {
            const d = obj(v),
              timing = obj(d.timing),
              repeat = obj(timing.repeat);
            const lines = [str(d.text)];
            for (const [label, value] of [
              ['Via', concept(d.route)],
              ['Local', concept(d.site)],
              ['Método', concept(d.method)],
              ['Horário descrito', concept(timing.code)],
            ])
              if (value) lines.push(`${label}: ${value}`);
            for (const item of arr(d.doseAndRate)) {
              const dose = obj(item),
                range = obj(dose.doseRange);
              const text =
                quantity(dose.doseQuantity) ||
                [quantity(range.low), quantity(range.high)]
                  .filter(Boolean)
                  .join(' a ');
              if (text) lines.push('Dose: ' + text);
              if (quantity(dose.rateQuantity))
                lines.push('Velocidade: ' + quantity(dose.rateQuantity));
            }
            const repeatLabels: Record<string, string> = {
              frequency: 'Frequência',
              frequencyMax: 'Frequência máxima',
              period: 'Período',
              periodMax: 'Período máximo',
              periodUnit: 'Unidade do período',
              duration: 'Duração',
              durationMax: 'Duração máxima',
              durationUnit: 'Unidade da duração',
              count: 'Número de administrações',
              countMax: 'Número máximo',
              offset: 'Deslocamento em minutos',
            };
            for (const [key, label] of Object.entries(repeatLabels))
              if (str(repeat[key])) lines.push(`${label}: ${str(repeat[key])}`);
            for (const [key, label] of [
              ['dayOfWeek', 'Dias da semana'],
              ['timeOfDay', 'Horários'],
              ['when', 'Momentos de administração'],
            ])
              if (arr(repeat[key]).length)
                lines.push(`${label}: ${arr(repeat[key]).map(str).join(', ')}`);
            if (arr(timing.event).length)
              lines.push(
                'Datas específicas: ' + arr(timing.event).map(str).join(', '),
              );
            if (str(obj(repeat.boundsPeriod).start))
              lines.push('Início: ' + str(obj(repeat.boundsPeriod).start));
            if (str(obj(repeat.boundsPeriod).end))
              lines.push('Fim: ' + str(obj(repeat.boundsPeriod).end));
            if (d.asNeededBoolean === true)
              lines.push('Se necessário (conforme origem).');
            if (concept(d.asNeededCodeableConcept))
              lines.push(
                'Se necessário: ' + concept(d.asNeededCodeableConcept),
              );
            lines.push(...arr(d.additionalInstruction).map(concept));
            if (!str(d.text))
              warning(
                'Há posologia estruturada FHIR: confira os valores e unidades originais antes de emitir uma nova receita.',
              );
            return lines.filter(Boolean).join('\n');
          })
          .filter(Boolean)
          .join('\n\n');
        if (!medication)
          throw new Error(
            'MedicationRequest sem medicamento resolvido. Inclua o recurso Medication referenciado.',
          );
        record(
          'prescription',
          id,
          pid,
          medication,
          [dosage, notes(r.note), narrative].filter(Boolean).join('\n'),
          r.authoredOn,
          null,
          r.status,
        );
      }
      if (type === 'AllergyIntolerance')
        record(
          'allergy',
          id,
          pid,
          concept(r.code) || 'Alergia sem descrição',
          [
            notes(r.note),
            ...arr(r.reaction).flatMap((v) =>
              arr(obj(v).manifestation).map(concept),
            ),
          ]
            .filter(Boolean)
            .join('\n'),
          r.onsetDateTime,
          r.recordedDate,
          concept(r.clinicalStatus),
        );
      if (created)
        warning(
          'FHIR meta.lastUpdated é atualização da origem; não foi usado como data do atendimento.',
        );
    }
  }
  if (
    !plan.patients.length ||
    plan.patients.length > 30 ||
    plan.records.length > 500
  )
    throw new Error(
      'Use arquivos com 1 a 30 pacientes e até 500 registros clínicos.',
    );
  warning(
    'Registros clínicos serão adicionados ao Histórico importado. Medicamentos, alergias e agenda atuais exigem revisão médica antes de atualização.',
  );
  return plan;
}
