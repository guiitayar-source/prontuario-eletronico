'use client';
import { apiFetch } from '@/lib/supabase/http';
import type { Patient } from '@/lib/patient-fields';
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  Smartphone,
  X,
  Link,
  FileText,
  Download,
  Trash2,
  Image as ImageIcon,
} from 'lucide-react';
import {
  api,
  ApiError,
  categoryNames,
  formatBytes,
  type Pairing,
  type Received,
  type CaptureRequest,
} from './client';

type Props = {
  patient: Patient;
  tab: string;
  setTab: (tab: string) => void;
  newDocument: () => void;
  canCreateDocument?: boolean;
};
export default function Attachments({
  tab,
  setTab,
  newDocument,
  canCreateDocument = true,
  patient,
}: Props) {
  const [files, setFiles] = useState<Received[]>([]),
    [pair, setPair] = useState<Pairing | null>(null);
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
      } catch (e) {
        if (active) setError((e as Error).message);
      }
      if (active) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
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
          setError((e as Error).message);
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
    if (!preview) return;
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
      setMessage('Anexo excluído.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(file: Received) {
    setBusy(true);
    try {
      const ticket = await apiFetch(
        `/api/capture?action=file&id=${file.id}&patientId=${patient.id}`,
        {
          cache: 'no-store',
        },
      );
      if (!ticket.ok) throw new Error('Não foi possível autorizar a abertura do arquivo.');
      const { url } = await ticket.json() as { url: string };
      const response = await fetch(url);
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== file.mime)
        throw new Error(
          'Não foi possível abrir o arquivo. Verifique o acesso e tente novamente.',
        );
      setPreview({ file, url: URL.createObjectURL(await response.blob()) });
    } catch (e) {
      setError((e as Error).message);
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
          <span className="file-category">{categoryNames[file.category]}</span>
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
        <button
          className="icon-btn"
          disabled={busy}
          aria-label={`Excluir ${file.name}`}
          onClick={() => setRemove(file)}
        >
          <Trash2 size={18} />
        </button>
      </article>
    );
  }
  return (
    <section
      className="attachments-area"
      hidden={tab !== 'exames' && tab !== 'documentos'}
    >
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
            <button className="secondary" onClick={newDocument}>
              <FileText size={16} /> Novo documento
            </button>
          )}
          <button className="primary" disabled={busy} onClick={connect}>
            <Smartphone size={17} />
            {pair && !expired ? 'Solicitar novo envio' : 'Anexar pelo celular'}
          </button>
        </div>
      </div>
      <div className="capture-notice">
        Demonstração: envie somente arquivos fictícios. Os anexos ficam
        armazenados no site privado até você excluí-los.
      </div>
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
      {(dialog || preview || remove) && (
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
            ) : remove ? (
              <>
                <h2 id="capture-title">Excluir este anexo?</h2>
                <p>{remove.name}</p>
                <p>
                  O arquivo será removido do armazenamento desta demonstração.
                </p>
                {error && <p role="alert">{error}</p>}
                <button
                  className="primary danger"
                  disabled={busy}
                  onClick={deleteFile}
                >
                  Excluir arquivo
                </button>
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
