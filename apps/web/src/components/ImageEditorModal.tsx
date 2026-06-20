import FilerobotImageEditor, { TABS, TOOLS } from 'react-filerobot-image-editor';

// Full-screen image editor (crop + annotate: text, shapes, freehand). `source`
// must be a data URL so the canvas export isn't tainted by cross-origin loads.
// Default-exported for React.lazy so the heavy editor stays out of the main bundle.
export default function ImageEditorModal({
  source,
  onSave,
  onClose,
}: {
  source: string;
  onSave: (dataUrl: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70">
      <div className="absolute inset-2 overflow-hidden rounded bg-white sm:inset-6">
        <FilerobotImageEditor
          source={source}
          onSave={(img: { imageBase64?: string }) => {
            if (img.imageBase64) onSave(img.imageBase64);
          }}
          onClose={onClose}
          tabsIds={[TABS.ADJUST, TABS.ANNOTATE]}
          defaultTabId={TABS.ANNOTATE}
          defaultToolId={TOOLS.TEXT}
          savingPixelRatio={4}
          previewPixelRatio={1}
        />
      </div>
    </div>
  );
}
