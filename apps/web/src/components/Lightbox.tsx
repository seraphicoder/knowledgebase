import { useEffect, useRef, useState } from 'react';

export interface LightboxImage {
  url: string;
  filename?: string | null;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Full-screen image preview with zoom (wheel / buttons / double-click) and
// drag-to-pan, plus ‹ › / arrow-key nav across the set. Sits above drawers and
// the editor.
export function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: LightboxImage[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const cur = images[index];
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  const reset = () => {
    setScale(1);
    setTx(0);
    setTy(0);
  };

  // Reset zoom/pan whenever the image changes.
  useEffect(reset, [index]);

  function zoomBy(factor: number) {
    setScale((s) => {
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE);
      if (ns === 1) {
        setTx(0);
        setTy(0);
      }
      return ns;
    });
  }

  // Wheel zoom via a non-passive native listener so preventDefault works.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keyboard: Escape closes, arrows navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onClose, onIndex]);

  if (!cur) return null;

  function onPointerDown(e: React.PointerEvent) {
    if (scale <= 1) return;
    drag.current = { x: e.clientX, y: e.clientY, tx, ty };
    setGrabbing(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setTx(drag.current.tx + (e.clientX - drag.current.x));
    setTy(drag.current.ty + (e.clientY - drag.current.y));
  }
  function endDrag() {
    drag.current = null;
    setGrabbing(false);
  }

  const Btn = ({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={label}
      className="rounded bg-white/10 px-2 py-1 text-lg leading-none text-white hover:bg-white/20"
    >
      {children}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80" onClick={onClose}>
      <button onClick={onClose} className="absolute right-4 top-3 text-3xl leading-none text-white/80 hover:text-white">
        ✕
      </button>
      {index > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }}
          className="absolute left-4 text-4xl leading-none text-white/70 hover:text-white"
          aria-label="Previous"
        >
          ‹
        </button>
      )}

      <div
        ref={stageRef}
        className="flex h-full w-full items-center justify-center overflow-hidden p-10"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={() => (scale > 1 ? reset() : setScale(2.5))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <img
          src={cur.url}
          alt={cur.filename ?? 'image'}
          draggable={false}
          className="max-h-full max-w-full select-none rounded object-contain shadow-2xl"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transition: drag.current ? 'none' : 'transform 0.12s ease-out',
            cursor: scale > 1 ? (grabbing ? 'grabbing' : 'grab') : 'zoom-in',
          }}
        />
      </div>

      {index < images.length - 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }}
          className="absolute right-4 text-4xl leading-none text-white/70 hover:text-white"
          aria-label="Next"
        >
          ›
        </button>
      )}

      {/* Zoom controls + caption */}
      <div
        className="absolute bottom-3 left-0 right-0 flex items-center justify-center gap-3 text-xs text-white/70"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1">
          <Btn onClick={() => zoomBy(1 / 1.25)} label="Zoom out">−</Btn>
          <span className="w-12 text-center">{Math.round(scale * 100)}%</span>
          <Btn onClick={() => zoomBy(1.25)} label="Zoom in">+</Btn>
          {scale !== 1 && <Btn onClick={reset} label="Reset zoom">⟲</Btn>}
        </div>
        <span>
          {cur.filename ? `${cur.filename} · ` : ''}
          {index + 1} / {images.length}
        </span>
      </div>
    </div>
  );
}
