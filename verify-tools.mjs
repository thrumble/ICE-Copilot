// Guards the tool registry.
//
// One malformed function declaration makes Gemini reject the ENTIRE request, so a
// single typo in api/lib/tools.js silently disables every tool and all questions
// fall back to an apology. This catches that class of mistake before deploy, and
// with --live it also proves every tool actually runs against the database.
//
//   node verify-tools.mjs          schema + cross-reference checks (offline)
//   node verify-tools.mjs --live   also executes every tool against the DB

import { readFileSync } from 'node:fs';
import { SUPABASE_TOOLS, executeTool } from './api/lib/tools.js';

const LIVE = process.argv.includes('--live');
const errors = [];
const warnings = [];
const SKIPPED = new Set();

const fail = (tool, message) => errors.push(`${tool}: ${message}`);
const warn = (tool, message) => warnings.push(`${tool}: ${message}`);

// Exactly what the Gemini API rejects, verified against the live endpoint.
const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

// ---------------------------------------------------------------------------
// 1. Every declaration must be individually valid
// ---------------------------------------------------------------------------

if (!Array.isArray(SUPABASE_TOOLS) || SUPABASE_TOOLS.length === 0) {
  errors.push('registry: SUPABASE_TOOLS is empty or not an array');
}

const seen = new Set();

for (const tool of SUPABASE_TOOLS) {
  const id = tool?.name ?? '(unnamed)';

  if (typeof tool.name !== 'string' || !NAME_PATTERN.test(tool.name)) {
    fail(id, `name is not a valid function name (${JSON.stringify(tool.name)})`);
  }
  if (seen.has(tool.name)) {
    fail(id, 'duplicate tool name - Gemini rejects the whole request on duplicates');
  }
  seen.add(tool.name);

  if (typeof tool.description !== 'string' || tool.description.trim() === '') {
    fail(id, 'description is missing or empty');
  } else if (tool.description.length > 1024) {
    warn(id, `description is ${tool.description.length} chars, which is unusually long`);
  }

  const schema = tool.input_schema;
  if (!schema || typeof schema !== 'object') {
    fail(id, 'input_schema is missing');
    continue;
  }
  if (schema.type !== 'object') {
    fail(id, `input_schema.type must be "object", found ${JSON.stringify(schema.type)}`);
  }

  const properties = schema.properties ?? {};
  if (typeof properties !== 'object') {
    fail(id, 'input_schema.properties is not an object');
    continue;
  }

  for (const [param, def] of Object.entries(properties)) {
    if (!def || typeof def !== 'object') {
      fail(id, `param "${param}" is not an object`);
      continue;
    }
    if (!VALID_TYPES.has(def.type)) {
      fail(id, `param "${param}" has type ${JSON.stringify(def.type)}, which Gemini rejects`);
    }
    if (typeof def.description !== 'string' || def.description.trim() === '') {
      warn(id, `param "${param}" has no description, so the model cannot tell when to use it`);
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      fail(id, 'input_schema.required is not an array - Gemini rejects the whole request');
    } else {
      for (const required of schema.required) {
        // The most likely mistake, and the one that 400s every single question.
        if (!Object.prototype.hasOwnProperty.call(properties, required)) {
          fail(id, `required lists "${required}", which is not defined in properties`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The prompt must not name tools that no longer exist
// ---------------------------------------------------------------------------
//
// Checked in one direction only. Naming a tool in the prompt that is not
// registered would mislead the model, but a registered tool the prompt does not
// name is fine - most tools are self-describing.

try {
  const prompt = readFileSync(new URL('./api/lib/systemPrompt.js', import.meta.url), 'utf8');
  const referenced = new Set(prompt.match(/\b(get|count|list|find|create|search|resolve)_[a-z0-9_]+/g) ?? []);
  const toolNames = new Set(SUPABASE_TOOLS.map((t) => t.name));

  for (const name of referenced) {
    if (toolNames.has(name)) continue;
    // Column names also read like tool names. Only flag it if it cannot be one.
    if (/_(date|time|id|code|type|status|name|group|number|count|flag|notes?)$/.test(name)) continue;
    errors.push(`systemPrompt.js names "${name}", which is not a registered tool - the model will try to call it and fail`);
  }
} catch (err) {
  errors.push(`systemPrompt.js could not be read: ${err.message}`);
}

// ---------------------------------------------------------------------------
// 2b. Natural-language guards: no invalid JOINs, resolver must exist
// ---------------------------------------------------------------------------

try {
  const toolsSrc = readFileSync(new URL('./api/lib/tools.js', import.meta.url), 'utf8');
  // Match the bare service_jobs_equipment join key only — created_service_jobs_equipment is valid.
  const hasBadJoin = /(^|[^_a-zA-Z])service_jobs_equipment['"]?\s*:/.test(toolsSrc)
    || /(^|[^_a-zA-Z])service_jobs\.equipment_id\s*=\s*equipment\.id/.test(toolsSrc);
  if (hasBadJoin) {
    errors.push('tools.js defines a "service_jobs_equipment" JOIN on "service_jobs.equipment_id", which does not exist (see Schema.sql service_jobs). Job->machine questions must use scan tools, not a JOIN.');
  }
  if (!SUPABASE_TOOLS.some((t) => t.name === 'resolve_customer')) {
    errors.push('tools.js is missing "resolve_customer" - vague customer references have no resolver');
  }
  // No hard-coded alias maps: partial ilike matching covers short suburb
  // forms, so SUBURB_ALIASES / normalizeSuburb must not exist.
  if (toolsSrc.includes('SUBURB_ALIASES') || toolsSrc.includes('normalizeSuburb')) {
    errors.push('tools.js contains a hard-coded suburb alias map - remove it, partial matching covers short forms');
  }
} catch (err) {
  errors.push(`tools.js could not be read: ${err.message}`);
}

// ---------------------------------------------------------------------------
// 3. With --live, prove every tool actually runs
// ---------------------------------------------------------------------------

if (LIVE) {
  // A value that satisfies every filter, so each column reference is exercised.
  const values = {
    search: 'COFFS', summary: 'INSTALL', identifier: '101459', description_text: 'TAFE',
    text: 'TAFE', trading_name: 'COFFS', registered_name: 'COPY CENTRE', customer_name: 'COFFS',
    name: 'GARY', first_name: 'GARY', surname: 'EVANS', contact_first_name: 'SUSAN',
    contact_surname: 'DOUGLASS', code: 'T&M', email: 'fxbc', phone: '02',
    suburb: 'COFFS HARBOUR', state: 'NSW', postcode: '2450',
    created_after: '2026-01-01', created_before: '2026-12-31', received_after: '2026-01-01',
    received_before: '2026-12-31', received_on: '2026-09-01', completed_after: '2026-01-01',
    completed_before: '2026-12-31', starts_after: '2020-01-01', starts_before: '2026-12-31',
    expiring_after: '2020-01-01', expiring_before: '2030-12-31', after: '2020-01-01',
    before: '2030-12-31', day: '2026-09-01', id: 9207, customer_id: 9207,
    equipment_id: 1002488, contract_id: 1693, branch_id: 1, supplier_id: 518,
    serial_number: '101459', equipment_code: '1011558', equipment_model: 'DW3030',
    equipment_type: 'PRINTER', equipment_module: 'MACHINE', model_group: 'Digital',
    billing_status: 'T&M', agreement_number: '19633', order_number: '19633',
    status: 'Active', job_type: 'Maintenance', days: 30, min_count: 1, limit: 3,
    call_status: 'U'
  };
  const booleans = {
    is_aggregate: true, is_active: true, has_customer_warranty: true,
    has_supplier_warranty: true, is_trade_in: true, is_loan_equipment: true,
    not_completed: true
  };

  // Writes, or reaches a third-party API, so not safe to run blind.
  const skip = new Set(['create_service_job', 'get_service_job_by_id']);
  for (const name of skip) SKIPPED.add(name);
  let executed = 0;

  for (const tool of SUPABASE_TOOLS) {
    if (skip.has(tool.name)) continue;
    const args = {};
    for (const param of Object.keys(tool.input_schema.properties ?? {})) {
      args[param] = values[param] ?? booleans[param] ?? 'a';
    }
    const started = Date.now();
    let result;
    try {
      result = await executeTool(tool.name, args);
    } catch (err) {
      fail(tool.name, `threw instead of returning an error: ${err.message}`);
      continue;
    }
    executed += 1;
    if (result?.error) {
      fail(tool.name, `returned an error: ${String(result.error).slice(0, 160)}`);
    } else if (Date.now() - started > 4000) {
      warn(tool.name, `took ${Date.now() - started}ms`);
    }
  }

  if (executed + skip.size !== SUPABASE_TOOLS.length) {
    fail('live run', `executed ${executed} of ${SUPABASE_TOOLS.length} tools, expected ${SUPABASE_TOOLS.length - skip.size}`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const scope = LIVE ? 'offline + live' : 'offline only';
const skippedNote = LIVE ? `, ${SKIPPED.size} skipped (they write, or call an external API)` : '';

if (warnings.length) {
  console.log(`${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
  console.log('');
}

if (errors.length) {
  console.error(`${errors.length} ERROR(s) across ${SUPABASE_TOOLS.length} tools (${scope}).`);
  console.error('These would break every question, not just one tool:');
  for (const e of errors) console.error(`  x ${e}`);
  process.exit(1);
}

console.log(`${SUPABASE_TOOLS.length} tools checked (${scope})${skippedNote}. No blocking errors - safe to send to Gemini.`);
