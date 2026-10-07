import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export default function RenameDialog({ initial, onSave, onClose }) {
  const [title, setTitle] = useState(initial);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submit(e) {
    e.preventDefault();
    if (title.trim()) onSave(title);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-line bg-panel p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Rename conversation</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-faint transition hover:bg-canvas hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Conversation title"
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm outline-none transition focus:border-moss focus:bg-panel"
        />

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line-strong bg-panel px-3.5 py-2 text-xs font-semibold text-ink-soft transition hover:bg-canvas"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim()}
            className="rounded-lg bg-moss px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-moss-deep disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
