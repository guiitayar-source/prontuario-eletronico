'use client';
import { apiFetch } from '@/lib/supabase/http';
import Exams from '@/components/exams';
import type { Patient } from '@/lib/patient-fields';
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useAccess } from '@/components/auth';
import {
  Smartphone,
  X,
  Link,
  FileText,
  Download,
  Upload,
  Trash2,
  Image as ImageIcon,
  ScanText,
} from 'lucide-react';
import {
  api,
  ApiError,
  categoryNames,
  compressImageFile,
  formatBytes,
  type Pairing,
  type Received,
  type CaptureRequest,
} from './client';

type Props = {
  patient: Patient;
  tab: string;
  setTab: (tab: string) => void;
  newDocument: (initialText?: string) => void;
  canCreateDocument?: boolean;
};
export default function Attachments({
  tab,
  setTab,
  newDocument,
  canCreateDocument = true,
  patient,
}: Props) {
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
  }, []);
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
  function row(file: Received) {
    return (
      <article className="received-file" key={file.id}>
        <div className="file-symbol">
          {file.mime === 'application/pdf' ? <FileText /> : <ImageIcon />}
        </div>
        <div className="file-detail">
          <button
            className="file-name"
            disabled={busy}
            onClick={() => open(file)}
          >
            {file.name}
          </button>
          <small>
            {new Date(file.created_at).toLocaleString('pt-BR')} ·{' '}
            {formatBytes(file.size)}
          </small>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
            <span className="file-category" style={{ margin: 0 }}>{categoryNames[file.category]}</span>
            {file.category === 'exam' && (
              <span
                style={{
                  fontSize: '11px',
                  padding: '1px 6px',
                  borderRadius: '4px',
                  background: file.has_exams ? '#e8f5e9' : '#fff3e0',
                  color: file.has_exams ? '#2e7d32' : '#b26a00',
                  fontWeight: 500,
                }}
              >
                {file.has_exams ? 'Exames preenchidos' : 'Sem exames preenchidos'}
              </span>
            )}
          </div>
        </div>
        <select
          aria-label={`Classificar ${file.name}`}
          disabled={busy}
          value={file.category}
          onChange={(e) => classify(file, e.target.value)}
        >
          <option value="pending" disabled>
            A conferir
          </option>
          <option value="exam">Exame</option>
          <option value="report">Relatório externo</option>
          <option value="other">Outro documento</option>
        </select>
        {tab === 'documentos' &&
          canCreateDocument &&
          ['report', 'other'].includes(file.category) && (
            <button
              type="button"
              className="secondary ai-file-action"
              disabled={busy}
              onClick={() => void transcribe(file)}
            >
              <ScanText size={16} /> Transcrever
            </button>
          )}
        {canCreateDocument && (
          <button
            className="icon-btn"
            disabled={busy}
            aria-label={`Arquivar ${file.name}`}
            onClick={() => setRemove(file)}
          >
            <Trash2 size={18} />
          </button>
        )}
      </article>
    );
  }
  return (
    <section
      className="attachments-area"
      hidden={tab !== 'exames' && tab !== 'documentos'}
    >
      {tab === 'exames' && canCreateDocument && (
        <Exams
          key={patient.id}
          patientId={patient.id}
          attachments={files.filter((f) => f.category === 'exam')}
          onUploadAttachment={uploadSingleExam}
        />
      )}
      <div className="attachments-heading">
        <div>
          <div className="eyebrow">
            {patient.name} · CADASTRO DE DEMONSTRAÇÃO
          </div>
          <h2>{tab === 'exames' ? 'Resultados recebidos' : 'Documentos'}</h2>
          <p>
            {tab === 'exames'
              ? 'Fotografe no celular. Confira e organize aqui.'
              : 'Relatórios externos e outros arquivos do atendimento.'}
          </p>
        </div>
        <div className="attachment-buttons">
          {tab === 'documentos' && canCreateDocument && (
            <button className="secondary" onClick={() => newDocument()}>
              <FileText size={16} /> Novo documento
            </button>
          )}
          <button className="primary" disabled={busy} onClick={connect}>
            <Smartphone size={17} />
            {pair && !expired ? 'Solicitar novo envio' : 'Anexar pelo celular'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => desktopFiles.current?.click()}
          >
            <Upload size={16} /> Anexar arquivo
          </button>
          <input
            ref={desktopFiles}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            hidden
            onChange={(event) => void uploadFromDesktop(event.target.files)}
          />
        </div>
      </div>
      <div className="capture-notice">
        Demonstração: envie somente arquivos fictícios. Os anexos ficam
        preservados no armazenamento privado. O arquivamento permite
        recuperá-los.
      </div>
      {canCreateDocument && (
        <div style={{ marginTop: '16px' }}>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => (archived ? setArchived(null) : loadArchived())}
          >
            {archived ? 'Fechar arquivados' : 'Ver anexos arquivados'}
          </button>
          {archived && (
            <section aria-label="Anexos arquivados" style={{ marginTop: '12px' }}>
              {!archived.length && <p>Nenhum anexo arquivado.</p>}
              {archived.map((file) => {
                const canPurge = isOwner || (isDoctor && Boolean(file.has_exams));
                return (
                  <div
                    key={file.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      background: '#faf9f5',
                      border: '1px solid #e8e6e1',
                      borderRadius: '6px',
                      marginBottom: '8px',
                      gap: '12px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <strong>{file.name}</strong>{' '}
                      <small style={{ color: '#7c8975' }}>
                        ({formatBytes(file.size)}) · {categoryNames[file.category]}
                      </small>
                      {file.category === 'exam' && (
                        <span
                          style={{
                            marginLeft: '8px',
                            fontSize: '11px',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            background: file.has_exams ? '#e8f5e9' : '#fff3e0',
                            color: file.has_exams ? '#2e7d32' : '#b26a00',
                          }}
                        >
                          {file.has_exams ? 'Exames preenchidos' : 'Sem exames preenchidos'}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => restore(file)}
                      >
                        Restaurar
                      </button>
                      {canPurge ? (
                        <button
                          className="secondary"
                          style={{ color: '#894832', borderColor: '#e0c4ba' }}
                          disabled={busy}
                          onClick={() => setPurgeConfirm(file)}
                          title="Excluir permanentemente do banco e armazenamento"
                        >
                          <Trash2 size={14} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                          Excluir definitivamente
                        </button>
                      ) : (
                        isDoctor && (
                          <span
                            style={{ fontSize: '11px', color: '#999' }}
                            title="Preencha os resultados do exame no sistema para liberar a exclusão definitiva ou solicite ao administrador"
                          >
                            Exclusão requer exames preenchidos
                          </span>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
        </div>
      )}
      {error && (
        <div className="capture-error" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label="Fechar aviso">
            <X size={15} />
          </button>
        </div>
      )}
      {message && (
        <p className="capture-message" role="status">
          {message}
        </p>
      )}
      {pair && (
        <div className="connection-strip">
          <Smartphone size={20} />
          <div>
            <strong>
              {expired
                ? 'Conexão expirada'
                : connected
                  ? 'Celular conectado'
                  : 'Aguardando celular'}
            </strong>
            <small>
              {expired
                ? 'Conecte novamente para enviar anexos.'
                : request?.state === 'complete'
                  ? 'Envio concluído. Solicite outro quando precisar.'
                  : requestExpired
                    ? 'Solicitação expirada. Inicie um novo envio.'
                    : `Destino: ${request?.patient_name || patient.name} · solicitação válida até ${request ? new Date(request.expires_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'}`}
            </small>
          </div>
          <button className="secondary" onClick={() => setDialog(true)}>
            Ver conexão
          </button>
          <button className="text-button" disabled={busy} onClick={disconnect}>
            Desconectar
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <section className="received-section">
          <h3>
            A conferir <span className="count">{pending.length}</span>
          </h3>
          <p>
            Recebidos do celular para {patient.name}. Abra e escolha onde
            guardar cada arquivo.
          </p>
          {pending.map(row)}
        </section>
      )}
      <section className="received-section">
        <div className="files-heading">
          <h3>
            {tab === 'exames' ? 'Exames anexados' : 'Arquivos anexados'}{' '}
            <span className="count">{accepted.length}</span>
          </h3>
          {tab === 'documentos' && (
            <select
              aria-label="Filtrar documentos"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">Todos</option>
              <option value="report">Relatórios externos</option>
              <option value="other">Outros documentos</option>
            </select>
          )}
        </div>
        {visible.length ? (
          visible.map(row)
        ) : (
          <div className="attachments-empty">
            <div className="empty-icon">
              {tab === 'exames' ? (
                <ImageIcon size={28} />
              ) : (
                <FileText size={28} />
              )}
            </div>
            <h3>
              {tab === 'exames'
                ? 'Os resultados ficam reunidos aqui'
                : 'Seus documentos em um só lugar'}
            </h3>
            <p>
              Conecte o celular para fotografar páginas ou enviar PDFs.
              <br />
              Você confere os arquivos antes de classificá-los.
            </p>
            <button className="secondary" disabled={busy} onClick={connect}>
              <Smartphone size={16} />{' '}
              {pair && !expired ? 'Solicitar envio' : 'Conectar celular'}
            </button>
          </div>
        )}
      </section>
      {tab === 'exames' && (
        <button className="text-button" onClick={() => setTab('documentos')}>
          Ver relatórios externos e outros documentos →
        </button>
      )}
      {(dialog || preview || remove || purgeConfirm) && (
        <div className="modal-backdrop">
          <section
            className={`modal ${preview ? 'file-preview-modal' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="capture-title"
            onKeyDown={modalKey}
          >
            <button
              ref={closeRef}
              className="close"
              aria-label="Fechar"
              onClick={() => {
                setDialog(false);
                setPreview(null);
                setRemove(null);
                setPurgeConfirm(null);
              }}
            >
              <X size={20} />
            </button>
            {preview ? (
              <>
                <h2 id="capture-title">{preview.file.name}</h2>
                {preview.file.mime === 'application/pdf' ? (
                  <iframe title="Prévia do PDF" src={preview.url} sandbox="" />
                ) : (
                  <img
                    className="received-preview"
                    alt={`Anexo ${preview.file.name}`}
                    src={preview.url}
                  />
                )}
                <a
                  className="secondary"
                  href={preview.url}
                  download={preview.file.name}
                >
                  <Download size={16} /> Baixar arquivo
                </a>
              </>
            ) : purgeConfirm ? (
              <>
                <h2 id="capture-title">Excluir anexo definitivamente?</h2>
                <p><strong>{purgeConfirm.name}</strong> ({formatBytes(purgeConfirm.size)})</p>
                <p>
                  O arquivo físico será removido permanentemente do armazenamento e do banco de dados para liberar espaço. Esta ação não poderá ser desfeita.
                </p>
                {error && <p role="alert" style={{ color: '#894832', margin: '8px 0' }}>{error}</p>}
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button
                    className="primary danger"
                    style={{ margin: 0, background: '#894832' }}
                    disabled={busy}
                    onClick={() => purgeFile(purgeConfirm)}
                  >
                    Confirmar exclusão definitiva
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setPurgeConfirm(null);
                      setError('');
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </>
            ) : remove ? (
              <>
                <h2 id="capture-title">Remover este anexo?</h2>
                <p><strong>{remove.name}</strong> ({formatBytes(remove.size)})</p>
                {remove.category === 'exam' && (
                  <p style={{ fontSize: '13px', color: remove.has_exams ? '#2e7d32' : '#b26a00', margin: '8px 0' }}>
                    {remove.has_exams
                      ? '✓ Os resultados deste exame já estão registrados no prontuário.'
                      : 'ℹ Esta foto ainda não possui resultados de exames preenchidos no prontuário.'}
                  </p>
                )}
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div style={{ border: '1px solid #dcdad5', borderRadius: '8px', padding: '12px' }}>
                    <strong style={{ display: 'block', marginBottom: '4px' }}>Arquivar anexo (recomendado)</strong>
                    <p style={{ margin: 0, fontSize: '13px', color: '#666' }}>
                      O arquivo sairá da lista ativa, mas será preservado com segurança e poderá ser restaurado a qualquer momento.
                    </p>
                    <button
                      className="secondary"
                      style={{ marginTop: '10px' }}
                      disabled={busy}
                      onClick={deleteFile}
                    >
                      Arquivar anexo
                    </button>
                  </div>
                  <div style={{ border: '1px solid #e0c4ba', borderRadius: '8px', padding: '12px', background: '#fdf9f8' }}>
                    <strong style={{ display: 'block', marginBottom: '4px', color: '#894832' }}>Excluir definitivamente (liberar espaço)</strong>
                    <p style={{ margin: 0, fontSize: '13px', color: '#666' }}>
                      {isOwner
                        ? 'Como administrador, você pode excluir permanentemente do banco e do armazenamento para economizar espaço.'
                        : remove.has_exams
                          ? 'Como os exames já estão preenchidos, você pode apagar a foto para economizar espaço no armazenamento.'
                          : 'A exclusão definitiva pelo médico só é permitida após os exames estarem preenchidos no prontuário (ou por um administrador).'}
                    </p>
                    {(isOwner || (isDoctor && remove.has_exams)) ? (
                      <button
                        className="primary danger"
                        style={{ marginTop: '10px', background: '#894832' }}
                        disabled={busy}
                        onClick={() => purgeFile(remove)}
                      >
                        Excluir definitivamente
                      </button>
                    ) : (
                      <button
                        className="secondary"
                        style={{ marginTop: '10px', opacity: 0.6 }}
                        disabled
                        title="Preencha os exames antes de excluir definitivamente"
                      >
                        Exclusão bloqueada (preencha o exame antes)
                      </button>
                    )}
                  </div>
                </div>
                {error && <p role="alert" style={{ color: '#894832', marginTop: '12px' }}>{error}</p>}
              </>
            ) : (
              <>
                <div className="modal-icon">
                  <Smartphone />
                </div>
                <h2 id="capture-title">Seu celular, conectado</h2>
                <p>
                  Leia o QR code com a câmera e entre com a mesma conta
                  autorizada do site. Mantenha a página aberta para os próximos
                  envios.
                </p>
                {qr && !expired && (
                  <img
                    className="pair-qr"
                    src={qr}
                    alt="QR code para conectar o celular"
                  />
                )}
                <div className="capture-destination">
                  <span>DESTINO DESTE ENVIO</span>
                  <strong>{request?.patient_name || patient.name}</strong>
                  <small>Paciente vinculado à solicitação</small>
                </div>
                <p className="pair-status">
                  {expired
                    ? 'Conexão expirada.'
                    : connected
                      ? 'Celular conectado. Pode fotografar.'
                      : 'Aguardando conexão do celular…'}
                </p>
                <small>
                  A conexão dura até 2 horas. Cada solicitação de envio dura 15
                  minutos.
                </small>
                <div className="pair-actions">
                  <button
                    className="secondary"
                    disabled={expired}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(link);
                        setMessage('Link de conexão copiado.');
                      } catch {
                        setMessage('Abra o link abaixo ou leia o QR code.');
                      }
                    }}
                  >
                    <Link size={15} /> Copiar link
                  </button>
                  <a href={link} target="_blank" rel="noreferrer">
                    Abrir tela do celular
                  </a>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={disconnect}
                  >
                    Desconectar
                  </button>
                </div>
                {message && <p role="status">{message}</p>}
                {error && <p role="alert">{error}</p>}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
