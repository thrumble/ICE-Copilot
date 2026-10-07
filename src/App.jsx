import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ALLOWED_EMAIL, supabase } from './lib/supabase';
import Login from './pages/Login';
import Workspace from './pages/Workspace';

function permitted(session) {
  return Boolean(session && session.user.email?.toLowerCase() === ALLOWED_EMAIL);
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(permitted(data.session) ? data.session : null);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(permitted(next) ? next : null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  return session ? <Workspace session={session} /> : <Login onDone={setSession} />;
}
