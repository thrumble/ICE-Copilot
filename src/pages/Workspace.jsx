import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { askCopilot, generateTitle } from '../lib/api';
import Sidebar from '../components/Sidebar';
import ChatPane from '../components/ChatPane';
import RenameDialog from '../components/RenameDialog';
import DeleteDialog from '../components/DeleteDialog';

// placeholder until the API generates a proper title after the first reply
const fallbackTitle = (text) => (text.length > 48 ? `${text.slice(0, 48).trim()}…` : text);

export default function Workspace({ session }) {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const active = sessions.find((s) => s.id === activeId);

  useEffect(() => {
    async function init() {
      const sessionList = await loadSessions();
      const savedActiveId = localStorage.getItem('fxbc_active_session_id');
      if (savedActiveId && sessionList.some((s) => s.id === savedActiveId)) {
        openSession(savedActiveId);
      }
    }
    init();

    const onKey = (e) => {
      if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        startNew();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function loadSessions() {
    const { data, error: err } = await supabase
      .from('chat_sessions')
      .select('id,title,created_at,updated_at')
      .order('updated_at', { ascending: false });
    if (err) {
      setError(err.message);
      return [];
    }
    setSessions(data ?? []);
    return data ?? [];
  }

  async function openSession(id) {
    setActiveId(id);
    localStorage.setItem('fxbc_active_session_id', id);
    setError('');
    setNavOpen(false);

    const { data, error: err } = await supabase
      .from('chat_messages')
      .select('id,session_id,role,content,created_at')
      .eq('session_id', id)
      .order('created_at');
    if (err) setError(err.message);
    setMessages(data ?? []);
  }

  function startNew() {
    setActiveId(null);
    localStorage.removeItem('fxbc_active_session_id');
    setMessages([]);
    setError('');
    setNavOpen(false);
  }

  async function send(text) {
    const content = text.trim();
    if (!content || busy) return;

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    setBusy(true);
    setError('');

    try {
      let conversationId = activeId;
      let isNewConversation = false;

      if (!conversationId) {
        const { data, error: err } = await supabase
          .from('chat_sessions')
          .insert({ user_id: session.user.id, title: fallbackTitle(content) })
          .select('id,title,created_at,updated_at')
          .single();
        if (err) throw new Error(err.message);
        conversationId = data.id;
        isNewConversation = true;
        setActiveId(conversationId);
        localStorage.setItem('fxbc_active_session_id', conversationId);
        setSessions((prev) => [data, ...prev]);
      }

      // the question goes into the database first, so it survives even if
      // the reply fails - the user never loses what they typed
      const { data: userRow, error: userErr } = await supabase
        .from('chat_messages')
        .insert({ session_id: conversationId, role: 'user', content })
        .select('id,session_id,role,content,created_at')
        .single();
      if (userErr) throw new Error(userErr.message);

      setMessages((prev) => [...prev, userRow]);

      let reply;
      let storedMessage;
      try {
        const result = await askCopilot(content, history, conversationId);
        reply = result.response;
        storedMessage = result.storedMessage;
      } catch (copilotErr) {
        console.error('askCopilot exception:', copilotErr);
        reply = "I'm sorry, an error occurred while processing your request. Please try asking your question again.";
      }

      if (!reply) {
        reply = "I'm sorry, an error occurred while processing your request. Please try asking your question again.";
      }

      // Use the message stored by the backend, or fallback to saving from frontend so it persists across refresh
      let assistantMsg = storedMessage;
      if (!assistantMsg) {
        try {
          const { data: clientSaved, error: clientErr } = await supabase
            .from('chat_messages')
            .insert({
              session_id: conversationId,
              role: 'assistant',
              content: reply
            })
            .select('id,session_id,role,content,created_at')
            .single();

          if (!clientErr && clientSaved) {
            assistantMsg = clientSaved;
          }
        } catch (clientSaveErr) {
          console.warn('Frontend fallback save error:', clientSaveErr);
        }
      }

      if (!assistantMsg) {
        assistantMsg = {
          id: `err-${Date.now()}`,
          session_id: conversationId,
          role: 'assistant',
          content: reply,
          created_at: new Date().toISOString()
        };
      }

      setMessages((prev) => [...prev, assistantMsg]);
      await supabase
        .from('chat_sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId);
      await loadSessions();

      // upgrade the placeholder title to a generated one
      if (isNewConversation) {
        try {
          const generated = await generateTitle(content);
          if (generated && generated !== fallbackTitle(content)) {
            await supabase.from('chat_sessions').update({ title: generated }).eq('id', conversationId);
            await loadSessions();
          }
        } catch (titleErr) {
          console.warn('Title generation skipped:', titleErr.message);
        }
      }
    } catch (err) {
      console.error('Send error:', err);
      // Ensure even unexpected outer errors are appended & saved as an assistant message
      if (activeId) {
        const fallbackMsg = "I'm sorry, an error occurred while processing your request. Please try asking your question again.";
        const { data: errRow } = await supabase
          .from('chat_messages')
          .insert({ session_id: activeId, role: 'assistant', content: fallbackMsg })
          .select('id,session_id,role,content,created_at')
          .single();

        setMessages((prev) => [
          ...prev,
          errRow || { id: `err-${Date.now()}`, session_id: activeId, role: 'assistant', content: fallbackMsg, created_at: new Date().toISOString() }
        ]);
      }
    } finally {
      setBusy(false);
    }
  }


  async function renameSession(title) {
    if (!active || !title.trim()) return;
    const { error: err } = await supabase
      .from('chat_sessions')
      .update({ title: title.trim() })
      .eq('id', active.id);
    setRenaming(false);
    if (err) return setError(err.message);
    await loadSessions();
  }

  async function deleteSession() {
    if (!active) return;
    const { error: err } = await supabase.from('chat_sessions').delete().eq('id', active.id);
    setDeleting(false);
    if (err) return setError(err.message);

    startNew();
    await loadSessions();
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[2px] md:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}

      <Sidebar
        user={session.user}
        sessions={sessions}
        activeId={activeId}
        open={navOpen}
        onClose={() => setNavOpen(false)}
        onSelect={openSession}
        onNew={startNew}
      />

      <ChatPane
        conversation={active}
        messages={messages}
        busy={busy}
        error={error}
        onSend={send}
        onMenu={() => setNavOpen(true)}
        onRename={() => setRenaming(true)}
        onDelete={() => setDeleting(true)}
      />

      {renaming && (
        <RenameDialog initial={active?.title ?? ''} onSave={renameSession} onClose={() => setRenaming(false)} />
      )}

      {deleting && active && (
        <DeleteDialog title={active.title} onConfirm={deleteSession} onClose={() => setDeleting(false)} />
      )}
    </div>
  );
}
