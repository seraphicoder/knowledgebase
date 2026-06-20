import { useEffect } from 'react';

export interface LightboxImage {
  url: string;
  filename?: string | null;
}

// Full-screen image preview with backdrop-close, ✕, and ‹ › / arrow-key nav
// across the provided list. Sits above drawers and the editor.
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
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6" onClick={onClose}>
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
      <img
        src={cur.url}
        alt={cur.filename ?? 'image'}
        className="max-h-full max-w-full rounded object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      {index < images.length - 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }}
          className="absolute right-4 text-4xl leading-none text-white/70 hover:text-white"
          aria-label="Next"
        >
          ›
        </button>
      )}
      <div className="absolute bottom-3 left-0 right-0 text-center text-xs text-white/70">
        {cur.filename ? `${cur.filename} · ` : ''}{index + 1} / {images.length}
      </div>
    </div>
  );
}
