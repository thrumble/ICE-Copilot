import { useState } from 'react';
import { AlertCircle, ArrowRight, Loader2, Lock, Mail } from 'lucide-react';
import { ALLOWED_EMAIL, supabase } from '../lib/supabase';

export default function Login({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);

    try {
      const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });

      if (err || !data.session) throw new Error(err?.message || 'Unable to sign in.');
      if (data.user.email?.toLowerCase() !== ALLOWED_EMAIL) {
        await supabase.auth.signOut();
        throw new Error('That account does not have access to this console.');
      }

      onDone(data.session);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-full flex-col items-center justify-center overflow-hidden bg-canvas px-4 py-14">
      <div aria-hidden className="pointer-events-none absolute -left-28 -top-28 h-80 w-80 rounded-full bg-moss/[0.06]" />
      <div aria-hidden className="pointer-events-none absolute -bottom-36 -right-24 h-96 w-96 rounded-full bg-moss/[0.06]" />

      <div className="relative z-10 w-full max-w-md">
        <header className="mb-9 text-center">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.4em] text-ink-faint">FXBC</p>
          <h1 className="mt-3 font-serif text-6xl italic leading-none">
            Copilot<span className="not-italic text-moss">.</span>
          </h1>
        </header>

        <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-xl shadow-black/5">
          <div className="h-1 bg-moss" />

          <div className="p-8 sm:p-10">
            <div className="mb-7 flex items-center gap-3">
              <span className="h-px flex-1 bg-line" />
              <h2 className="font-mono text-[10px] font-medium uppercase tracking-[0.3em] text-ink-faint">
                Sign in
              </h2>
              <span className="h-px flex-1 bg-line" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-5" autoComplete="on">
              <label className="block space-y-1.5">
                <span className="font-mono text-[10px] font-medium uppercase tracking-widest text-ink-faint">
                  Email
                </span>
                <span className="relative block">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                    required
                    autoComplete="email"
                    className="w-full rounded-lg border border-line bg-canvas py-2.5 pl-10 pr-3 text-sm outline-none transition placeholder:text-ink-faint focus:border-moss focus:bg-panel"
                  />
                </span>
              </label>

              <label className="block space-y-1.5">
                <span className="font-mono text-[10px] font-medium uppercase tracking-widest text-ink-faint">
                  Password
                </span>
                <span className="relative block">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    autoComplete="current-password"
                    className="w-full rounded-lg border border-line bg-canvas py-2.5 pl-10 pr-3 text-sm outline-none transition placeholder:text-ink-faint focus:border-moss focus:bg-panel"
                  />
                </span>
              </label>

              {error && (
                <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-relaxed text-red-700">
                  <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="group flex w-full items-center justify-center gap-2 rounded-lg bg-moss py-2.5 text-sm font-semibold text-white transition hover:bg-moss-deep active:scale-[0.99] disabled:opacity-50"
              >
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Checking…
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </>
                )}
              </button>
            </form>
          </div>
        </section>

        <footer className="mt-7 space-y-1 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
            Internal use only
          </p>
          <p className="text-[11px] text-ink-faint/70">
            Access is limited to authorised FXBC accounts.
          </p>
        </footer>
      </div>
    </main>
  );
}
