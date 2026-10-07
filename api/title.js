import { isAuthorizedRequest } from './lib/auth.js';

const TITLE_INSTRUCTION = [
  'You write short titles for conversations with a records assistant.',
  'Given the first message of a conversation, reply with a title of at most six words.',
  'Rules:',
  '- Reply with the title text only - no quotes, no prefixes like "Title:", no trailing period.',
  '- Write the title in the same language as the message.',
  '- Capture what the conversation is about (e.g. "Expiring visas this quarter"), not verbatim words.',
  '- Never use names, emails or record numbers unless they are essential to the topic.'
].join('\n');

function modelSettings() {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const generationConfig = { maxOutputTokens: 64, temperature: 0.3 };

  // Thinking would only slow a six-word answer down - switch it off.
  if (model.startsWith('gemini-2.5')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  return { model, generationConfig };
}

// Same shape as the old client-side truncation, kept as the safety net
// so the sidebar always shows something sensible even when Gemini is down.
export function fallbackTitle(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? `${clean.slice(0, 48).trim()}…` : clean;
}

function cleanGenerated(raw) {
  let title = raw
    .replace(/\s+/g, ' ')
    .trim()
    // models occasionally wrap answers in quotes or markdown emphasis
    .replace(/^["'“”‘’`*_\-\s]+/, '')
    .replace(/["'“”‘’`*_]+$/, '')
    .replace(/\.+$/, '')
    .trim();

  if (!title) return '';
  if (title.length > 60) {
    title = `${title.slice(0, 60).replace(/\s+\S*$/, '').trim()}…`;
  }
  return title;
}

async function generateTitle(message) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const { model, generationConfig } = modelSettings();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: TITLE_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: message.slice(0, 2000) }] }],
        generationConfig
      })
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${detail.slice(0, 300)}`);
  }

  const result = await response.json();
  const parts = result.candidates?.[0]?.content?.parts ?? [];
  return cleanGenerated(parts.filter((part) => part.text && !part.thought).map((part) => part.text).join(''));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-middleware-key, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!(await isAuthorizedRequest(req))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  // A title is cosmetic - always answer with one rather than an error,
  // falling back to the truncated message if generation misbehaves.
  try {
    res.status(200).json({ title: cleanGenerated(await generateTitle(message)) || fallbackTitle(message) });
  } catch (err) {
    console.error('Title error:', err.message);
    res.status(200).json({ title: fallbackTitle(message), generated: false });
  }
}
