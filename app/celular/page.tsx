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
  ShieldAlert,
  ShieldCheck,
  Square,
  Paintbrush,
  Undo2,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  api,
  compressImageFile,
  formatBytes,
  type CaptureRequest,
  type Pairing,
} from '@/components/capture/client';
type Page = {
  id: string;
  file: File;
  url: string;
  sent: boolean;
  name: string;
  isRedacted?: boolean;
};
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
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const editingPage = pages.find((p) => p.id === editingPageId);
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
        const baseName = file.name.replace(/\.[^/.]+$/, '') || 'exame';
        return {
          id: crypto.randomUUID(),
          file,
          url,
          sent: false,
          name: baseName,
          isRedacted: false,
        };
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

        const dotIndex = page.file.name.lastIndexOf('.');
        const ext =
          dotIndex !== -1
            ? page.file.name.slice(dotIndex)
            : page.file.type === 'application/pdf'
              ? '.pdf'
              : '.jpg';
        const cleanBase =
          (page.name || '')
            .trim()
            .replace(/[\x00-\x1f\x7f/\\]/g, '_')
            .slice(0, 120) || `pagina_${i + 1}`;
        const finalFilename = cleanBase.toLowerCase().endsWith(ext.toLowerCase())
          ? cleanBase
          : `${cleanBase}${ext}`;
        const fileToSend =
          page.file.name === finalFilename
            ? page.file
            : new File([page.file], finalFilename, { type: page.file.type });

        const body = new FormData();
        body.set('requestId', requestId);
        body.set('uploadId', page.id);
        body.set('file', fileToSend);
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
                      <div className="capture-page-header-row">
                        <span className="capture-page-number">Página {i + 1}</span>
                        <small>
                          {formatBytes(p.file.size)}{' '}
                          {p.sent ? '· Recebido no computador' : ''}
                        </small>
                      </div>

                      <div className="page-name-field">
                        <div className="page-name-input-row">
                          <input
                            type="text"
                            className="page-name-input"
                            disabled={sending || p.sent}
                            value={p.name}
                            placeholder="Nome do exame (ex: Hemograma)"
                            onChange={(e) => {
                              const val = e.target.value;
                              setPages((prev) =>
                                prev.map((item) =>
                                  item.id === p.id ? { ...item, name: val } : item,
                                ),
                              );
                            }}
                          />
                          <span className="page-name-ext">
                            {p.file.name.includes('.')
                              ? p.file.name.slice(p.file.name.lastIndexOf('.'))
                              : ''}
                          </span>
                        </div>

                        <div className="page-name-chips" aria-label="Sugestões de nomes">
                          {[
                            'Hemograma',
                            'Bioquímica',
                            'Urina',
                            'Raio-X',
                            'Tomografia',
                            'Laudo',
                            'Receita',
                          ].map((chip) => (
                            <button
                              key={chip}
                              type="button"
                              disabled={sending || p.sent}
                              className={`page-chip ${p.name === chip ? 'is-selected' : ''}`}
                              onClick={() => {
                                setPages((prev) =>
                                  prev.map((item) =>
                                    item.id === p.id ? { ...item, name: chip } : item,
                                  ),
                                );
                              }}
                            >
                              {chip}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="capture-page-actions-row">
                        {p.file.type.startsWith('image/') ? (
                          <button
                            type="button"
                            className={`redact-trigger-btn ${p.isRedacted ? 'is-redacted' : ''}`}
                            disabled={sending || p.sent}
                            onClick={() => setEditingPageId(p.id)}
                          >
                            {p.isRedacted ? (
                              <>
                                <ShieldCheck size={15} />
                                <span>Tarja aplicada (editar)</span>
                              </>
                            ) : (
                              <>
                                <ShieldAlert size={15} />
                                <span>Ocultar dados (tarja)</span>
                              </>
                            )}
                          </button>
                        ) : (
                          <span />
                        )}

                        <div className="capture-order-btns">
                          <button
                            aria-label={`Subir página ${i + 1}`}
                            disabled={
                              sending || pages.some((x) => x.sent) || i === 0
                            }
                            onClick={() => reorder(i, -1)}
                          >
                            <ArrowUp size={16} />
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
                            <ArrowDown size={16} />
                          </button>
                          <button
                            aria-label={`Remover página ${i + 1}`}
                            disabled={sending || p.sent}
                            onClick={() => drop(p.id)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
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

      {editingPage && (
        <RedactModal
          page={editingPage}
          onClose={() => setEditingPageId(null)}
          onSave={(newFile) => {
            URL.revokeObjectURL(editingPage.url);
            const newUrl = URL.createObjectURL(newFile);
            urls.current.delete(editingPage.url);
            urls.current.add(newUrl);
            setPages((prev) =>
              prev.map((item) =>
                item.id === editingPage.id
                  ? { ...item, file: newFile, url: newUrl, isRedacted: true }
                  : item,
              ),
            );
            setEditingPageId(null);
          }}
        />
      )}
    </div>
  );
}

type RedactAction =
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'brush'; points: { x: number; y: number }[]; width: number };

type RedactModalProps = {
  page: Page;
  onClose: () => void;
  onSave: (editedFile: File) => void;
};

function RedactModal({ page, onClose, onSave }: RedactModalProps) {
  const [loading, setLoading] = useState(true);
  const [activeTool, setActiveTool] = useState<'rect' | 'brush'>('rect');
  const [canUndo, setCanUndo] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const actionsRef = useRef<RedactAction[]>([]);
  const isDrawingRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const currentBrushPointsRef = useRef<{ x: number; y: number }[]>([]);

  function renderAll(
    ctx: CanvasRenderingContext2D,
    actions: RedactAction[],
    previewRect?: { x: number; y: number; w: number; h: number } | null,
  ) {
    const img = baseImgRef.current;
    if (!img) return;
    ctx.drawImage(img, 0, 0);

    ctx.fillStyle = '#000000';
    ctx.strokeStyle = '#000000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const act of actions) {
      if (act.type === 'rect') {
        ctx.fillRect(act.x, act.y, act.w, act.h);
      } else if (act.type === 'brush') {
        if (act.points.length === 1) {
          ctx.beginPath();
          ctx.arc(act.points[0].x, act.points[0].y, act.width / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (act.points.length > 1) {
          ctx.lineWidth = act.width;
          ctx.beginPath();
          ctx.moveTo(act.points[0].x, act.points[0].y);
          for (let i = 1; i < act.points.length; i++) {
            ctx.lineTo(act.points[i].x, act.points[i].y);
          }
          ctx.stroke();
        }
      }
    }

    if (previewRect) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(previewRect.x, previewRect.y, previewRect.w, previewRect.h);
    }
  }

  useEffect(() => {
    let active = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!active) return;
      baseImgRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      renderAll(ctx, []);
      actionsRef.current = [];
      setCanUndo(false);
      setLoading(false);
    };
    img.src = page.url;
    return () => {
      active = false;
    };
  }, [page.url]);

  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const getDynamicBrushWidth = () => {
    const canvas = canvasRef.current;
    if (!canvas) return 30;
    const rect = canvas.getBoundingClientRect();
    const ratio = rect.width > 0 ? canvas.width / rect.width : 1;
    return Math.max(20, Math.round(30 * ratio));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}

    const pos = getCanvasCoords(e);
    isDrawingRef.current = true;
    startPosRef.current = pos;

    if (activeTool === 'brush') {
      currentBrushPointsRef.current = [pos];
      const width = getDynamicBrushWidth();
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, width / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const pos = getCanvasCoords(e);

    if (activeTool === 'brush') {
      const prevPoints = currentBrushPointsRef.current;
      const prevPoint = prevPoints[prevPoints.length - 1];
      prevPoints.push(pos);
      if (prevPoint) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = getDynamicBrushWidth();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(prevPoint.x, prevPoint.y);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
      }
    } else if (activeTool === 'rect' && startPosRef.current) {
      const x = Math.min(startPosRef.current.x, pos.x);
      const y = Math.min(startPosRef.current.y, pos.y);
      const w = Math.abs(pos.x - startPosRef.current.x);
      const h = Math.abs(pos.y - startPosRef.current.y);
      renderAll(ctx, actionsRef.current, { x, y, w, h });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const pos = getCanvasCoords(e);

    if (activeTool === 'rect' && startPosRef.current) {
      const x = Math.min(startPosRef.current.x, pos.x);
      const y = Math.min(startPosRef.current.y, pos.y);
      const w = Math.abs(pos.x - startPosRef.current.x);
      const h = Math.abs(pos.y - startPosRef.current.y);
      if (w > 2 && h > 2) {
        actionsRef.current.push({ type: 'rect', x, y, w, h });
        setCanUndo(true);
      }
      renderAll(ctx, actionsRef.current);
      startPosRef.current = null;
    } else if (activeTool === 'brush') {
      if (currentBrushPointsRef.current.length > 0) {
        actionsRef.current.push({
          type: 'brush',
          points: [...currentBrushPointsRef.current],
          width: getDynamicBrushWidth(),
        });
        setCanUndo(true);
        currentBrushPointsRef.current = [];
      }
      renderAll(ctx, actionsRef.current);
    }
  };

  const handleUndo = () => {
    if (actionsRef.current.length === 0) return;
    actionsRef.current.pop();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    renderAll(ctx, actionsRef.current);
    setCanUndo(actionsRef.current.length > 0);
  };

  const handleReset = () => {
    actionsRef.current = [];
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    renderAll(ctx, []);
    setCanUndo(false);
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      renderAll(ctx, actionsRef.current);
    }

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const mime = page.file.type.startsWith('image/')
          ? page.file.type
          : 'image/jpeg';
        const editedFile = new File([blob], page.file.name, {
          type: mime,
          lastModified: Date.now(),
        });
        onSave(editedFile);
      },
      'image/jpeg',
      0.92,
    );
  };

  return (
    <div
      className="redact-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="redact-title"
    >
      <div className="redact-header">
        <div>
          <h3 id="redact-title">Ocultar dados identificadores</h3>
          <p>Pinte sobre nome, CPF ou endereço antes de enviar para a IA</p>
        </div>
        <button
          type="button"
          className="redact-close-btn"
          aria-label="Fechar"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>

      <div className="redact-toolbar">
        <div className="redact-tool-group">
          <button
            type="button"
            className={`redact-tool-btn ${activeTool === 'rect' ? 'active' : ''}`}
            onClick={() => setActiveTool('rect')}
          >
            <Square size={16} /> Tarja (Retângulo)
          </button>
          <button
            type="button"
            className={`redact-tool-btn ${activeTool === 'brush' ? 'active' : ''}`}
            onClick={() => setActiveTool('brush')}
          >
            <Paintbrush size={16} /> Pincel livre
          </button>
        </div>
        <div className="redact-tool-group">
          <button
            type="button"
            className="redact-tool-btn"
            disabled={!canUndo}
            onClick={handleUndo}
          >
            <Undo2 size={16} /> Desfazer
          </button>
          <button
            type="button"
            className="redact-tool-btn text-danger"
            disabled={!canUndo}
            onClick={handleReset}
          >
            <RotateCcw size={16} /> Limpar
          </button>
        </div>
      </div>

      <div className="redact-canvas-container">
        {loading && <div className="redact-loading">Carregando imagem…</div>}
        <canvas
          ref={canvasRef}
          className="redact-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>

      <div className="redact-footer">
        <div className="redact-hint">
          <span>
            Arraste o dedo sobre os dados pessoais. A imagem original nunca é
            enviada para a IA.
          </span>
        </div>
        <div className="redact-footer-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="primary" onClick={handleSave}>
            <Check size={18} /> Aplicar tarja
          </button>
        </div>
      </div>
    </div>
  );
}
