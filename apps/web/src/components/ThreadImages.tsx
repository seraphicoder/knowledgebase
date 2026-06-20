import { useEffect, useState } from 'react';
import { listThreadAttachments, listArticleImages } from '../lib/api';
import { ImageGallery, type GalleryImage } from './ImageGallery';

// Loads + shows a thread's image attachments (signed URLs from the API).
export function ThreadImages({ threadId }: { threadId: string }) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  useEffect(() => {
    let active = true;
    listThreadAttachments(threadId)
      .then((r) => active && setImages(r.attachments.map((a) => ({ id: a.id, url: a.url, filename: a.filename }))))
      .catch(() => active && setImages([]));
    return () => {
      active = false;
    };
  }, [threadId]);
  return <ImageGallery images={images} title="Images" />;
}

// Loads + shows a published article's curated images.
export function ArticleImages({ articleId }: { articleId: string }) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  useEffect(() => {
    let active = true;
    listArticleImages(articleId)
      .then((r) => active && setImages(r.images.map((a) => ({ id: a.id, url: a.url }))))
      .catch(() => active && setImages([]));
    return () => {
      active = false;
    };
  }, [articleId]);
  return <ImageGallery images={images} title="Images" />;
}
