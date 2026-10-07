import SYSTEM_PROMPT from './systemPrompt.js';
import { SUPABASE_TOOLS, executeTool } from './tools.js';

const MAX_ITERATIONS = 10;
const EMPTY_RETRY_ATTEMPTS = 3;

export const FALLBACK_REPLY =
  "I'm sorry, an error occurred while processing your request. Please try asking your question again.";


function modelSettings() {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  // 0.6 keeps factual tool calls stable while understanding typos,
  // synonyms and vague phrasing. Validation stays deterministic in code.
  const generationConfig = { maxOutputTokens: 8192, temperature: 0.6 };

  // The 2.5 series spends part of the output budget on hidden reasoning.
  // Left uncapped it can swallow the whole budget and return an empty
  // reply, so we reserve a fixed slice for it and keep the rest for words.
  if (model.startsWith('gemini-2.5')) {
    generationConfig.thinkingConfig = { thinkingBudget: 1024 };
  }

  return { model, generationConfig };
}

async function callGemini(contents) {
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
        systemInstruction: { parts: [{ text: systemInstruction() }] },
        contents,
        tools: [{
          functionDeclarations: SUPABASE_TOOLS.map(({ name, description, input_schema }) => ({
            name,
            description,
            parameters: input_schema
          }))
        }],
        generationConfig
      })
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${detail.slice(0, 300)}`);
  }

  const result = await response.json();
  const candidate = result.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  // Thought summaries carry a thought flag - they are scratch work,
  // never the answer we want to show the user.
  const usableText = parts
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('');
  const calls = parts.filter((part) => part.functionCall);

  // Capture token usage for tracking
  const usageMetadata = result.usageMetadata || {};
  const tokenUsage = {
    promptTokens: usageMetadata.promptTokenCount || 0,
    completionTokens: usageMetadata.candidatesTokenCount || 0,
    totalTokens: usageMetadata.totalTokenCount || 0
  };

  return {
    usableText,
    calls,
    rawParts: parts,
    reason: result.promptFeedback?.blockReason || candidate?.finishReason || 'unknown',
    tokenUsage
  };
}

// Truncation and provider blips usually clear on a second attempt,
// so quietly retry before giving the user bad news.
async function askWithRetries(contents) {
  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= EMPTY_RETRY_ATTEMPTS; attempt++) {
    const out = await callGemini(contents);
    if (out.usableText || out.calls.length) return out;
    lastReason = out.reason;
    console.warn(`Gemini returned an empty response (${lastReason}), attempt ${attempt}/${EMPTY_RETRY_ATTEMPTS}`);
    await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
  }

  throw new Error(`No usable Gemini response (${lastReason})`);
}

// The model has no clock of its own, so every request carries the live
// server date and pre-computed date ranges. This is what lets it answer
// "expiring in the next 90 days" without ever asking the user the date.
function dateContext() {
  const timeZone = process.env.TIMEZONE || 'Australia/Sydney';
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const iso = `${parts.year}-${parts.month}-${parts.day}`;

  const pretty = new Intl.DateTimeFormat('en-AU', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  }).format(now);

  const clock = new Intl.DateTimeFormat('en-AU', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: true
  }).format(now);

  const tzName =
    new Intl.DateTimeFormat('en-AU', { timeZone, timeZoneName: 'short' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';

  const [year, month, day] = iso.split('-').map(Number);
  const midnight = Date.UTC(year, month - 1, day);
  const shift = (days) => new Date(midnight + days * 86400000).toISOString().slice(0, 10);
  const monthOf = (d) =>
    new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);

  const base = new Date(midnight);

  const monthStart = `${iso.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

  const quarterIndex = Math.floor((month - 1) / 3);
  const quarterStart = new Date(Date.UTC(year, quarterIndex * 3, 1));
  const quarterEnd = new Date(Date.UTC(year, quarterIndex * 3 + 3, 0));

  const dow = base.getUTCDay();
  const weekStart = shift(-((dow + 6) % 7));
  const weekEnd = shift(6 - ((dow + 6) % 7));

  const fyStartYear = month >= 7 ? year : year - 1;
  const fyStart = `${fyStartYear}-07-01`;
  const fyEnd = `${fyStartYear + 1}-06-30`;

  return [
    'CURRENT DATE AND TIME - authoritative, updated on every request:',
    `- Today is ${pretty}. Local time ${clock} (${tzName}).`,
    `- Today in YYYY-MM-DD form: ${iso}; tomorrow: ${shift(1)}; yesterday: ${shift(-1)}.`,
    `- "This week": ${weekStart} to ${weekEnd}.`,
    `- "This month": ${monthStart} to ${monthEnd} (${monthOf(base)}).`,
    `- "This quarter": Q${quarterIndex + 1} ${year}, ${quarterStart.toISOString().slice(0, 10)} to ${quarterEnd.toISOString().slice(0, 10)}.`,
    `- "Next 90 days": ${iso} to ${shift(90)}.`,
    `- "This financial year" (Australian, July-June): ${fyStart} to ${fyEnd}.`,
    '- When a question says today, tomorrow, this week/month/quarter/year, last N days, next N days, or names a relative window, convert it into exact YYYY-MM-DD dates yourself from the reference above.',
    '- Never ask the user for the current date - you always know it.'
  ].join('\n');
}

let cachedInstruction = '';
let cachedHour = -1;

function systemInstruction() {
  // rebuild once an hour so long-lived serverless containers stay fresh
  const hourKey = Math.floor(Date.now() / 3600000);
  if (hourKey !== cachedHour || !cachedInstruction) {
    cachedInstruction = `${SYSTEM_PROMPT}\n\n${dateContext()}`;
    cachedHour = hourKey;
  }
  return cachedInstruction;
}

function summarizeToolResult(result) {
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) {
    return {
      count: result.length,
      sample: result.slice(0, 2)
    };
  }
  if (typeof result === 'object') {
    const str = JSON.stringify(result);
    if (str.length > 500) {
      return { keys: Object.keys(result), preview: str.slice(0, 300) + '…' };
    }
    return result;
  }
  if (typeof result === 'string') {
    return result.length > 500 ? result.slice(0, 500) + '…' : result;
  }
  return result;
}

export async function runAgentLoop(messages) {
  // User text goes to the model untouched. Partial ilike matching in the
  // tools handles short forms and typos, so no alias map lives here.
  const contents = messages.map(({ role, content }) => ({
    role: role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof content === 'string' ? content : JSON.stringify(content) }]
  }));

  const toolsUsed = [];
  let totalTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const out = await askWithRetries(contents);

      // Accumulate token usage
      if (out.tokenUsage) {
        totalTokenUsage.promptTokens += out.tokenUsage.promptTokens;
        totalTokenUsage.completionTokens += out.tokenUsage.completionTokens;
        totalTokenUsage.totalTokens += out.tokenUsage.totalTokens;
      }

      if (!out.calls.length) {
        const answer = out.usableText.trim();
        return {
          answer: answer || FALLBACK_REPLY,
          toolsUsed,
          tokenUsage: totalTokenUsage
        };
      }

      contents.push({ role: 'model', parts: out.rawParts });

      const toolResults = await Promise.all(
        out.calls.map(async ({ functionCall }) => {
          const startTime = Date.now();
          const result = await executeTool(functionCall.name, functionCall.args || {});
          const executionTime = Date.now() - startTime;
          
          toolsUsed.push({
            name: functionCall.name,
            input: functionCall.args || {},
            output: summarizeToolResult(result),
            executionTimeMs: executionTime
          });

          return {
            functionResponse: {
              name: functionCall.name,
              ...(functionCall.id ? { id: functionCall.id } : {}),
              response: { result }
            }
          };
        })
      );

      contents.push({ role: 'user', parts: toolResults });
    }

    return {
      answer: FALLBACK_REPLY,
      toolsUsed,
      tokenUsage: totalTokenUsage
    };
  } catch (err) {
    console.error('Agent failed:', err.message);
    return {
      answer: FALLBACK_REPLY,
      toolsUsed,
      tokenUsage: totalTokenUsage
    };
  }
}
