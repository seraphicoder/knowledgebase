import { useState } from 'react';
import { Lightbox } from './Lightbox';

// Presentational thumbnail grid for signed image URLs. Clicking a thumbnail opens
// a lightbox preview with nav across the set. Renders nothing if empty.
export interface GalleryImage {
  id: string;
  url: string | null;
  filename?: string | null;
}

export function ImageGallery({ images, title }: { images: GalleryImage[]; title?: string }) {
  const usable = images.filter((i): i is GalleryImage & { url: string } => Boolean(i.url));
  const [open, setOpen] = useState<number | null>(null);
  if (usable.length === 0) return null;
  return (
    <div className="mt-4">
      {title && <h3 className="mb-2 text-sm font-medium text-gray-700">{title} ({usable.length})</h3>}
      <div className="flex flex-wrap gap-2">
        {usable.map((a, i) => (
          <button key={a.id} type="button" onClick={() => setOpen(i)} title={a.filename ?? 'image'}>
            <img
              src={a.url}
              alt={a.filename ?? 'attachment'}
              loading="lazy"
              className="h-24 w-24 rounded border border-gray-200 object-cover hover:opacity-90"
            />
          </button>
        ))}
      </div>
      {open != null && (
        <Lightbox
          images={usable.map((u) => ({ url: u.url, filename: u.filename }))}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
