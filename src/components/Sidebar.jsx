import { useMemo, useState } from 'react';
import { LogOut, Plus, Search, X } from 'lucide-react';
import { ago } from '../lib/time';
import { supabase } from '../lib/supabase';

function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'older';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((startOfToday - d) / 86400000);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return 'week';
  return 'older';
}

const GROUPS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'Previous 7 days'],
  ['older', 'Older']
];

export default function Sidebar({
  user,
  sessions,
  activeId,
  open,
  onClose,
  onSelect,
  onNew
}) {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  }, [sessions, query]);

  const grouped = useMemo(() => {
    const out = { today: [], yesterday: [], week: [], older: [] };
    for (const s of visible) out[dayKey(s.updated_at)].push(s);
    return out;
  }, [visible]);

  const email = user.email ?? '';
  const initial = email.charAt(0).toUpperCase();

  function pick(id) {
    onSelect(id);
    onClose();
  }

  function newChat() {
    onNew();
    onClose();
  }

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-line bg-panel transition-transform duration-200 md:static md:translate-x-0 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
        <div className="flex items-center gap-2">
          <span className="text-[19px] font-bold tracking-wide text-ink">
            FXBC
          </span>
          <span className="font-serif text-2xl italic leading-none text-moss">copilot</span>
        </div>
        <button
          onClick={onClose}
          title="Close"
          className="rounded-lg p-1 text-ink-faint hover:text-ink md:hidden"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="px-3 pt-3">
        <button
          onClick={newChat}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-moss py-2.5 text-xs font-semibold text-white transition hover:bg-moss-deep"
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            className="w-full rounded-lg border border-line bg-canvas py-2 pl-9 pr-3 text-xs outline-none transition placeholder:text-ink-faint focus:border-moss focus:bg-panel"
          />
        </div>
      </div>

      <nav className="thread-rise mt-2 flex-1 space-y-4 overflow-y-auto px-2 pb-3">
        {GROUPS.map(([key, label]) =>
          grouped[key].length ? (
            <div key={key}>
              <p className="px-3 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                {label}
              </p>
              <div className="space-y-0.5">
                {grouped[key].map((s) => {
                  const isActive = s.id === activeId;
                  return (
                    <button
                      key={s.id}
                      onClick={() => pick(s.id)}
                      title={s.title}
                      className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition ${
                        isActive
                          ? 'bg-moss-mist text-moss-deep'
                          : 'text-ink-soft hover:bg-canvas'
                      }`}
                    >
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-moss" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                        {s.title}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                        {ago(s.updated_at)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null
        )}

        {!visible.length && (
          <p className="px-3 py-10 text-center text-xs text-ink-faint">
            {query ? 'Nothing matches that filter.' : 'Conversations will collect here.'}
          </p>
        )}
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5 rounded-lg bg-canvas p-2.5">
          <span
            title={email}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-moss text-xs font-semibold text-white"
          >
            {initial}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{email}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            title="Sign out"
            className="rounded-md p-1.5 text-ink-faint transition hover:bg-red-50 hover:text-red-600"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
