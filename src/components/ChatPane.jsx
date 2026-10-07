import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, Menu, Pencil, Send, Trash2 } from 'lucide-react';
import { greeting, stamp } from '../lib/time';

export default function ChatPane({
  conversation,
  messages,
  busy,
  error,
  onSend,
  onMenu,
  onRename,
  onDelete
}) {
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState(null);
  const endRef = useRef(null);
  const boxRef = useRef(null);

  // ~5 lines of text-sm (20px/line) + vertical padding.
  const BOX_MAX = 132;

  // Flexible input: 1 line idle, grows with content up to 5 lines, then scrolls.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const capped = Math.min(el.scrollHeight, BOX_MAX);
    el.style.height = `${capped}px`;
    el.style.overflowY = el.scrollHeight > BOX_MAX ? 'auto' : 'hidden';
  }, [draft, messages.length]);

  // Fresh conversation: composer sits in the middle. The first send adds a
  // user row, flipping this to false and gliding the composer to the bottom.
  const isFresh = messages.length === 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  function submit(e) {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft('');
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(e);
    }
  }

  function copy(message) {
    navigator.clipboard.writeText(message.content);
    setCopiedId(message.id);
    setTimeout(() => setCopiedId((cur) => (cur === message.id ? null : cur)), 1600);
  }

  function composer(autoFocus) {
    return (
      <form onSubmit={submit} className="w-full">
        <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-panel p-2 shadow-sm focus-within:border-moss">
          <textarea
            ref={boxRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Type your question…"
            disabled={busy}
            autoFocus={autoFocus}
            className="max-h-36 min-h-[38px] flex-1 resize-none overflow-hidden bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-ink-faint disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            title="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-moss text-white transition hover:bg-moss-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="ml-0.5 h-4 w-4" />
            )}
          </button>
        </div>
      </form>
    );
  }

  if (isFresh) {
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-panel/80 px-4 backdrop-blur-sm md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={onMenu}
              className="rounded-lg p-1.5 text-ink-faint transition hover:bg-canvas hover:text-ink md:hidden"
              title="Conversations"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="truncate text-sm font-semibold">New conversation</h1>
          </div>
        </header>

        <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 md:px-8">
          <div className="fresh-in w-full max-w-2xl py-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-moss">
              {greeting()}
            </p>
            <h2 className="mt-3 font-serif text-4xl italic leading-tight md:text-5xl">
              What are we looking into?
            </h2>
            <p className="mt-3 text-sm text-ink-soft">
              Ask in plain English.
            </p>

            {error && (
              <p className="mt-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs leading-relaxed text-red-700">
                <span className="mt-px h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-red-500" />
                {error}
              </p>
            )}

            <div className="mt-6">{composer(true)}</div>
            <p className="mt-3 font-mono text-[10px] text-ink-faint">
              enter to send · shift+enter for a new line · alt+n new conversation
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-canvas">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-panel/80 px-4 backdrop-blur-sm md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={onMenu}
            className="rounded-lg p-1.5 text-ink-faint transition hover:bg-canvas hover:text-ink md:hidden"
            title="Conversations"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="truncate text-sm font-semibold">
            {conversation?.title ?? 'New conversation'}
          </h1>
        </div>

        {conversation && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={onRename}
              title="Rename"
              className="rounded-lg p-2 text-ink-faint transition hover:bg-canvas hover:text-ink"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              onClick={onDelete}
              title="Delete"
              className="rounded-lg p-2 text-ink-faint transition hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </header>

      <div className="thread-rise flex-1 overflow-y-auto px-4 py-6 md:px-8">
        {error && (
          <div className="mx-auto mb-5 max-w-2xl">
            <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs leading-relaxed text-red-700">
              <span className="mt-px h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-red-500" />
              {error}
            </p>
          </div>
        )}

        <div className="mx-auto max-w-2xl space-y-6 pb-6">
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <p className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-moss px-4 py-2.5 text-sm leading-relaxed text-white">
                  {m.content}
                </p>
              </div>
            ) : (
              <div key={m.id} className="group">
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                    Copilot · {stamp(m.created_at)}
                  </span>
                  <button
                    onClick={() => copy(m)}
                    title="Copy"
                    className="opacity-0 transition group-hover:opacity-100"
                  >
                    {copiedId === m.id ? (
                      <Check className="h-3 w-3 text-moss" />
                    ) : (
                      <Copy className="h-3 w-3 text-ink-faint hover:text-ink" />
                    )}
                  </button>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {m.content}
                </p>
              </div>
            )
          )}

          {busy && (
            <div className="flex items-center gap-2">
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-moss" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-moss [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-moss [animation-delay:300ms]" />
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                checking records
              </span>
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      <footer className="glide-down shrink-0 px-4 pb-5 md:px-8">
        <div className="mx-auto max-w-2xl">
          {composer(false)}
          <p className="mt-2 text-right font-mono text-[10px] text-ink-faint">
            enter to send · shift+enter for a new line · alt+n new conversation
          </p>
        </div>
      </footer>
    </main>
  );
}
