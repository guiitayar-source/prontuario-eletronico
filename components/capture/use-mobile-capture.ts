// Lógica da tela do celular (/celular): pareamento com o computador, páginas escolhidas,
// conferência e envio. A tela está em mobile.tsx.
import { useEffect, useRef, useState } from 'react';
import {
  api,
  compressImageFile,
  type CaptureRequest,
  type Pairing,
} from './client';

/** Uma página (foto ou PDF) escolhida no celular para enviar ao computador. */
export type MobilePage = {
  id: string;
  file: File;
  url: string;
  sent: boolean;
  name: string;
  isRedacted?: boolean;
};

/** Estado e ações da tela do celular: conexão, lista de páginas, tarja e envio. */
export function useMobileCapture() {
  const [pair, setPair] = useState<Pairing | null>(null),
    [request, setRequest] = useState<CaptureRequest | null>(null);
  const [locked, setLocked] = useState<CaptureRequest | null>(null),
    [pages, setPages] = useState<MobilePage[]>([]);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [sending, setSending] = useState(false);
  const [confirmed, setConfirmed] = useState(false),
    [now, setNow] = useState(Date.now()),
    [loaded, setLoaded] = useState(false);
  const urls = useRef(new Set<string>());
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
    const created = urls.current;
    return () => {
      created.forEach((url) => URL.revokeObjectURL(url));
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
    // Só reconecta quando o pareamento muda; expires_at não reinicia a consulta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            // eslint-disable-next-line no-control-regex -- remove caracteres de controle do nome
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
  /** Limpa o aviso de erro e consulta o computador de novo. */
  function reconnect() {
    setError('');
    setRetry((n) => n + 1);
  }
  function renamePage(id: string, name: string) {
    setPages((prev) =>
      prev.map((item) => (item.id === id ? { ...item, name } : item)),
    );
  }
  /** Troca a imagem da página em edição pela versão com tarja. */
  function applyRedaction(newFile: File) {
    if (!editingPage) return;
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
  }
  return {
    pair,
    loaded,
    verified,
    current,
    locked,
    stale,
    expired,
    available,
    pages,
    editingPage,
    confirmed,
    sending,
    error,
    message,
    select,
    drop,
    reorder,
    renamePage,
    clear,
    send,
    disconnect,
    reconnect,
    setConfirmed,
    setEditingPageId,
    applyRedaction,
  };
}
