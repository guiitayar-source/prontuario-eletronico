'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  Upload,
  FileText,
  ArrowUp,
  ArrowDown,
  Trash2,
  Smartphone,
  Check,
  RefreshCw,
} from 'lucide-react';
import {
  api,
  compressImageFile,
  formatBytes,
  type CaptureRequest,
  type Pairing,
} from '@/components/capture/client';
type Page = { id: string; file: File; url: string; sent: boolean };
export default function MobileCapture() {
  const [pair, setPair] = useState<Pairing | null>(null),
    [request, setRequest] = useState<CaptureRequest | null>(null);
  const [locked, setLocked] = useState<CaptureRequest | null>(null),
    [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [sending, setSending] = useState(false);
  const [confirmed, setConfirmed] = useState(false),
    [now, setNow] = useState(Date.now()),
    [loaded, setLoaded] = useState(false);
  const camera = useRef<HTMLInputElement>(null),
    files = useRef<HTMLInputElement>(null),
    urls = useRef(new Set<string>());
  const [retry, setRetry] = useState(0),
    [verified, setVerified] = useState(false);
  useEffect(() => {
    try {
      const raw = window.location.hash.slice(1);
      if (raw) {
        const [id, token] = raw.split('.');
        if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(token || ''))
          throw new Error(
            'Link de conexão inválido. Leia o QR code novamente.',
          );
        const p = { id, token, expires_at: 0 };
        sessionStorage.setItem('capture-mobile', JSON.stringify(p));
        setPair(p);
        history.replaceState(null, '', window.location.pathname);
      } else {
        const stored = sessionStorage.getItem('capture-mobile');
        if (stored) setPair(JSON.parse(stored));
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setLoaded(true);
    return () => {
      urls.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);
  useEffect(() => {
    if (!pair) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api(`mobile&id=${pair!.id}`, undefined, pair!.token);
        if (active) {
          setVerified(true);
          setRequest(data.request);
          setPair((prev) =>
            prev ? { ...prev, expires_at: data.expires_at } : prev,
          );
        }
      } catch (e) {
        if (active) {
          setVerified(false);
          setError((e as Error).message);
        }
      }
      if (active) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pair?.id, pair?.token, retry]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const current = locked || request;
  const stale = Boolean(locked && request && locked.id !== request.id);
  const expired =
    Boolean(pair?.expires_at && pair.expires_at <= now) ||
    Boolean(current && current.expires_at <= now);
  const available = Boolean(
    current && current.state === 'pending' && !expired && !stale && verified,
  );
  async function select(list: FileList | null) {
    if (!list || !request) return;
    setError('');
    setMessage('');
    const rawSelected = Array.from(list);
    if (pages.length + rawSelected.length > 10) {
      setError('Envie até 10 arquivos por solicitação.');
      return;
    }
    const selected = await Promise.all(
      rawSelected.map((file) => compressImageFile(file)),
    );
    if (selected.some((f) => f.size > 12 * 1024 * 1024 || !f.size)) {
      setError('Cada arquivo precisa ter entre 1 byte e 12 MB.');
      return;
    }
    if (
      selected.some(
        (f) =>
          ![
            'image/jpeg',
            'image/png',
            'image/webp',
            'application/pdf',
          ].includes(f.type),
      )
    ) {
      setError(
        'Use fotos JPG, PNG, WebP ou arquivos PDF. Converta fotos HEIC antes de enviar.',
      );
      return;
    }
    setLocked(locked || request);
    setPages((prev) => [
      ...prev,
      ...selected.map((file) => {
        const url = URL.createObjectURL(file);
        urls.current.add(url);
        return { id: crypto.randomUUID(), file, url, sent: false };
      }),
    ]);
  }
  function drop(id: string) {
    setPages((prev) =>
      prev.filter((p) => {
        if (p.id !== id) return true;
        URL.revokeObjectURL(p.url);
        urls.current.delete(p.url);
        return false;
      }),
    );
  }
  function reorder(i: number, step: number) {
    setPages((prev) => {
      const next = [...prev];
      [next[i], next[i + step]] = [next[i + step], next[i]];
      return next;
    });
  }
  function clear() {
    pages.forEach((p) => {
      URL.revokeObjectURL(p.url);
      urls.current.delete(p.url);
    });
    setPages([]);
    setLocked(null);
    setConfirmed(false);
    setMessage('');
    setError('');
  }
  async function send() {
    if (!pair || !current || !confirmed || sending) return;
    setSending(true);
    setError('');
    const requestId = current.id;
    try {
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        if (page.sent) continue;
        setMessage(`Enviando página ${i + 1} de ${pages.length}…`);
        const body = new FormData();
        body.set('requestId', requestId);
        body.set('uploadId', page.id);
        body.set('file', page.file);
        await api('upload', body, pair.token);
        setPages((prev) =>
          prev.map((p) => (p.id === page.id ? { ...p, sent: true } : p)),
        );
      }
      await api('complete', { id: requestId }, pair.token);
      clear();
      setRequest((prev) =>
        prev?.id === requestId ? { ...prev, state: 'complete' } : prev,
      );
      setMessage(
        'Envio concluído. Os arquivos já estão disponíveis no computador.',
      );
    } catch (e) {
      setError((e as Error).message);
      setMessage(
        'As páginas marcadas como recebidas já estão no computador. Tente novamente para enviar apenas as restantes.',
      );
    } finally {
      setSending(false);
    }
  }
  async function disconnect() {
    if (!pair) return;
    try {
      await api('disconnect', { id: pair.id });
      clear();
      sessionStorage.removeItem('capture-mobile');
      setPair(null);
      setRequest(null);
      setMessage('Celular desconectado.');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="mobile-capture">
      <header>
        <Activity size={23} />
        <span>meu prontuário</span>
        <span className="mobile-pill">Câmera</span>
      </header>
      <main>
        <div className="eyebrow">ANEXAR PELO CELULAR</div>
        <h1>Do papel para o prontuário.</h1>
        <p className="mobile-lead">
          Fotografe, confira e envie para o computador.
        </p>
        <div className="capture-notice">
          Use somente documentos fictícios nesta demonstração.
        </div>
        {error && (
          <div className="capture-error" role="alert">
            {error}
            <button
              aria-label="Tentar reconectar"
              onClick={() => {
                setError('');
                setRetry((n) => n + 1);
              }}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        )}
        {message && (
          <p className="capture-message" role="status">
            {message}
          </p>
        )}
        {!pair ? (
          <div className="mobile-wait">
            <Smartphone size={36} />
            <h2>{loaded ? 'Conecte pelo computador' : 'Carregando…'}</h2>
            <p>
              Na página da paciente, abra Exames ou Documentos e clique em
              “Anexar pelo celular”. Leia o QR code com a câmera.
            </p>
          </div>
        ) : (
          <>
            <div className="capture-destination">
              <span>
                DESTINO{' '}
                {locked ? 'FIXADO PARA ESTAS PÁGINAS' : 'DA SOLICITAÇÃO'}
              </span>
              <strong>
                {current?.patient_name || 'Aguardando solicitação…'}
              </strong>
              <small>Paciente vinculado à solicitação</small>
            </div>
            {stale && (
              <div className="capture-error">
                O computador abriu uma nova solicitação. Estas páginas continuam
                vinculadas à anterior e não serão enviadas para outro destino.
              </div>
            )}
            {expired && (
              <div className="capture-error">
                A conexão ou solicitação expirou. Inicie um novo envio no
                computador.
              </div>
            )}
            {available ? (
              <>
                <div className="mobile-capture-actions">
                  <button
                    className="camera-button"
                    disabled={sending || pages.some((p) => p.sent)}
                    onClick={() => camera.current?.click()}
                  >
                    <Camera size={28} />
                    <strong>Tirar foto</strong>
                    <span>Adicione uma página por vez</span>
                  </button>
                  <button
                    className="secondary"
                    disabled={sending || pages.some((p) => p.sent)}
                    onClick={() => files.current?.click()}
                  >
                    <Upload size={18} /> Galeria ou PDF
                  </button>
                  <input
                    ref={camera}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    hidden
                    onChange={(e) => {
                      select(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <input
                    ref={files}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    multiple
                    hidden
                    onChange={(e) => {
                      select(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </div>
                <small className="upload-limits">
                  Até 10 arquivos · 12 MB por arquivo · JPG, PNG, WebP e PDF
                </small>
              </>
            ) : (
              !stale &&
              !expired &&
              verified && (
                <div className="mobile-wait">
                  <Check size={32} />
                  <h2>Pronto para o próximo envio</h2>
                  <p>
                    Deixe esta página aberta. No computador, clique em
                    “Solicitar novo envio” quando precisar.
                  </p>
                </div>
              )
            )}
            {pages.length > 0 && (
              <section className="mobile-pages">
                <h2>
                  Conferir páginas <span className="count">{pages.length}</span>
                </h2>
                <p>
                  Verifique se todo o texto está legível e na ordem correta.
                </p>
                {pages.map((p, i) => (
                  <article className="capture-page" key={p.id}>
                    {p.file.type === 'application/pdf' ? (
                      <div className="pdf-placeholder">
                        <FileText size={34} />
                        <a href={p.url} target="_blank" rel="noreferrer">
                          Conferir PDF
                        </a>
                      </div>
                    ) : (
                      <a href={p.url} target="_blank" rel="noreferrer">
                        <img
                          src={p.url}
                          alt={`Página ${i + 1} — conferir legibilidade`}
                        />
                      </a>
                    )}
                    <div className="capture-page-info">
                      <strong>
                        {i + 1}. {p.file.name}
                      </strong>
                      <small>
                        {formatBytes(p.file.size)}{' '}
                        {p.sent ? '· Recebido no computador' : ''}
                      </small>
                      <div>
                        <button
                          aria-label={`Subir página ${i + 1}`}
                          disabled={
                            sending || pages.some((x) => x.sent) || i === 0
                          }
                          onClick={() => reorder(i, -1)}
                        >
                          <ArrowUp size={17} />
                        </button>
                        <button
                          aria-label={`Descer página ${i + 1}`}
                          disabled={
                            sending ||
                            pages.some((x) => x.sent) ||
                            i === pages.length - 1
                          }
                          onClick={() => reorder(i, 1)}
                        >
                          <ArrowDown size={17} />
                        </button>
                        <button
                          aria-label={`Remover página ${i + 1}`}
                          disabled={sending || p.sent}
                          onClick={() => drop(p.id)}
                        >
                          <Trash2 size={17} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
                <label className="confirm-patient">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={sending}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />{' '}
                  Confirmo que estes arquivos fictícios pertencem a{' '}
                  {current?.patient_name}.
                </label>
                <button
                  className="primary send-pages"
                  disabled={sending || !confirmed || !available}
                  onClick={send}
                >
                  <Upload size={18} />
                  {sending
                    ? 'Enviando…'
                    : pages.every((p) => p.sent)
                      ? 'Confirmar conclusão'
                      : `Enviar ${pages.filter((p) => !p.sent).length} arquivo(s)`}
                </button>
                <button
                  className="text-button"
                  disabled={sending}
                  onClick={clear}
                >
                  Limpar seleção e acompanhar nova solicitação
                </button>
              </section>
            )}
            <div className="mobile-session">
              <span>
                Conexão temporária
                {pair.expires_at
                  ? ` até ${new Date(pair.expires_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                  : ''}
              </span>
              <button disabled={sending} onClick={disconnect}>
                Desconectar
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
