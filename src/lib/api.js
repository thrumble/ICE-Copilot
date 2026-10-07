import { supabase } from './supabase';

export async function askCopilot(message, history, sessionId) {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? '';

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ message, history, sessionId })
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { response: body.response || "I'm sorry, an error occurred while processing your request. Please try again." };
    }
    if (!body.response) {
      return { response: "I'm sorry, an error occurred while processing your request. Please try again." };
    }
    return { response: body.response, storedMessage: body.storedMessage };
  } catch (err) {
    console.error('askCopilot error:', err);
    return "I'm sorry, an error occurred while processing your request. Please try again.";
  }
}


export async function generateTitle(message) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? '';

  const res = await fetch('/api/title', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ message })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  if (!body.title) throw new Error('No title was generated.');
  return body.title;
}
