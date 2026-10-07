import { runAgentLoop, FALLBACK_REPLY } from './lib/agent.js';
import { isAuthorizedRequest } from './lib/auth.js';
import { createClient } from '@supabase/supabase-js';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN?.trim();

function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const allowOrigin = ALLOWED_ORIGIN ? (origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : null) : '*';

  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    if (ALLOWED_ORIGIN) res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-middleware-key, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (ALLOWED_ORIGIN && !allowOrigin) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }

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

  const { message, history = [], sessionId } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: 'History must be an array' });
  }

  try {
    const result = await runAgentLoop([...history, { role: 'user', content: message }]);
    const answer = result.answer || FALLBACK_REPLY;

    // Debug logging
    const supabase = getSupabase();
    console.log('[CHAT] Request received:', { message: message.slice(0, 50), sessionId, hasSupabase: !!supabase });
    console.log('[CHAT] Agent result:', { hasAnswer: !!answer, toolsUsed: result.toolsUsed?.length, tokenUsage: result.tokenUsage });

    // Store assistant message with usage data in the same row
    let storedMessage = null;
    if (supabase && sessionId) {
      console.log('[CHAT] Storing message with usage data...');

      // Ensure tool_usage doesn't exceed PostgreSQL btree page size limits
      let safeToolUsage = result.toolsUsed?.length ? result.toolsUsed : null;
      if (safeToolUsage && JSON.stringify(safeToolUsage).length > 2000) {
        safeToolUsage = safeToolUsage.map((t) => ({
          name: t.name,
          executionTimeMs: t.executionTimeMs,
          recordCount: t.output?.count ?? (Array.isArray(t.output) ? t.output.length : undefined)
        }));
      }

      const { data, error } = await supabase
        .from('chat_messages')
        .insert({
          session_id: sessionId,
          role: 'assistant',
          content: answer,
          tool_usage: safeToolUsage,
          token_usage: result.tokenUsage?.totalTokens > 0 ? result.tokenUsage : null
        })
        .select('id,session_id,role,content,created_at,tool_usage,token_usage')
        .single();

      if (error) {
        console.error('[CHAT] Failed to store message with usage:', error.message);
        console.error('[CHAT] Full error:', JSON.stringify(error, null, 2));

        // Fallback 1: Store without tool_usage so message content is never lost
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('chat_messages')
          .insert({
            session_id: sessionId,
            role: 'assistant',
            content: answer,
            token_usage: result.tokenUsage?.totalTokens > 0 ? result.tokenUsage : null
          })
          .select('id,session_id,role,content,created_at')
          .single();

        if (fallbackError) {
          console.error('[CHAT] Fallback 1 failed, trying bare message store:', fallbackError.message);
          // Fallback 2: Store bare minimum message
          const { data: bareData, error: bareError } = await supabase
            .from('chat_messages')
            .insert({
              session_id: sessionId,
              role: 'assistant',
              content: answer
            })
            .select('id,session_id,role,content,created_at')
            .single();

          if (!bareError) {
            console.log('[CHAT] Bare message stored successfully');
            storedMessage = bareData;
          } else {
            console.error('[CHAT] Bare message store failed:', bareError.message);
          }
        } else {
          console.log('[CHAT] Fallback message stored successfully without tool_usage');
          storedMessage = fallbackData;
        }
      } else {
        console.log('[CHAT] Message stored successfully with usage data');
        storedMessage = data;
      }
    } else {
      console.log('[CHAT] Skipping storage - supabase or sessionId missing', { hasSupabase: !!supabase, sessionId });
    }

    res.status(200).json({ response: answer, storedMessage });
  } catch (err) {
    console.error('[CHAT] Chat error:', err);
    res.status(200).json({ response: FALLBACK_REPLY });
  }
}
