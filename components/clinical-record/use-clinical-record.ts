import { useEffect, useRef, useState } from 'react';
import { useAccess } from '../auth';
import { useClinicalContext } from '../clinical-context';
import { useDocuments } from '../documents';
import { documentTemplate } from '@/lib/document-fields';
import { apiFetch } from '@/lib/supabase/http';
import { type Patient } from '@/lib/patient-fields';
import { useSearchGuard } from '../topbar';
import type { SignatureSessionData } from '@/lib/signature/types';
import { useConsultationTimer } from './use-consultation-timer';
import { type RecordEntry } from './types';

async function request(patientId: string, action?: string, data?: unknown) {
  const r = await apiFetch(
    '/api/consultations?' +
      (action
        ? 'action=' + action
        : 'patientId=' + encodeURIComponent(patientId)),
    action
      ? {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Consultation-Action': '1',
          },
          body: JSON.stringify(data),
        }
      : undefined,
  );
  const result = (await r.json()) as {
    error?: string;
    consultations: RecordEntry[];
    consultation: RecordEntry;
  };
  if (!r.ok) throw new Error(result.error);
  return result;
}

export function useClinicalRecord({
  patient,
  appointmentId,
}: {
  patient: Patient;
  appointmentId?: string;
}) {
  const medical = ['owner', 'doctor'].includes(useAccess().role);
  const docs = useDocuments(patient, medical);
  const clinicalContext = useClinicalContext(patient.id, medical);
  const [tab, setTab] = useState(() => {
      if (typeof window !== 'undefined') {
        const savedTab = sessionStorage.getItem('birdid_return_tab');
        if (savedTab) {
          sessionStorage.removeItem('birdid_return_tab');
          return savedTab;
        }
      }
      return medical ? 'consulta' : 'cadastro';
    }),
    [rows, setRows] = useState<RecordEntry[]>([]),
    [current, setCurrent] = useState<RecordEntry | null>(null),
    [text, setText] = useState(''),
    [status, setStatus] = useState('Carregando…'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [finalizing, setFinalizing] = useState(false),
    [panel, setPanel] = useState(true),
    [addendum, setAddendum] = useState(''),
    [dirtyRegistration, setDirtyRegistration] = useState(false),
    [signatureSession, setSignatureSession] =
      useState<SignatureSessionData | null>(null),
    [signing, setSigning] = useState(false);
  const saved = useRef(''),
    latest = useRef(''),
    flight = useRef(false),
    blocked = useRef(false),
    createId = useRef(crypto.randomUUID()),
    adId = useRef(crypto.randomUUID());
  const dirty = text !== saved.current;
  const hasUnsaved = dirty || !!addendum.trim() || docs.dirty;
  function choose(r: RecordEntry) {
    saved.current = r.text;
    latest.current = r.text;
    setText(r.text);
    setCurrent(r);
    blocked.current = false;
    setError('');
    setStatus(
      r.status === 'SIGNED' || r.signed_at
        ? 'Assinada digitalmente'
        : r.finalized_at
          ? 'Finalizada sem assinatura'
          : 'Salvo',
    );
    setAddendum('');
  }
  async function load() {
    const result = await request(patient.id);
    setRows(result.consultations);
    return result.consultations as RecordEntry[];
  }
  async function checkSignatureSession() {
    try {
      const r = await apiFetch('/api/digital-signature/session');
      if (r.ok) {
        const data = (await r.json()) as {
          active: boolean;
          session: SignatureSessionData | null;
        };
        setSignatureSession(data.active ? data.session : null);
      }
    } catch {
      // Ignore background check failure
    }
  }
  useEffect(() => {
    if (medical) {
      void checkSignatureSession();
    }
  }, [medical]);
  useEffect(() => {
    let active = true;
    if (medical)
      request(patient.id)
        .then((result) => {
          if (active) {
            setRows(result.consultations);
            setStatus('Escolha uma consulta ou inicie uma nova.');
            const returnEvoId =
              typeof window !== 'undefined'
                ? sessionStorage.getItem('birdid_return_evolution_id')
                : null;
            if (returnEvoId) {
              sessionStorage.removeItem('birdid_return_evolution_id');
            }
            const match = result.consultations.find(
              (r: RecordEntry & { appointment_id?: string }) =>
                returnEvoId
                  ? r.id === returnEvoId
                  : appointmentId
                    ? r.appointment_id === appointmentId
                    : !r.finalized_at && r.status !== 'SIGNED',
            );
            if (match) choose(match);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [patient.id, medical, appointmentId]);
  async function persist(finalize = false): Promise<boolean> {
    if (
      !current ||
      flight.current ||
      blocked.current ||
      current.finalized_at ||
      current.status === 'SIGNED' ||
      current.signed_at
    )
      return false;
    flight.current = true;
    setFinalizing(finalize);
    setBusy(true);
    setStatus('Salvando…');
    const snapshot = latest.current;
    try {
      const result = await request(patient.id, finalize ? 'finalize' : 'save', {
        id: current.id,
        version: current.version,
        text: snapshot,
      });
      saved.current = snapshot;
      setCurrent(result.consultation);
      setRows((old) =>
        old.map((r) =>
          r.id === current.id ? { ...r, ...result.consultation } : r,
        ),
      );
      setStatus(latest.current === snapshot ? 'Salvo' : 'Alterações pendentes');
      setError('');
      return true;
    } catch (e) {
      blocked.current = true;
      setError((e as Error).message);
      setStatus('Não salvo — seu texto permanece nesta tela');
      return false;
    } finally {
      flight.current = false;
      setFinalizing(false);
      setBusy(false);
    }
  }
  async function prepareEvolutionForSignature() {
    if (!current) return false;
    if (!current.finalized_at && latest.current !== saved.current) {
      if (!(await persist(false))) return false;
    }
    if (latest.current !== saved.current) {
      setError('Há alterações não salvas. Salve a evolução antes de assinar.');
      setStatus('Alterações pendentes');
      return false;
    }
    return true;
  }
  async function handleSignEvolution() {
    if (!current || busy || signing) return;
    setSigning(true);
    try {
      if (!(await prepareEvolutionForSignature())) return;
      setError('');
      setStatus('Assinando evolução com certificado Bird ID…');
      const r = await apiFetch('/api/digital-signature/sign-evolution', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Action': '1',
        },
        body: JSON.stringify({ evolutionId: current.id }),
      });
      const data = (await r.json()) as {
        error?: string;
        success?: boolean;
      };
      if (!r.ok) {
        throw new Error(
          data.error || 'Falha ao assinar evolução digitalmente.',
        );
      }
      const list = await load();
      const updated = list.find((item) => item.id === current.id);
      if (updated) choose(updated);
      setStatus('Evolução assinada digitalmente com sucesso!');
    } catch (e) {
      setError((e as Error).message);
      setStatus('Erro na assinatura digital');
    } finally {
      setSigning(false);
    }
  }
  async function handleConnectAndSign() {
    if (!current || busy || signing) return;
    setSigning(true);
    try {
      if (!(await prepareEvolutionForSignature())) return;
      setError('');
      if (typeof window !== 'undefined' && patient?.id) {
        sessionStorage.setItem('birdid_return_patient_id', patient.id);
        sessionStorage.setItem('birdid_return_tab', 'consulta');
        sessionStorage.setItem('birdid_return_evolution_id', current.id);
      }
      const r = await apiFetch('/api/digital-signature/birdid/authorize');
      const data = (await r.json()) as {
        authorizationUrl?: string;
        error?: string;
      };
      if (!r.ok)
        throw new Error(data.error || 'Falha ao iniciar autorização Bird ID');
      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSigning(false);
    }
  }
  useEffect(() => {
    if (
      !dirty ||
      busy ||
      signing ||
      !current ||
      current.finalized_at ||
      current.status === 'SIGNED' ||
      current.signed_at ||
      blocked.current
    )
      return;
    const timer = setTimeout(() => void persist(), 800);
    return () => clearTimeout(timer);
    // Salvamento automático: dirty deriva de text; persist lê o estado mais recente por refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, current, busy, signing]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsaved || busy || dirtyRegistration) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsaved, busy, dirtyRegistration]);
  function leave(action: () => void) {
    if (busy || docs.busy) return;
    if (
      (hasUnsaved || dirtyRegistration) &&
      !window.confirm('Há alterações não salvas. Sair e descartá-las?')
    )
      return;
    action();
  }
  async function create() {
    setBusy(true);
    try {
      const r = await request(patient.id, 'create', {
        id: createId.current,
        patient_id: patient.id,
        appointment_id: appointmentId,
      });
      choose(r.consultation);
      createId.current = crypto.randomUUID();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function append() {
    if (!current) return;
    setBusy(true);
    try {
      await request(patient.id, 'addendum', {
        id: current.id,
        addendum_id: adId.current,
        text: addendum,
      });
      adId.current = crypto.randomUUID();
      const list = await load();
      choose(list.find((r) => r.id === current.id)!);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const [hasImported, setHasImported] = useState(false);
  useEffect(() => {
    if (!medical) return;
    let active = true;
    void apiFetch(
      `/api/imports?patientId=${encodeURIComponent(patient.id)}&count=1`,
    )
      .then(async (r) => {
        const d = (await r.json()) as { total?: number };
        if (active && r.ok) setHasImported((d.total || 0) > 0);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [patient.id, medical]);
  const [modal, setModal] = useState('');
  function openPrescription() {
    docs.open(
      undefined,
      current?.id,
      false,
      documentTemplate('Receita'),
      'Receita',
    );
    setModal('receita');
  }
  // Na volta da autenticação Bird ID, reabre o documento que estava sendo assinado.
  useEffect(() => {
    const id = sessionStorage.getItem('birdid_return_document_id');
    const d = id && docs.rows.find((row) => row.id === id);
    if (!d) return;
    sessionStorage.removeItem('birdid_return_document_id');
    docs.open(d);
    setModal(d.kind === 'Receita' ? 'receita' : 'documento');
    // docs.open não é estável entre renderizações; só interessa a chegada da lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.rows]);
  function closeModal() {
    if ((modal === 'documento' || modal === 'receita') && !docs.close()) return;
    setModal('');
  }
  const displayName = patient.social_name || patient.name;
  const isSigned =
    current?.status === 'SIGNED' ||
    !!current?.signed_at ||
    !!current?.current_signature_id;
  const isFinalizedUnsigned = !!current?.finalized_at && !isSigned;
  const finalized = !!current?.finalized_at || isSigned;
  const ready = !!current;
  const visitDate = new Date(
    current?.created_at || Date.now(),
  ).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const timer = useConsultationTimer({
    consultationId: current?.id,
    isFinalized: finalized,
    createdAt: current?.created_at,
    finalizedAt: current?.finalized_at,
  });
  const save = status;
  async function finish() {
    await persist(true);
    closeModal();
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // closeModal só lê modal e docs, já listados.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, docs.dirty, docs.busy]);
  useEffect(() => {
    if (!modal) return;
    const oldOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    return () => {
      window.document.body.style.overflow = oldOverflow;
    };
  }, [modal]);
  useSearchGuard({
    beforeSelect: (open) => leave(open),
    beforeSearch: () => {
      if (!modal) return true;
      if ((modal === 'documento' || modal === 'receita') && !docs.close())
        return false;
      setModal('');
      return true;
    },
  });
  return {
    medical,
    docs,
    clinicalContext,
    tab,
    setTab,
    rows,
    current,
    text,
    setText,
    setStatus,
    error,
    setError,
    busy,
    finalizing,
    panel,
    setPanel,
    addendum,
    setAddendum,
    setDirtyRegistration,
    signatureSession,
    signing,
    latest,
    blocked,
    dirty,
    choose,
    load,
    persist,
    handleSignEvolution,
    handleConnectAndSign,
    leave,
    create,
    append,
    hasImported,
    modal,
    setModal,
    openPrescription,
    closeModal,
    displayName,
    isSigned,
    isFinalizedUnsigned,
    finalized,
    ready,
    visitDate,
    timer,
    save,
    finish,
  };
}
