'use client';
// Editor de tarja da tela do celular: a pessoa pinta sobre nome, CPF ou endereço de uma foto
// antes de enviá-la. Devolve um arquivo novo, que toma o lugar do original na lista de páginas.
import { useEffect, useRef, useState } from 'react';
import { Check, Square, Paintbrush, Undo2, RotateCcw, X } from 'lucide-react';
import type { MobilePage } from './use-mobile-capture';

type RedactAction =
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'brush'; points: { x: number; y: number }[]; width: number };

type RedactModalProps = {
  page: MobilePage;
  onClose: () => void;
  onSave: (editedFile: File) => void;
};

export function RedactModal({ page, onClose, onSave }: RedactModalProps) {
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
