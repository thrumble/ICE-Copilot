# FXBC Copilot

Internal AI assistant for FXBC staff. Ask in natural language — with typos, slang and vague references ("my printer in Coffs is down", "Fred's machines", "what's overdue") — about customers, contracts, equipment, service jobs and staff. A Gemini agent queries the live Supabase database and answers with real, traceable figures. No IDs, codes or exact phrasing required.

- **Frontend** — React + Vite + Tailwind (`src/`)
- **API** — Node serverless functions (`api/`) running a Gemini agent loop
- **Data** — Supabase / PostgreSQL, read-only for questions (`supabase/`)

## Quick start

```bash
git clone <repo> && cd FXBC-Copilot
npm install
cp .env.example .env.local    # then fill in the values
```

Run the two processes:

```bash
node api/dev-server.mjs   # local API on http://localhost:8787 (or: npm run api)
npm run dev               # frontend on http://localhost:5173
```

Open http://localhost:5173, sign in with the allowed account, ask a question.

## How the system works

```
Browser (React)
  -> POST /api/chat { message, history, sessionId } + Supabase JWT
  -> api/chat.js: CORS, auth (isAuthorizedRequest), validation
  -> api/lib/agent.js runAgentLoop: rewrite pre-pass -> Gemini generateContent
       <-> function calls -> api/lib/tools.js executeTool (81 tools)
            -> api/lib/supabase.js read-only client -> Supabase Postgres
            -> api/lib/signatureApi.js (only create_service_job / get_service_job_by_id)
  -> answer + tool_usage/token_usage stored to chat_messages
  -> React renders answer, stores session title via /api/title
```

Sync (offline from chat): Supabase Edge Functions in `supabase/Edge Functions/` pull Signature Software (`GET /api/v1/service/...`) and upsert by `id` — see `sync-customers.md`, `sync-equipment.md`, `sync-contracts.md`, etc.

## Request lifecycle

1. Composer in `src/components/ChatPane.jsx` sends text; `src/pages/Workspace.jsx:66 send()` saves the user row first so nothing is lost, then calls `src/lib/api.js askCopilot()`.
2. `api/chat.js` verifies the Supabase JWT belongs to `VITE_ALLOWED_USER_EMAIL` via `api/lib/auth.js`.
3. `api/lib/agent.js runAgentLoop()` rewrites the latest message (`rewriteQuery`: suburb aliases like Coffs → COFFS HARBOUR, hints for "broken printer", "overdue", orders) and calls Gemini (`temperature 0.6`, `maxOutputTokens 8192`, `thinkingBudget 1024` on 2.5 models).
4. Gemini picks tools from `api/lib/tools.js` (81 registered). Vague customer names go through `resolve_customer` first; ambiguous matches are asked back, never guessed. `CURRENT DATE AND TIME` (`dateContext()`, `TIMEZONE`, default `Australia/Sydney`) converts "next 90 days" etc. to exact dates.
5. Tools run on the read-only Supabase client (`api/lib/supabase.js` blocks insert/update/upsert/delete). Every list returns `returned` + `count`; counts are read from `count`.
6. The loop (max 10 iterations, 3 empty-response retries) ends with an answer following the answer pattern: direct answer → figures → 5–10 items → "Showing Y of X" → limits/follow-up. Markdown allowed, no emojis. Missing data is stated as "not recorded in our system" with an alternative offered.
7. `api/chat.js` stores the assistant row with `tool_usage` + `token_usage` (`supabase/migrations/002_usage_tracking.sql`), returns `{ response, storedMessage }`. Titles come from `api/title.js` (6 words max, fallback to truncated message).

## Tool categories (81 total)

| Category | Tools | Notes |
|---|---|---|
| Customers | `resolve_customer`, `get_customers`, `get_customer_by_id`, `find_customers_by_contact_person`, `count_customers`, missing-email/phone, by-state/suburb | Broad `search` preferred for fragments/typos; suburb aliases normalized |
| Contracts | `get_contracts`, `get_contract_by_id`, expired/active/open-ended, `count_contracts` | Open-ended sentinel `0001-01-01` excluded from expiry windows |
| Equipment | `get_equipment`, `get_equipment_by_id`, active/inactive counts, by-model/type/state/suburb/billing, most-equipment, by-customer | `identifier` spans serial/code/model; no install date (use `create_date`) |
| Service jobs | `get_service_jobs`, active/completed/cancelled, unallocated, by-call-status, overdue, snoozed, by-status/type, call-status counts, status reference, dashboard, response times, by-id | Single-letter codes A/C/X + words; no equipment link by design |
| Staff / branches | `get_staff`, `get_staff_by_id`, `count_staff`, recently-added, `get_branches`, `get_branch_by_id`, `count_branches` | Names only; no staff→job link |
| Reference | billing statuses, equipment billing types, equipment types/models (+by-type/group), call types (+active/maintenance/return-to-fit/default/billable/alerting), counts | Placeholders and empty `default_meters` noted in descriptions |
| Summaries | `get_business_summary`, `get_full_database_summary`, `get_customer_profile`, `get_records_created_today`, suburb summary | One-call overviews; orphan customer ids disclosed |
| Signature write path | `create_service_job` (requires `confirmed:true`), `get_service_job_by_id` | Only write path; needs `SIGNATURE_*` env; skipped in `--live` verify |
| Generic | `query_table` (filters, sorting, columns, JOINs), `aggregate_table` (group by, count duplicates, frequency distribution) | Fallback for ad-hoc queries, cross-table analysis, and dynamic aggregations |

## Project structure

```
├── vite.config.js             React plugin + /api proxy to :8787
├── vercel.json                api/chat.js maxDuration 60
├── verify-tools.mjs           Offline schema + prompt/JOIN guards; --live runs every tool
├── DATA_GAPS.md               What is there / what is not, in plain English
├── src/
│   ├── main.jsx               Bootstrap
│   ├── App.jsx                Auth gate — single allowed account
│   ├── pages/Login.jsx        Sign-in (rejects non-allowlisted accounts)
│   ├── pages/Workspace.jsx    Sessions, send flow, title generation
│   ├── components/ChatPane.jsx Thread, natural-language starters, composer
│   ├── components/Sidebar.jsx Session list, filter, account
│   └── lib/supabase.js api.js time.js
├── api/
│   ├── chat.js                Entry: CORS, auth, validation, store + reply
│   ├── title.js               6-word titles + fallback
│   ├── dev-server.mjs         Local :8787 server + .env.local loader
│   └── lib/agent.js           Settings (0.6), rewrite pre-pass, date context, loop
│   └── lib/tools.js           Registry, suburb aliases, resolver, scans, dispatcher
│   └── lib/systemPrompt.js    Natural-language-first behaviour + answer pattern
│   └── lib/auth.js supabase.js signatureApi.js
└── supabase/
    ├── migrations/Schema.sql  Tables: customers, contracts, equipment, service_jobs, staff, branches, reference, chat_*
    ├── migrations/002_usage_tracking.sql  tool_usage/token_usage columns
    └── Edge Functions/*.md   Sync docs + source (customers, equipment, contracts, jobs, staff, types, models, billing, branches)
```

## Environment variables

| Variable | Side | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | browser | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | browser | Public anon key |
| `VITE_ALLOWED_USER_EMAIL` | both | Single authorised account |
| `SUPABASE_URL` | server | Supabase URL (falls back to VITE_ variant) |
| `SUPABASE_SERVICE_KEY` | server | Service-role key (read-only client + auth check) |
| `GEMINI_API_KEY` | server | Google Gemini API key |
| `GEMINI_MODEL` | server | Optional, defaults to `gemini-2.5-flash` |
| `TIMEZONE` | server | Optional IANA zone, defaults to `Australia/Sydney` |
| `SIGNATURE_CLIENT_ID` / `SIGNATURE_CLIENT_SECRET` / `SIGNATURE_PROXY_CLIENT_ID` | server | Only for `create_service_job` via Signature API |
| `ALLOWED_ORIGIN` | server | Optional strict CORS origin (default `*`) |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite frontend |
| `npm run api` / `node api/dev-server.mjs` | Local API on :8787 |
| `node verify-tools.mjs` | Offline checks (schema, prompt refs, JOIN validity, resolver + aliases) |
| `node verify-tools.mjs --live` | Also executes every read tool against Supabase (needs `.env.local`) |
| `npm run build` / `npm run preview` | Production build / preview |
| `npm run deploy` | `vercel --prod` |

## Limits

See **[DATA_GAPS.md](DATA_GAPS.md)** — orders/invoices/payments, job→machine links, pre-window jobs, full fleet history, addresses, real expiries, staff links, meters and supplier names.
