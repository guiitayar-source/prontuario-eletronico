import { apiFetch } from '@/lib/supabase/http';
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useAccess } from '@/components/auth';
import type { Patient } from '@/lib/patient-fields';
import {
  api,
  ApiError,
  compressImageFile,
  type Pairing,
  type Received,
  type CaptureRequest,
} from './client';

export type AttachmentsProps = {
  patient: Patient;
  tab: string;
  setTab: (tab: string) => void;
  newDocument: (initialText?: string) => void;
  newPrescription?: () => void;
  canCreateDocument?: boolean;
};

/** Estado e ações dos anexos: lista, upload, pareamento com o celular, classificação e arquivamento. */
export function useAttachments(props: AttachmentsProps) {
  const { tab, newDocument, patient } = props;
  const { role } = useAccess();
  const isOwner = role === 'owner';
  const isDoctor = role === 'doctor';
  const [files, setFiles] = useState<Received[]>([]),
    [pair, setPair] = useState<Pairing | null>(null);
  const [archived, setArchived] = useState<Received[] | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState<Received | null>(null);
  async function loadArchived() {
    try {
      const r = await api(
        `archived&patientId=${encodeURIComponent(patient.id)}`,
      );
      setArchived(r.attachments);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function restore(file: Received) {
    setBusy(true);
    try {
      await api('restore', { id: file.id, patientId: patient.id });
      await refresh();
      await loadArchived();
      setMessage('Anexo restaurado.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const [request, setRequest] = useState<CaptureRequest | null>(null),
    [connected, setConnected] = useState(false);
  const [dialog, setDialog] = useState(false),
    [qr, setQr] = useState(''),
    [link, setLink] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [filter, setFilter] = useState('all'),
    [preview, setPreview] = useState<{ file: Received; url: string } | null>(
      null,
    );
  const [remove, setRemove] = useState<Received | null>(null),
    [now, setNow] = useState(Date.now());
  const closeRef = useRef<HTMLButtonElement>(null);
  const desktopFiles = useRef<HTMLInputElement>(null);
  const kind = tab === 'exames' ? 'exam' : 'other';
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem('capture-desktop');
      if (stored) {
        const p = JSON.parse(stored);
        if (p.id && p.token && p.expires_at > Date.now()) setPair(p);
      }
    } catch {
      /* Pairing can be recreated. */
    }
  }, []);
  const refresh = useCallback(async () => {
    const result = await api(`list&patientId=${patient.id}`);
    setFiles(result.attachments);
  }, [patient.id]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api(`list&patientId=${patient.id}`);
        if (active) setFiles(result.attachments);
      } catch {
        /* Transient background poll glitches should not disrupt the user interface */
      }
      if (active) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [patient.id]);
  useEffect(() => {
    if (!pair) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api(`pair&id=${pair!.id}`);
        if (active) {
          setRequest(data.request);
          setConnected(data.connected);
        }
      } catch (e) {
        if (active) {
          setConnected(false);
          if (e instanceof ApiError && e.status === 410) {
            setPair(null);
            setRequest(null);
            try {
              sessionStorage.removeItem('capture-desktop');
            } catch {}
          }
        }
      }
      if (active) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pair]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!pair) {
      setQr('');
      setLink('');
      return;
    }
    const url = `${window.location.origin}/celular#${pair.id}.${pair.token}`;
    setLink(url);
    let active = true;
    QRCode.toDataURL(url, { width: 260, margin: 2, errorCorrectionLevel: 'M' })
      .then((img) => {
        if (active) setQr(img);
      })
      .catch(() =>
        setError('Não foi possível desenhar o QR code. Use o link de conexão.'),
      );
    return () => {
      active = false;
    };
  }, [pair]);
  useEffect(() => {
    if (!preview || !preview.url.startsWith('blob:')) return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);
  useEffect(() => {
    if (dialog || preview || remove) closeRef.current?.focus();
  }, [dialog, preview, remove]);
  async function connect() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (pair && pair.expires_at > Date.now()) {
        const state = await api(`pair&id=${pair.id}`);
        if (
          state.request?.state === 'pending' &&
          state.request.expires_at > Date.now()
        ) {
          setRequest(state.request);
          if (state.request.patient_id !== patient.id)
            setError(
              `Há um envio em andamento para ${state.request.patient_name}. Conclua-o no celular ou desconecte antes de iniciar outro.`,
            );
        } else {
          const result = await api('request', {
            id: pair.id,
            category: kind,
            patientId: patient.id,
          });
          setRequest(result.request);
        }
      } else {
        const result = await api('connect', {
          category: kind,
          patientId: patient.id,
        });
        setPair(result);
        setRequest(result.request);
        try {
          sessionStorage.setItem('capture-desktop', JSON.stringify(result));
        } catch {
          /* Connection still works for this page. */
        }
      }
      setDialog(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    if (!pair) return;
    setBusy(true);
    try {
      await api('disconnect', { id: pair.id });
      setPair(null);
      setRequest(null);
      setConnected(false);
      sessionStorage.removeItem('capture-desktop');
      setDialog(false);
      setMessage('Celular desconectado.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function uploadFromDesktop(list: FileList | null) {
    const rawSelected = Array.from(list || []);
    if (!rawSelected.length) return;
    const selected = await Promise.all(
      rawSelected.map((f) => compressImageFile(f)),
    );
    const allowed = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);
    if (
      selected.length > 10 ||
      selected.some((file) => file.size < 1 || file.size > 12 * 1024 * 1024) ||
      selected.some((file) => !allowed.has(file.type))
    ) {
      setError('Use até 10 arquivos JPG, PNG, WebP ou PDF de até 12 MB.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let activePair = pair;
      let activeRequest = request;
      if (!activePair || activePair.expires_at <= Date.now()) {
        const result = await api('connect', {
          category: kind,
          patientId: patient.id,
        });
        activePair = result;
        activeRequest = result.request;
        setPair(result);
        setRequest(result.request);
        try {
          sessionStorage.setItem('capture-desktop', JSON.stringify(result));
        } catch {
          /* The current upload may continue without browser persistence. */
        }
      } else if (
        !activeRequest ||
        activeRequest.state !== 'pending' ||
        activeRequest.expires_at <= Date.now() ||
        activeRequest.patient_id !== patient.id ||
        activeRequest.category !== kind
      ) {
        const result = await api('request', {
          id: activePair.id,
          category: kind,
          patientId: patient.id,
        });
        activeRequest = result.request;
        setRequest(result.request);
      }
      if (!activePair || !activeRequest)
        throw new Error('Não foi possível preparar o envio do arquivo.');
      for (const file of selected) {
        const uploadId = crypto.randomUUID();
        const form = new FormData();
        form.set('requestId', activeRequest.id);
        form.set('uploadId', uploadId);
        form.set('file', file);
        await api('upload', form, activePair.token);
        if (kind === 'exam' || kind === 'other') {
          await api('classify', {
            id: uploadId,
            category: kind,
            patientId: patient.id,
          });
        }
      }
      await refresh();
      setMessage(
        kind === 'exam'
          ? `${selected.length} exame${selected.length === 1 ? '' : 's'} anexado${selected.length === 1 ? '' : 's'} com sucesso.`
          : `${selected.length} arquivo${selected.length === 1 ? '' : 's'} recebido${selected.length === 1 ? '' : 's'}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (desktopFiles.current) desktopFiles.current.value = '';
    }
  }
  async function uploadSingleExam(rawFile: File): Promise<string> {
    const file = await compressImageFile(rawFile);
    const allowed = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);
    if (
      file.size < 1 ||
      file.size > 12 * 1024 * 1024 ||
      !allowed.has(file.type)
    ) {
      throw new Error('Use um arquivo JPG, PNG, WebP ou PDF de até 12 MB.');
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let activePair = pair;
      let activeRequest = request;
      if (!activePair || activePair.expires_at <= Date.now()) {
        const result = await api('connect', {
          category: 'exam',
          patientId: patient.id,
        });
        activePair = result;
        activeRequest = result.request;
        setPair(result);
        setRequest(result.request);
        try {
          sessionStorage.setItem('capture-desktop', JSON.stringify(result));
        } catch {
          /* The current upload may continue without browser persistence. */
        }
      } else if (
        !activeRequest ||
        activeRequest.state !== 'pending' ||
        activeRequest.expires_at <= Date.now() ||
        activeRequest.patient_id !== patient.id ||
        activeRequest.category !== 'exam'
      ) {
        const result = await api('request', {
          id: activePair.id,
          category: 'exam',
          patientId: patient.id,
        });
        activeRequest = result.request;
        setRequest(result.request);
      }
      if (!activePair || !activeRequest)
        throw new Error('Não foi possível preparar o envio do arquivo.');

      const uploadId = crypto.randomUUID();
      const form = new FormData();
      form.set('requestId', activeRequest.id);
      form.set('uploadId', uploadId);
      form.set('file', file);
      await api('upload', form, activePair.token);
      await api('classify', {
        id: uploadId,
        category: 'exam',
        patientId: patient.id,
      });
      await refresh();
      setMessage('Laudo anexado com sucesso e pronto para leitura com IA.');
      return uploadId;
    } finally {
      setBusy(false);
    }
  }
  async function classify(file: Received, category: string) {
    setBusy(true);
    try {
      await api('classify', { id: file.id, category, patientId: patient.id });
      await refresh();
      setMessage('Anexo classificado.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteFile() {
    if (!remove) return;
    setBusy(true);
    try {
      await api('delete', { id: remove.id, patientId: patient.id });
      setRemove(null);
      await refresh();
      if (archived) await loadArchived();
      setMessage(
        'Anexo arquivado. O arquivo foi preservado e pode ser restaurado.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function purgeFile(file: Received) {
    setBusy(true);
    setError('');
    try {
      await api('purge', { id: file.id, patientId: patient.id });
      setRemove(null);
      setPurgeConfirm(null);
      await refresh();
      if (archived) await loadArchived();
      setMessage(
        'Anexo excluído definitivamente. Espaço liberado no banco e armazenamento.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(file: Received) {
    setBusy(true);
    setError('');
    try {
      const ticket = await apiFetch(
        `/api/capture?action=file&id=${file.id}&patientId=${patient.id}`,
        {
          cache: 'no-store',
        },
      );
      if (!ticket.ok)
        throw new Error('Não foi possível autorizar a abertura do arquivo.');
      const { url: remoteUrl } = (await ticket.json()) as { url?: string };
      if (!remoteUrl) throw new Error('Endereço do anexo indisponível.');
      let displayUrl = remoteUrl;
      try {
        const response = await fetch(remoteUrl, { cache: 'no-store' });
        if (response.ok) {
          displayUrl = URL.createObjectURL(await response.blob());
        }
      } catch {
        displayUrl = remoteUrl;
      }
      setPreview({ file, url: displayUrl });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function transcribe(file: Received) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await apiFetch(
        `/api/ai-files?patientId=${encodeURIComponent(patient.id)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AI-Action': '1',
          },
          body: JSON.stringify({
            action: 'transcribe-document',
            attachmentId: file.id,
          }),
        },
      );
      const data = (await response.json()) as {
        proposal?: { transcription: string; warnings: string[] };
        error?: string;
      };
      if (!response.ok || !data.proposal)
        throw new Error(
          data.error || 'Não foi possível transcrever o documento.',
        );
      newDocument(data.proposal.transcription);
      setMessage(
        data.proposal.warnings.length
          ? `Transcrição aberta como rascunho. Revise também: ${data.proposal.warnings.join(' · ')}`
          : 'Transcrição aberta como rascunho para revisão. Nada foi salvo ainda.',
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pending = files.filter((f) => f.category === 'pending');
  const accepted = files.filter((f) =>
    tab === 'exames'
      ? f.category === 'exam'
      : f.category === 'report' || f.category === 'other',
  );
  const visible = accepted.filter(
    (f) => filter === 'all' || f.category === filter,
  );
  const expired = Boolean(pair && pair.expires_at <= now),
    requestExpired = Boolean(request && request.expires_at <= now);
  const modalKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      setDialog(false);
      setPreview(null);
      setRemove(null);
      setPurgeConfirm(null);
    }
    if (e.key === 'Tab') {
      const elements = e.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],select,input',
      );
      const first = elements[0],
        last = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  return {
    requestExpired,
    isOwner,
    isDoctor,
    files,
    pair,
    archived,
    setArchived,
    purgeConfirm,
    setPurgeConfirm,
    loadArchived,
    restore,
    request,
    connected,
    dialog,
    setDialog,
    qr,
    link,
    error,
    setError,
    busy,
    message,
    setMessage,
    filter,
    setFilter,
    preview,
    setPreview,
    remove,
    setRemove,
    closeRef,
    desktopFiles,
    connect,
    disconnect,
    uploadFromDesktop,
    uploadSingleExam,
    classify,
    deleteFile,
    purgeFile,
    open,
    transcribe,
    pending,
    accepted,
    visible,
    expired,
    modalKey,
  };
}
