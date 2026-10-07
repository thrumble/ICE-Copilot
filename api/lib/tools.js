import { getReadOnlySupabase } from './supabase.js';
import { createServiceJob as createSignatureServiceJob, getServiceJobById as getSignatureServiceJobById } from './signatureApi.js';


// ---------------------------------------------------------------------------
// Registry-driven read tools.
//
// Every tool declares its name, description, JSON parameters and a run()
// implementation; SUPABASE_TOOLS (for Gemini) and executeTool() are derived
// from the registry. Builders only apply FILTERS - fetchList owns select,
// ordering and limits so supabase-js chaining rules are respected in one place.
//
// Every tool runs on the read-only Supabase client (see supabase.js), which
// throws on insert/update/upsert/delete rather than trusting a convention.
// ---------------------------------------------------------------------------

const OPEN_ENDED_SENTINEL = '0001-01-01T00:00:00';
const DAY_MS = 86400000;

// PostgREST silently caps every response at 1000 rows, so anything that must see
// the whole table has to walk it page by page. Anything that returns rows to the
// model is clamped well below that.
const PAGE_SIZE = 999;
const MAX_PAGES = 50;
const DEFAULT_ROWS = 50;
const MAX_ROWS = 200;

const dayStart = (date) => `${date}T00:00:00`;
const dayEnd = (date) => `${date}T23:59:59`;
const isoToday = () => new Date().toISOString().slice(0, 10);
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

const registry = [];

function reg(spec) {
  registry.push(spec);
}

function str(description) {
  return { type: 'string', description };
}

function num(description) {
  return { type: 'number', description };
}

function bool(description) {
  return { type: 'boolean', description };
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_ROWS;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_ROWS);
}

// ---------------------------------------------------------------------------
// Shared query helpers
// ---------------------------------------------------------------------------

// Walks a whole table. PostgREST truncates any single response at 1000 rows, which
// used to leave every grouped count and leaderboard silently reporting on 30% of
// the equipment table. Returns `truncated` so a capped walk is never mistaken for
// a complete one.
async function fetchAllRows(table, select, applyFilters) {
  const supabase = getReadOnlySupabase();
  const out = [];
  let offset = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    let query = supabase.from(table).select(select);
    if (applyFilters) query = applyFilters(query);
    const { data, error } = await query.range(offset, offset + PAGE_SIZE);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return { rows: out, truncated: false };
    offset += PAGE_SIZE;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows: out, truncated };
}

// PostgREST cannot GROUP BY, so pull one column and tally in memory.
async function groupCount(table, column, applyFilters, { minCount = 1, limit = 25 } = {}) {
  const { rows, truncated } = await fetchAllRows(table, column, applyFilters);

  const tallies = new Map();
  let recorded = 0;
  for (const row of rows) {
    const raw = Object.values(row)[0];
    if (raw === null || raw === undefined || raw === '') continue;
    recorded += 1;
    tallies.set(String(raw), (tallies.get(String(raw)) ?? 0) + 1);
  }

  const groups = [...tallies.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));

  return {
    grouped_by: column,
    total_rows: rows.length,
    rows_with_a_value: recorded,
    rows_without_a_value: rows.length - recorded,
    groups,
    ...(truncated ? { truncated: true, note: 'Row walk hit its safety cap; these groups are incomplete.' } : {})
  };
}

async function topCustomersByForeignKey(foreignTable, fkColumn, { limit = 10 } = {}) {
  const { rows, truncated } = await fetchAllRows(foreignTable, fkColumn);

  const tallies = new Map();
  for (const row of rows) {
    const id = Object.values(row)[0];
    if (id === null || id === undefined) continue;
    tallies.set(String(id), (tallies.get(String(id)) ?? 0) + 1);
  }

  const ranked = [...tallies.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!ranked.length) return { leaders: [], linked_rows: rows.length };

  const { data: customers, error } = await getReadOnlySupabase()
    .from('customers')
    .select('id,trading_name,code')
    .in('id', ranked.map(([id]) => id));
  if (error) throw error;

  const byId = new Map((customers ?? []).map((c) => [String(c.id), c]));
  return {
    leaders: ranked.map(([id, n]) => ({
      customer_id: id,
      trading_name: byId.get(String(id))?.trading_name ?? '(name unavailable)',
      customer_code: byId.get(String(id))?.code ?? null,
      matches: n
    })),
    linked_rows: rows.length,
    // 187 equipment rows point at a customer id that is not in the customers table.
    // Surfacing them stops the leaderboard being presented as a complete total.
    unresolvable_customer_ids: ranked.filter(([id]) => !byId.has(String(id))).map(([id]) => id),
    ...(truncated ? { truncated: true, note: 'Row walk hit its safety cap; this ranking is incomplete.' } : {})
  };
}

// `maybeSingle()` throws when more than one row matches, which made the six
// duplicated customer codes (LIFE03, LIFE04, LIFE05, LIFE06, HEAL01, 000001)
// unqueryable. Fetching two rows distinguishes "missing" from "ambiguous".
async function fetchSingle(table, column, value) {
  const { data, error } = await getReadOnlySupabase()
    .from(table)
    .select('*')
    .eq(column, value)
    .limit(2);
  if (error) throw error;
  if (!data || data.length === 0) return { found: false };
  if (data.length > 1) {
    return {
      found: true,
      multiple_matches: true,
      note: 'More than one record carries this value. Each match is listed separately; do not pick one silently.',
      [table]: data
    };
  }
  return data[0];
}

async function fetchList(table, builder, { limit, columns = '*', orderBy, ascending = true } = {}) {
  const supabase = getReadOnlySupabase();
  let query = builder(supabase.from(table).select(columns, { count: 'exact' }));
  if (orderBy) query = query.order(orderBy, { ascending });
  const { data, error, count } = await query.limit(clampLimit(limit));
  if (error) throw error;
  return { [table]: data ?? [], returned: (data ?? []).length, count };
}

async function countRows(table, applyFilters) {
  const supabase = getReadOnlySupabase();
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (applyFilters) query = applyFilters(query);
  const { count, error } = await query;
  if (error) throw error;
  return { table, count };
}

const expiryGuards = {
  between: (q, after, before) =>
    q.gte('expiry_date', dayStart(after)).lte('expiry_date', dayEnd(before)).neq('expiry_date', OPEN_ENDED_SENTINEL),
  expired: (q) => q.lt('expiry_date', dayStart(isoToday())).neq('expiry_date', OPEN_ENDED_SENTINEL),
  activeFrom: (q) => q.or(`expiry_date.gt.${dayEnd(isoToday())},expiry_date.eq.${OPEN_ENDED_SENTINEL}`)
};

// List queries project only what a list answer needs. An equipment row is 37
// columns, 17 of them permanently empty or constant, and its embedded customer
// snapshot alone is roughly a quarter of the payload - carrying full contact
// details into every list result the model never asked for. The by-id tools keep
// select('*') so nothing is lost when a single record is examined closely.
const CUSTOMER_LIST_COLUMNS = [
  'id', 'code', 'trading_name', 'registered_name', 'email', 'phone',
  'contact_name:contact_person->>firstName', 'contact_surname:contact_person->>surname',
  'suburb:street_address->>suburb', 'state:street_address->>state', 'postcode:street_address->>postCode',
  'created_at'
].join(', ');

const EQUIPMENT_LIST_COLUMNS = [
  'id', 'serial_number', 'equipment_code', 'equipment_description',
  'customer_name:customer->>tradingName', 'customer_code:customer->>code',
  'billing_code:billing_status->>code',
  'type:equipment_type->>description', 'module:equipment_module->>description',
  'model:equipment_model->>description',
  'create_date', 'is_active', 'has_customer_warranty', 'has_supplier_warranty',
  'is_trade_in', 'is_loan_equipment', 'sv_call_ack_option',
  'street_address', 'suburb', 'state', 'post_code', 'supplier_id'
].join(', ');

const SERVICE_JOB_SCAN_COLUMNS = [
  'id', 'job_type', 'summary', 'service_job_status', 'service_call_type',
  'branch', 'customer', 'module', 'billing_status',
  'received_date', 'completed_date', 'down_time', 'response_time',
  'expected_time', 'service_job_calls'
].join(', ');

// ===========================================================================
// CUSTOMERS (8)
// ===========================================================================

reg({
  name: 'get_customers',
  description: 'Search customers in natural language. The broad "search" value matches trading name, registered name, code, email and phone at once - prefer it for vague references, fragments and typos. Addresses are recorded on only a small minority of customers, so address filters match very few rows. Returns returned/count.',
  params: {
    search: str('Any customer reference of unknown type — fragments and typos accepted'),
    trading_name: str('Trading name (partial match)'),
    registered_name: str('Registered legal name (partial match)'),
    code: str('Exact customer code'),
    email: str('Email (partial match)'),
    phone: str('Phone (partial match)'),
    contact_first_name: str('Contact first name from contact_person JSON'),
    contact_surname: str('Contact surname from contact_person JSON'),
    suburb: str('Suburb from street_address JSON - recorded on only a small minority of customers'),
    state: str('State from street_address JSON - recorded on only a small minority of customers'),
    postcode: str('Postcode from street_address JSON - recorded on only a small minority of customers'),
    created_after: str('Created on or after (YYYY-MM-DD)'),
    created_before: str('Created on or before (YYYY-MM-DD)'),
    limit: num(`Max rows in data array (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`)
  },
  async run(i) {
    return fetchList(
      'customers',
      (q) => {
        if (i.search) {
          const v = i.search;
          q = q.or(`trading_name.ilike.%${v}%,registered_name.ilike.%${v}%,code.ilike.%${v}%,email.ilike.%${v}%,phone.ilike.%${v}%`);
        }
        if (i.trading_name) q = q.ilike('trading_name', `%${i.trading_name}%`);
        if (i.registered_name) q = q.ilike('registered_name', `%${i.registered_name}%`);
        if (i.code) q = q.eq('code', i.code);
        if (i.email) q = q.ilike('email', `%${i.email}%`);
        if (i.phone) q = q.ilike('phone', `%${i.phone}%`);
        if (i.contact_first_name) q = q.ilike('contact_person->>firstName', `%${i.contact_first_name}%`);
        if (i.contact_surname) q = q.ilike('contact_person->>surname', `%${i.contact_surname}%`);
        if (i.suburb) q = q.ilike('street_address->>suburb', `%${i.suburb}%`);
        if (i.state) q = q.eq('street_address->>state', i.state);
        if (i.postcode) q = q.ilike('street_address->>postCode', `%${i.postcode}%`);
        if (i.created_after) q = q.gte('created_at', dayStart(i.created_after));
        if (i.created_before) q = q.lte('created_at', dayEnd(i.created_before));
        return q;
      },
      { columns: CUSTOMER_LIST_COLUMNS, orderBy: 'trading_name', limit: i.limit }
    );
  }
});

reg({
  name: 'get_customer_by_id',
  description: 'Fetch one customer by internal ID.',
  params: { id: num('Customer ID') },
  required: ['id'],
  async run(i) {
    return fetchSingle('customers', 'id', i.id);
  }
});

reg({
  name: 'resolve_customer',
  description: 'Resolve a natural-language customer reference (name fragment, code, email, phone, suburb, typo) into candidate customers with IDs. Use this FIRST whenever the user names a customer vaguely instead of guessing an ID. Returns candidates; if several match, ask the user which one.',
  params: {
    search: str('Natural customer reference of any type — fragment, typo and partial names accepted (Required)'),
    limit: num(`Max candidates (default 10, maximum ${MAX_ROWS})`)
  },
  required: ['search'],
  async run(i) {
    const v = String(i.search ?? '').trim();
    if (!v) throw new Error('Provide search');
    const result = await fetchList(
      'customers',
      (q) => {
        q = q.or(`trading_name.ilike.%${v}%,registered_name.ilike.%${v}%,code.ilike.%${v}%,email.ilike.%${v}%,phone.ilike.%${v}%`);
        return q;
      },
      { columns: CUSTOMER_LIST_COLUMNS, orderBy: 'trading_name', limit: Math.min(Number(i.limit) || 10, MAX_ROWS) }
    );
    return {
      ...result,
      ambiguous: (result.count ?? result.returned) > 1,
      note: (result.count ?? result.returned) > 1
        ? 'Several customers match. Present the candidates and ask which one is meant. Do not pick one silently.'
        : undefined
    };
  }
});

reg({
  name: 'find_customers_by_contact_person',
  description: 'Find customers by the name held in their contact person record. A few customer codes are shared by two different customers each, so a code match can be ambiguous.',
  params: {
    code: str('Exact customer code'),
    first_name: str('Contact first name (partial)'),
    surname: str('Contact surname (partial)'),
    limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`)
  },
  async run(i) {
    if (!i.code && !i.first_name && !i.surname) throw new Error('Provide code, first_name or surname');
    return fetchList(
      'customers',
      (q) => {
        if (i.code) q = q.eq('code', i.code);
        if (i.first_name) q = q.ilike('contact_person->>firstName', `%${i.first_name}%`);
        if (i.surname) q = q.ilike('contact_person->>surname', `%${i.surname}%`);
        return q;
      },
      { columns: CUSTOMER_LIST_COLUMNS, orderBy: 'trading_name', limit: i.limit }
    );
  }
});

reg({
  name: 'count_customers',
  description: 'Total number of customers on record.',
  params: {},
  async run() {
    return countRows('customers');
  }
});

reg({
  name: 'get_customers_missing_email',
  description: 'Customers with no email recorded.',
  params: { limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`) },
  async run(i) {
    return fetchList('customers', (q) => q.or('email.is.null,email.eq.""'), { columns: CUSTOMER_LIST_COLUMNS, orderBy: 'trading_name', limit: i.limit });
  }
});

reg({
  name: 'get_customers_missing_phone',
  description: 'Customers with no phone recorded.',
  params: { limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`) },
  async run(i) {
    return fetchList('customers', (q) => q.or('phone.is.null,phone.eq.""'), { columns: CUSTOMER_LIST_COLUMNS, orderBy: 'trading_name', limit: i.limit });
  }
});

reg({
  name: 'count_customers_by_state',
  description: 'Customer totals grouped by state. Only a small minority of customers have an address recorded, so most customers are uncounted here - always report rows_with_a_value alongside the groups.',
  params: { limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('customers', 'street_address->>state', null, { limit: i.limit });
  }
});

reg({
  name: 'count_customers_by_suburb',
  description: 'Customer totals grouped by suburb. Only a small minority of customers have an address recorded, so most customers are uncounted here - always report rows_with_a_value alongside the groups.',
  params: { min_count: num('Only suburbs with at least this many customers (default 1)'), limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('customers', 'street_address->>suburb', null, { minCount: i.min_count ?? 1, limit: i.limit });
  }
});

// ===========================================================================
// CONTRACTS (6)
// ===========================================================================

reg({
  name: 'get_contracts',
  description: 'Search contracts with flexible filters. Expiry windows exclude open-ended sentinel dates automatically. Most contracts carry the open-ended marker instead of a real expiry date, and a few reference a customer id that is not in the customer records. Returns returned/count.',
  params: {
    agreement_number: str('Agreement number (partial)'),
    customer_id: num('Customer ID (inferred link, not enforced)'),
    is_aggregate: bool('Aggregate agreement flag'),
    starts_after: str('Starts on or after (YYYY-MM-DD)'),
    starts_before: str('Starts on or before (YYYY-MM-DD)'),
    expiring_after: str('Expires on or after (YYYY-MM-DD); excludes open-ended'),
    expiring_before: str('Expires on or before (YYYY-MM-DD); excludes open-ended'),
    limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`)
  },
  async run(i) {
    return fetchList(
      'contracts',
      (q) => {
        if (i.agreement_number) q = q.ilike('agreement_number', `%${i.agreement_number}%`);
        if (i.customer_id) q = q.eq('customer_id', i.customer_id);
        if (typeof i.is_aggregate === 'boolean') q = q.eq('is_aggregate', i.is_aggregate);
        if (i.starts_after) q = q.gte('start_date', dayStart(i.starts_after));
        if (i.starts_before) q = q.lte('start_date', dayEnd(i.starts_before));
        if (i.expiring_after && i.expiring_before) q = expiryGuards.between(q, i.expiring_after, i.expiring_before);
        else if (i.expiring_after) q = expiryGuards.between(q, i.expiring_after, '2999-12-31');
        else if (i.expiring_before) q = q.lte('expiry_date', dayEnd(i.expiring_before)).neq('expiry_date', OPEN_ENDED_SENTINEL);
        return q;
      },
      { orderBy: 'start_date', ascending: false, limit: i.limit }
    );
  }
});

reg({
  name: 'get_contract_by_id',
  description: 'Fetch one contract by ID.',
  params: { id: num('Contract ID') },
  required: ['id'],
  async run(i) {
    return fetchSingle('contracts', 'id', i.id);
  }
});

reg({
  name: 'get_expired_contracts',
  description: 'Contracts whose expiry date has already passed. Only a handful of contracts carry a real expiry date, so expect a very short list.',
  params: { limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`) },
  async run(i) {
    return fetchList('contracts', (q) => expiryGuards.expired(q), { orderBy: 'expiry_date', limit: i.limit });
  }
});

reg({
  name: 'get_active_contracts',
  description: 'Contracts not yet expired, including open-ended ones. Most contracts are open-ended.',
  params: { limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`) },
  async run(i) {
    return fetchList('contracts', (q) => expiryGuards.activeFrom(q), { orderBy: 'expiry_date', limit: i.limit });
  }
});

reg({
  name: 'get_open_ended_contracts',
  description: 'Contracts carrying the open-ended/unknown expiry marker instead of a real date.',
  params: { limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`) },
  async run(i) {
    return fetchList('contracts', (q) => q.eq('expiry_date', OPEN_ENDED_SENTINEL), { orderBy: 'start_date', ascending: false, limit: i.limit });
  }
});

reg({
  name: 'count_contracts',
  description: 'Total number of contracts.',
  params: {},
  async run() {
    return countRows('contracts');
  }
});

// ===========================================================================
// EQUIPMENT (12)
// ===========================================================================

const EQUIPMENT_FLAGS = ['has_customer_warranty', 'has_supplier_warranty', 'is_trade_in', 'is_loan_equipment'];

reg({
  name: 'get_equipment',
  description: 'Broad equipment search in natural language. The broad "identifier" value matches serial number, equipment code and model description together — use it for vague references and typos. If the user names a customer vaguely, call resolve_customer first. There is no install date on record for any machine - use create_date for date questions. Returns returned/count.',
  params: {
    identifier: str('Unknown-type identifier matched across serial, code and model'),
    serial_number: str('Serial (partial)'),
    equipment_code: str('Equipment code (partial)'),
    customer_id: num('Customer ID from embedded customer JSON'),
    customer_name: str('Customer trading name from embedded JSON'),
    equipment_type: str('Type description (partial)'),
    equipment_model: str('Model description (partial)'),
    equipment_module: str('Module description (partial)'),
    billing_status: str('Billing status code e.g. T&M'),
    supplier_id: num('Supplier ID'),
    description_text: str('Text within the free-text equipment description'),
    suburb: str('Install location suburb'),
    state: str('Install location state - machines are almost all in NSW, with a handful elsewhere'),
    postcode: str('Install location postcode'),
    created_after: str('Created on or after (YYYY-MM-DD)'),
    created_before: str('Created on or before (YYYY-MM-DD)'),
    has_customer_warranty: bool('Filter'),
    has_supplier_warranty: bool('Filter'),
    is_trade_in: bool('Filter'),
    is_loan_equipment: bool('Filter'),
    is_active: bool('Active flag'),
    limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`)
  },
  async run(i) {
    return fetchList(
      'equipment',
      (q) => {
        if (i.identifier) {
          const v = i.identifier;
          q = q.or(`serial_number.ilike.%${v}%,equipment_code.ilike.%${v}%,equipment_model->>description.ilike.%${v}%`);
        }
        if (i.serial_number) q = q.ilike('serial_number', `%${i.serial_number}%`);
        if (i.equipment_code) q = q.ilike('equipment_code', `%${i.equipment_code}%`);
        if (i.customer_id) q = q.eq('customer->>id', String(i.customer_id));
        if (i.customer_name) q = q.ilike('customer->>tradingName', `%${i.customer_name}%`);
        if (i.equipment_type) q = q.ilike('equipment_type->>description', `%${i.equipment_type}%`);
        if (i.equipment_model) q = q.ilike('equipment_model->>description', `%${i.equipment_model}%`);
        if (i.equipment_module) q = q.ilike('equipment_module->>description', `%${i.equipment_module}%`);
        if (i.billing_status) q = q.ilike('billing_status->>code', `%${i.billing_status}%`);
        if (i.supplier_id) q = q.eq('supplier_id', i.supplier_id);
        if (i.description_text) q = q.ilike('equipment_description', `%${i.description_text}%`);
        if (i.suburb) q = q.ilike('suburb', `%${i.suburb}%`);
        if (i.state) q = q.eq('state', i.state);
        if (i.postcode) q = q.ilike('post_code', `%${i.postcode}%`);
        if (i.created_after) q = q.gte('create_date', dayStart(i.created_after));
        if (i.created_before) q = q.lte('create_date', dayEnd(i.created_before));
        for (const flag of EQUIPMENT_FLAGS) {
          if (typeof i[flag] === 'boolean') q = q.eq(flag, i[flag]);
        }
        if (typeof i.is_active === 'boolean') q = q.eq('is_active', i.is_active);
        return q;
      },
      { columns: EQUIPMENT_LIST_COLUMNS, orderBy: 'create_date', ascending: false, limit: i.limit }
    );
  }
});

reg({
  name: 'get_equipment_by_id',
  description: 'Fetch one machine by internal ID, including its full embedded customer record.',
  params: { id: num('Equipment ID') },
  required: ['id'],
  async run(i) {
    return fetchSingle('equipment', 'id', i.id);
  }
});

reg({
  name: 'count_equipment',
  description: 'Total machines on record.',
  params: {},
  async run() {
    return countRows('equipment');
  }
});

reg({
  name: 'count_active_equipment',
  description: 'Machines currently flagged active.',
  params: {},
  async run() {
    return countRows('equipment', (q) => q.eq('is_active', true));
  }
});

reg({
  name: 'count_inactive_equipment',
  description: 'Machines currently flagged inactive.',
  params: {},
  async run() {
    return countRows('equipment', (q) => q.eq('is_active', false));
  }
});

reg({
  name: 'count_equipment_by_model',
  description: 'Machine totals grouped by model description.',
  params: { limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('equipment', 'equipment_model->>description', null, { limit: i.limit });
  }
});

reg({
  name: 'count_equipment_by_type',
  description: 'Machine totals grouped by equipment type.',
  params: { limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('equipment', 'equipment_type->>description', null, { limit: i.limit });
  }
});

reg({
  name: 'count_equipment_by_state',
  description: 'Machine totals grouped by install-location state. Machines are almost all in NSW.',
  params: { limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('equipment', 'state', null, { limit: i.limit });
  }
});

reg({
  name: 'count_equipment_by_suburb',
  description: 'Machine totals grouped by install-location suburb.',
  params: { min_count: num('Minimum group size (default 1)'), limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('equipment', 'suburb', null, { minCount: i.min_count ?? 1, limit: i.limit });
  }
});

reg({
  name: 'count_equipment_by_billing_status',
  description: 'Machine totals grouped by billing status code.',
  params: { limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('equipment', 'billing_status->>code', null, { limit: i.limit });
  }
});

reg({
  name: 'count_duplicate_serial_numbers',
  description: 'Finds serial numbers that are assigned to two or more machines (duplicate or shared serial numbers) across the equipment records. Returns the total count of duplicate serial numbers and lists the serial numbers with how many machines share each.',
  params: {
    min_machines: num('Minimum machines sharing the same serial number (default 2)'),
    limit: num('Maximum serial numbers to list (default 25)')
  },
  async run(i) {
    const minCount = Math.max(2, i.min_machines ?? 2);
    const limit = Math.min(100, i.limit ?? 25);
    const res = await groupCount('equipment', 'serial_number', null, { minCount, limit: 1000 });
    const duplicateGroups = res.groups.filter((g) => g.count >= minCount);
    return {
      total_duplicate_serial_numbers: duplicateGroups.length,
      minimum_machines_filter: minCount,
      duplicates: duplicateGroups.slice(0, limit),
      note: `There are ${duplicateGroups.length} serial numbers associated with ${minCount} or more machines.`
    };
  }
});

reg({
  name: 'get_customers_with_most_equipment',
  description: 'Customers ranked by how many machines reference them. Some machines point at a customer id that is not in the customer records; unresolvable_customer_ids lists the ones appearing in this ranking.',
  params: { limit: num('Top N (default 10)') },
  async run(i) {
    return topCustomersByForeignKey('equipment', 'customer->>id', { limit: i.limit });
  }
});

// ===========================================================================
// STAFF (4)
// ===========================================================================

const REFERENCE_CACHE_TTL_MS = 10 * 60 * 1000;
let staffCache = null;

async function getCachedStaff() {
  if (staffCache && staffCache.expiresAt > Date.now()) {
    return staffCache.data;
  }
  const { data, error } = await getReadOnlySupabase().from('staff_members').select('*').order('surname');
  if (error) throw error;
  staffCache = { data, expiresAt: Date.now() + REFERENCE_CACHE_TTL_MS };
  return data;
}

reg({
  name: 'get_staff',
  description: 'List the 10 staff members, optionally filtered by a first-name or surname fragment. There is no reliable link from staff to customers, contracts or machines.',
  params: { name: str('First name or surname (partial)') },
  async run(i) {
    const list = await getCachedStaff();
    let out = list;
    if (i.name) {
      const needle = i.name.toLowerCase();
      out = list.filter((s) => s.first_name?.toLowerCase().includes(needle) || s.surname?.toLowerCase().includes(needle));
    }
    return { staff: out, returned: out.length, count: out.length };
  }
});

reg({
  name: 'get_staff_by_id',
  description: 'Fetch one staff member by ID.',
  params: { id: num('Staff ID') },
  required: ['id'],
  async run(i) {
    const match = (await getCachedStaff()).find((s) => s.id === i.id);
    return match ?? { found: false };
  }
});

reg({
  name: 'count_staff',
  description: 'Total staff members.',
  params: {},
  async run() {
    return countRows('staff_members');
  }
});

reg({
  name: 'get_recently_added_staff',
  description: 'Staff records created in the last N days (default 90).',
  params: { days: num('Look-back window (default 90)') },
  async run(i) {
    const cutoff = isoDaysAgo(i.days || 90);
    const staff = (await getCachedStaff()).filter((s) => s.created_at >= cutoff);
    return { staff, count: staff.length };
  }
});

// ===========================================================================
// BRANCHES (3)
// ===========================================================================

reg({
  name: 'get_branches',
  description: 'List the two branch records, optionally filtered by description.',
  params: { description: str('Branch description (partial)'), limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`) },
  async run(i) {
    return fetchList('branches', (q) => (i.description ? q.ilike('description', `%${i.description}%`) : q), { orderBy: 'description', limit: i.limit });
  }
});

reg({
  name: 'get_branch_by_id',
  description: 'Fetch one branch by ID.',
  params: { id: num('Branch ID') },
  required: ['id'],
  async run(i) {
    return fetchSingle('branches', 'id', i.id);
  }
});

reg({
  name: 'count_branches',
  description: 'Total branch records.',
  params: {},
  async run() {
    return countRows('branches');
  }
});

// ===========================================================================
// REFERENCE DATA (22)
// ===========================================================================

reg({
  name: 'list_billing_statuses',
  description: 'Lookup list of customer billing statuses (code + description).',
  params: {},
  async run() {
    return fetchList('billing_status', (q) => q, { orderBy: 'code', limit: 200 });
  }
});

reg({
  name: 'find_billing_status_by_code',
  description: 'One billing status by exact code.',
  params: { code: str('Exact code, e.g. T&M') },
  required: ['code'],
  async run(i) {
    return fetchSingle('billing_status', 'code', i.code);
  }
});

reg({
  name: 'list_equipment_billing_types',
  description: 'Lookup list of equipment billing types.',
  params: {},
  async run() {
    return fetchList('equipment_billing_type', (q) => q, { orderBy: 'code', limit: 200 });
  }
});

reg({
  name: 'find_equipment_billing_type_by_code',
  description: 'One equipment billing type by exact code.',
  params: { code: str('Exact code') },
  required: ['code'],
  async run(i) {
    return fetchSingle('equipment_billing_type', 'code', i.code);
  }
});

reg({
  name: 'list_equipment_types',
  description: 'Lookup list of equipment types. Two entries are placeholders: "(None)" and "zzUNALLOCATEDzz".',
  params: { description: str('Description filter (partial)'), limit: num('Max rows (default 100)') },
  async run(i) {
    return fetchList('equipment_types', (q) => (i.description ? q.ilike('description', `%${i.description}%`) : q), { orderBy: 'description', limit: i.limit });
  }
});

reg({
  name: 'get_equipment_type_by_id',
  description: 'One equipment type by ID.',
  params: { id: num('Type ID') },
  required: ['id'],
  async run(i) {
    return fetchSingle('equipment_types', 'id', i.id);
  }
});

reg({
  name: 'count_equipment_types',
  description: 'Total equipment types configured.',
  params: {},
  async run() {
    return countRows('equipment_types');
  }
});

reg({
  name: 'list_equipment_models',
  description: 'Catalogue of equipment models with their embedded type and group snapshots.',
  params: { description: str('Model description (partial)'), limit: num('Max rows (default 100)') },
  async run(i) {
    return fetchList('equipment_models', (q) => (i.description ? q.ilike('description', `%${i.description}%`) : q), { orderBy: 'description', limit: i.limit });
  }
});

reg({
  name: 'get_equipment_model_by_id',
  description: 'One model by ID. Note that default_meters is empty on every model in the catalogue.',
  params: { id: num('Model ID') },
  required: ['id'],
  async run(i) {
    return fetchSingle('equipment_models', 'id', i.id);
  }
});

reg({
  name: 'get_models_by_equipment_type',
  description: 'Models whose embedded equipment_type snapshot matches a type description.',
  params: { equipment_type: str('Type description (partial)'), limit: num('Max rows (default 100)') },
  required: ['equipment_type'],
  async run(i) {
    return fetchList('equipment_models', (q) => q.ilike('equipment_type->>description', `%${i.equipment_type}%`), { orderBy: 'description', limit: i.limit ?? 100 });
  }
});

reg({
  name: 'get_models_by_model_group',
  description: 'Models whose embedded model_group snapshot matches a group description.',
  params: { model_group: str('Group description (partial)'), limit: num('Max rows (default 100)') },
  required: ['model_group'],
  async run(i) {
    return fetchList('equipment_models', (q) => q.ilike('model_group->>description', `%${i.model_group}%`), { orderBy: 'description', limit: i.limit ?? 100 });
  }
});

reg({
  name: 'count_equipment_models',
  description: 'Total models in the catalogue.',
  params: {},
  async run() {
    return countRows('equipment_models');
  }
});

reg({
  name: 'count_models_by_equipment_type',
  description: 'Catalogue size grouped by embedded equipment type description.',
  params: { limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('equipment_models', 'equipment_type->>description', null, { limit: i.limit });
  }
});

reg({
  name: 'list_service_call_types',
  description: 'Full catalogue of service call types with all behaviour flags. Two entries have no code recorded and cannot be looked up by code.',
  params: { description: str('Description filter (partial)'), limit: num('Max rows (default 100)') },
  async run(i) {
    return fetchList('service_call_types', (q) => (i.description ? q.ilike('description', `%${i.description}%`) : q), { orderBy: 'description', limit: i.limit ?? 100 });
  }
});

reg({
  name: 'get_service_call_type_by_id',
  description: 'One service call type by ID.',
  params: { id: num('Call type ID') },
  required: ['id'],
  async run(i) {
    return fetchSingle('service_call_types', 'id', i.id);
  }
});

reg({
  name: 'get_service_call_type_by_code',
  description: 'One service call type by exact code. Two catalogue entries have no code and will not be found this way.',
  params: { code: str('Exact code') },
  required: ['code'],
  async run(i) {
    return fetchSingle('service_call_types', 'code', i.code);
  }
});

reg({
  name: 'get_active_service_call_types',
  description: 'Service call types flagged active.',
  params: {},
  async run() {
    return fetchList('service_call_types', (q) => q.eq('is_active', true), { orderBy: 'description', limit: 200 });
  }
});

reg({
  name: 'get_maintenance_call_types',
  description: 'Service call types flagged as maintenance.',
  params: {},
  async run() {
    return fetchList('service_call_types', (q) => q.eq('is_maintenance_type', true), { orderBy: 'description', limit: 200 });
  }
});

reg({
  name: 'get_return_to_fit_call_types',
  description: 'Service call types flagged as return-to-fit.',
  params: {},
  async run() {
    return fetchList('service_call_types', (q) => q.eq('is_return_to_fit_type', true), { orderBy: 'description', limit: 200 });
  }
});

reg({
  name: 'get_default_service_call_type',
  description: 'The call type(s) marked as the default.',
  params: {},
  async run() {
    return fetchList('service_call_types', (q) => q.eq('is_default_call_type', true), { orderBy: 'description', limit: 20 });
  }
});

reg({
  name: 'get_billable_call_out_types',
  description: 'Call types configured to bill a call-out fee.',
  params: {},
  async run() {
    return fetchList('service_call_types', (q) => q.eq('should_bill_call_out', true), { orderBy: 'description', limit: 200 });
  }
});

reg({
  name: 'get_call_types_alerting_on_excessive_calls',
  description: 'Call types configured to raise alerts when call volume is excessive.',
  params: {},
  async run() {
    return fetchList('service_call_types', (q) => q.eq('should_alert_on_excessive_call', true), { orderBy: 'description', limit: 200 });
  }
});

reg({
  name: 'count_service_call_types',
  description: 'Total service call types configured.',
  params: {},
  async run() {
    return countRows('service_call_types');
  }
});

// ===========================================================================
// SERVICE JOBS (SUPABASE RECORDS) (14)
// ===========================================================================

// Single-letter business codes recorded against every job. Verified present in
// the data: A, C, X. Anything else must be shown as-is, never interpreted.
const SERVICE_JOB_STATUS_CODES = { A: 'Active', C: 'Completed', X: 'Cancelled' };

// Call-level codes observed in the nested call array. Only U is documented;
// W and V each appear once and their business meaning is unknown.
const SERVICE_JOB_CALL_STATUS_CODES = { U: 'Unallocated' };

const JOB_STATUS_ALIASES = {
  a: 'A', active: 'A', open: 'A', current: 'A', live: 'A', pending: 'A', 'in progress': 'A',
  x: 'X', cancelled: 'X', canceled: 'X', void: 'X', voided: 'X',
  c: 'C', completed: 'C', complete: 'C', closed: 'C', done: 'C', finished: 'C'
};

const CALL_STATUS_ALIASES = {
  u: 'U', unallocated: 'U', unalloc: 'U', unassigned: 'U',
  a: 'A', active: 'A', open: 'A',
  c: 'C', completed: 'C', complete: 'C', closed: 'C',
  x: 'X', cancelled: 'X', canceled: 'X'
};

// The model should be able to say "cancelled" and still get the right letter.
function resolveJobStatus(value) {
  if (value === null || value === undefined || value === '') return null;
  const key = String(value).trim().toLowerCase();
  return JOB_STATUS_ALIASES[key] ?? String(value).trim().toUpperCase();
}

// Call statuses are resolved from the stored letter; a word is only accepted when
// it maps unambiguously onto one of the codes actually present in the data.
function resolveCallStatus(value) {
  if (value === null || value === undefined || value === '') return null;
  const key = String(value).trim().toLowerCase();
  return CALL_STATUS_ALIASES[key] ?? String(value).trim().toUpperCase();
}

// Some rows arrive with the JSONB still serialised as a string rather than an
// object, so both shapes have to be tolerated.
function parseJsonish(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function labelOrNull(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj.description ?? obj.code ?? obj.id ?? null;
}

function describeCall(call) {
  const c = parseJsonish(call) ?? {};
  const status = parseJsonish(c.callStatus);
  return {
    call_id: c.id ?? null,
    fault: c.fault ?? null,
    call_status_code: status?.code ?? null,
    call_status: status?.description ?? null,
    technician: c.technician ?? null,
    booking_date: c.bookingDate ?? null,
    due_date: c.dueDate ?? null,
    urgency_date: c.urgencyDate ?? null,
    snooze_date: c.snoozeDate ?? null,
    received_date: c.receivedDate ?? null,
    completed_date: c.completedDate ?? null,
    expected_time: c.expectedTime ?? null,
    down_time: c.downTime ?? null,
    invoice_notes: c.invoiceNotes ?? null,
    carry_over_notes: c.carryOverNotes ?? null
  };
}

// 232 of 1367 jobs hold more than one call, so any question about a call has to
// look at every element - not just the first.
function jobCalls(row) {
  const raw = row.service_job_calls;
  const calls = Array.isArray(raw) ? raw : parseJsonish(raw);
  return Array.isArray(calls) ? calls.map(describeCall) : [];
}

// The nested call array is by far the heaviest thing a job carries, so list
// results keep the fields that identify and date each call and drop the internal
// note text. The by-id tool returns every field.
function trimCall(call) {
  return {
    call_id: call.call_id,
    fault: call.fault,
    call_status_code: call.call_status_code,
    call_status: call.call_status,
    technician: call.technician,
    due_date: call.due_date,
    urgency_date: call.urgency_date,
    snooze_date: call.snooze_date,
    completed_date: call.completed_date
  };
}

function shapeServiceJob(row, { compact = false } = {}) {
  const status = parseJsonish(row.service_job_status);
  const calls = jobCalls(row);
  return {
    id: row.id,
    job_type: row.job_type ?? null,
    summary: row.summary ?? null,
    status_code: status?.code ?? null,
    status: status?.description ?? (status?.code ? SERVICE_JOB_STATUS_CODES[status.code] ?? null : null),
    received_date: row.received_date ?? null,
    completed_date: row.completed_date ?? null,
    response_time: row.response_time ?? null,
    expected_time: row.expected_time ?? null,
    down_time: row.down_time ?? null,
    branch: labelOrNull(parseJsonish(row.branch)),
    customer: labelOrNull(parseJsonish(row.customer)),
    module: labelOrNull(parseJsonish(row.module)),
    call_type: labelOrNull(parseJsonish(row.service_call_type)),
    billing_status: labelOrNull(parseJsonish(row.billing_status)),
    call_count: calls.length,
    unallocated_call_count: calls.filter((c) => c.call_status_code === 'U').length,
    calls: compact ? calls.map(trimCall) : calls
  };
}

// Times are stored as text, sometimes with a day prefix (2.21:38:00).
function durationToSeconds(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).trim().match(/^(?:(\d+)\.)?(\d{1,3}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 86400 + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

function formatDuration(seconds) {
  if (seconds === null) return null;
  const total = Math.round(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const clock = [hours, minutes, secs].map((n) => String(n).padStart(2, '0')).join(':');
  return days > 0 ? `${days}.${clock}` : clock;
}

function applyServiceJobFilters(query, i) {
  const statusCode = resolveJobStatus(i.status);
  if (statusCode) query = query.ilike('service_job_status->>code', statusCode);
  if (i.job_type) query = query.ilike('job_type', `%${i.job_type}%`);
  if (i.summary) query = query.ilike('summary', `%${i.summary}%`);
  if (i.search) query = query.or(`summary.ilike.%${i.search}%,job_type.ilike.%${i.search}%`);
  if (i.received_on) {
    query = query.gte('received_date', dayStart(i.received_on)).lte('received_date', dayEnd(i.received_on));
  }
  if (i.received_after) query = query.gte('received_date', dayStart(i.received_after));
  if (i.received_before) query = query.lte('received_date', dayEnd(i.received_before));
  if (i.completed_after) query = query.gte('completed_date', dayStart(i.completed_after));
  if (i.completed_before) query = query.lte('completed_date', dayEnd(i.completed_before));
  if (i.not_completed) query = query.is('completed_date', null);
  return query;
}

// Walks every job so predicates can inspect each job's calls. The call-level
// tallies are gathered on the same pass, because re-walking 1367 jobs three
// times over for three different summaries is pure waste.
async function scanServiceJobs(predicate) {
  const supabase = getReadOnlySupabase();
  const matches = [];
  const callStatusTallies = new Map();
  const responseSamples = [];
  let scanned = 0;
  let calls = 0;
  let jobsWithUnallocated = 0;
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from('service_jobs')
      .select(SERVICE_JOB_SCAN_COLUMNS)
      .order('received_date', { ascending: false })
      .range(offset, offset + PAGE_SIZE);
    if (error) throw error;

    for (const row of data ?? []) {
      scanned += 1;
      const shaped = shapeServiceJob(row, { compact: true });
      calls += shaped.call_count;
      if (shaped.unallocated_call_count > 0) jobsWithUnallocated += 1;
      for (const call of shaped.calls) {
        const key = call.call_status_code ?? '(not recorded)';
        callStatusTallies.set(key, (callStatusTallies.get(key) ?? 0) + 1);
      }
      const seconds = durationToSeconds(shaped.response_time);
      if (seconds !== null) responseSamples.push(seconds);
      if (predicate(shaped, shaped.calls)) matches.push(shaped);
    }

    if (!data || data.length < PAGE_SIZE) {
      return { matches, scanned, calls, jobsWithUnallocated, callStatusTallies, responseSamples, truncated: false };
    }
    offset += PAGE_SIZE;
  }
  return { matches, scanned, calls, jobsWithUnallocated, callStatusTallies, responseSamples, truncated: true };
}

const SERVICE_JOB_WINDOW_PARAMS = {
  received_after: str('Received on or after (YYYY-MM-DD)'),
  received_before: str('Received on or before (YYYY-MM-DD)'),
  received_on: str('Received on exactly this date (YYYY-MM-DD)'),
  limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`)
};

reg({
  name: 'get_service_jobs',
  description: 'Search recorded service jobs in natural language. Status accepts letter or word: A/Active, C/Completed, X/Cancelled. Jobs carry no equipment link and customer/branch/billing are rarely recorded — say so when the machine is asked for. Returns returned/count.',
  params: {
    search: str('Text within the job summary, or a job type'),
    summary: str('Text within the job summary (partial)'),
    status: str('Job status - A/Active, C/Completed or X/Cancelled'),
    job_type: str('Job type, e.g. Maintenance or Install'),
    ...SERVICE_JOB_WINDOW_PARAMS,
    completed_after: str('Completed on or after (YYYY-MM-DD)'),
    completed_before: str('Completed on or before (YYYY-MM-DD)'),
    not_completed: bool('Only jobs with no completion date')
  },
  async run(i) {
    const supabase = getReadOnlySupabase();
    const query = supabase.from('service_jobs').select(SERVICE_JOB_SCAN_COLUMNS, { count: 'exact' });
    const { data, error, count } = await applyServiceJobFilters(query, i)
      .order('received_date', { ascending: false })
      .limit(clampLimit(i.limit));
    if (error) throw error;
    const shaped = (data ?? []).map((row) => shapeServiceJob(row, { compact: true }));
    return { service_jobs: shaped, returned: shaped.length, count };
  }
});

reg({
  name: 'get_service_job_record_by_id',
  description: 'Fetch one recorded service job by its ID, with every call listed in full and each call status decoded.',
  params: { id: num('Service job ID') },
  required: ['id'],
  async run(i) {
    const { data, error } = await getReadOnlySupabase()
      .from('service_jobs')
      .select(SERVICE_JOB_SCAN_COLUMNS)
      .eq('id', i.id)
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return { found: false };
    return { found: true, service_job: shapeServiceJob(data[0]) };  }
});

for (const [code, label] of Object.entries(SERVICE_JOB_STATUS_CODES)) {
  const key = label.toLowerCase();
  reg({
    name: `get_${key}_service_jobs`,
    description: `Service jobs with status code ${code} (${label}).`,
    params: { ...SERVICE_JOB_WINDOW_PARAMS },
    async run(i) {
      const supabase = getReadOnlySupabase();
      const { data, error, count } = await applyServiceJobFilters(supabase.from('service_jobs').select(SERVICE_JOB_SCAN_COLUMNS, { count: 'exact' }), { status: code })
        .order('received_date', { ascending: false })
        .limit(clampLimit(i.limit));
      if (error) throw error;
      const shaped = (data ?? []).map((row) => shapeServiceJob(row, { compact: true }));
      return { service_jobs: shaped, returned: shaped.length, count };
    }
  });
}

reg({
  name: 'get_unallocated_service_jobs',
  description: 'Service jobs holding at least one unallocated call - a call with no technician assigned. Checks every call on every job, including jobs with several calls.',
  params: { ...SERVICE_JOB_WINDOW_PARAMS },
  async run(i) {
    const { matches, scanned } = await scanServiceJobs((job) => job.unallocated_call_count > 0);
    const capped = matches.slice(0, clampLimit(i.limit));
    return { service_jobs: capped, returned: capped.length, matched: matches.length, jobs_scanned: scanned };
  }
});

reg({
  name: 'get_service_jobs_with_call_status',
  description: 'Service jobs holding at least one call in a given call status. Pass a letter such as U, or a word such as unallocated. Call statuses are separate from job statuses. Checks every call on every job. W and V exist in the data but their meaning is not documented.',
  params: {
    call_status: str('Call status letter or word, e.g. U or unallocated (Required)'),
    ...SERVICE_JOB_WINDOW_PARAMS
  },
  required: ['call_status'],
  async run(i) {
    const code = resolveCallStatus(i.call_status);
    const { matches, scanned } = await scanServiceJobs((job, calls) =>
      calls.some((c) => c.call_status_code === code)
    );
    const capped = matches.slice(0, clampLimit(i.limit));
    return {
      call_status_code: code,
      service_jobs: capped,
      returned: capped.length,
      matched: matches.length,
      jobs_scanned: scanned
    };
  }
});

reg({
  name: 'get_overdue_service_jobs',
  description: 'Jobs that are still active and whose due date or urgency date has already passed with no completion date recorded. Cancelled jobs are excluded.',
  params: { ...SERVICE_JOB_WINDOW_PARAMS },
  async run(i) {
    const now = Date.now();
    const { matches, scanned } = await scanServiceJobs((job, calls) => {
      if (job.status_code !== 'A' || job.completed_date) return false;
      return calls.some((c) => {
        const due = c.due_date ?? c.urgency_date;
        if (!due) return false;
        const parsed = Date.parse(due);
        return Number.isFinite(parsed) && parsed < now;
      });
    });
    const capped = matches.slice(0, clampLimit(i.limit));
    return { service_jobs: capped, returned: capped.length, matched: matches.length, jobs_scanned: scanned };
  }
});

reg({
  name: 'get_snoozed_service_jobs',
  description: 'Jobs holding a call with a snooze date still in the future.',
  params: { ...SERVICE_JOB_WINDOW_PARAMS },
  async run(i) {
    const now = Date.now();
    const { matches, scanned } = await scanServiceJobs((job, calls) =>
      calls.some((c) => {
        if (!c.snooze_date) return false;
        const parsed = Date.parse(c.snooze_date);
        return Number.isFinite(parsed) && parsed > now;
      })
    );
    const capped = matches.slice(0, clampLimit(i.limit));
    return { service_jobs: capped, returned: capped.length, matched: matches.length, jobs_scanned: scanned };
  }
});

reg({
  name: 'count_service_jobs_by_status',
  description: 'Service job totals grouped by status. Known codes are A Active, C Completed and X Cancelled; any other letter appears exactly as stored and its meaning is not documented.',
  params: { limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('service_jobs', 'service_job_status->>code', null, { limit: i.limit });
  }
});

reg({
  name: 'count_service_jobs_by_job_type',
  description: 'Service job totals grouped by job type. Only Maintenance and Install appear.',
  params: { limit: num('Max groups (default 25)') },
  async run(i) {
    return groupCount('service_jobs', 'job_type', null, { limit: i.limit });
  }
});

reg({
  name: 'count_service_job_calls_by_status',
  description: 'Counts every call nested inside service jobs, grouped by call status code. Call-level codes are separate from job status codes: U means unallocated, and W and V each appear once with no documented meaning.',
  params: { limit: num('Max groups (default 25)') },
  async run(i) {
    const { callStatusTallies, calls, scanned } = await scanServiceJobs(() => false);
    const groups = [...callStatusTallies.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, i.limit ?? 25)
      .map(([value, count]) => ({
        value,
        count,
        meaning: SERVICE_JOB_CALL_STATUS_CODES[value] ?? '(not documented)'
      }));
    return { grouped_by: 'service_job_calls[].callStatus.code', total_calls: calls, jobs_scanned: scanned, groups };
  }
});

reg({
  name: 'get_service_job_status_reference',
  description: 'The service job and call status codes, each decoded, plus the codes actually present in the data. Use this before answering what job statuses exist or what a code means.',
  params: {},
  async run() {
    const [jobCodes, scan] = await Promise.all([
      groupCount('service_jobs', 'service_job_status->>code', null, { limit: 50 }),
      scanServiceJobs(() => false)
    ]);
    return {
      job_status_codes: {
        A: 'Active',
        C: 'Completed',
        X: 'Cancelled',
        note: 'Any other letter is not documented. Report the code as stored and say its meaning is unknown.'
      },
      job_status_codes_in_use: jobCodes.groups,
      job_status_rows_without_a_code: jobCodes.rows_without_a_value,
      call_status_codes: {
        U: 'Unallocated',
        note: 'W and V each appear once in the data. Their business meaning is not documented - show the code and do not guess.'
      },
      call_status_codes_in_use: [...scan.callStatusTallies.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, count, meaning: SERVICE_JOB_CALL_STATUS_CODES[value] ?? '(not documented)' })),
      jobs_scanned: scan.scanned
    };
  }
});

reg({
  name: 'get_service_job_dashboard',
  description: 'One-call overview of service job activity: totals, the active/completed/cancelled split, how many jobs are unallocated, recent intake and average response time. Use this first for any broad question about how service jobs are tracking.',
  params: { days: num('Look-back window for intake in days (default 30)') },
  async run(i) {
    const window = i.days ?? 30;
    const since = dayStart(new Date(Date.now() - window * DAY_MS).toISOString().slice(0, 10));

    const [byStatus, withCompletion, recent, scan] = await Promise.all([
      groupCount('service_jobs', 'service_job_status->>code', null, { limit: 10 }),
      countRows('service_jobs', (q) => q.not('completed_date', 'is', null)),
      countRows('service_jobs', (q) => q.gte('received_date', since)),
      scanServiceJobs(() => false)
    ]);

    const statusTotals = Object.fromEntries(byStatus.groups.map((g) => [g.value, g.count]));
    const samples = [...scan.responseSamples].sort((a, b) => a - b);
    const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
    const median = samples.length ? samples[Math.floor(samples.length / 2)] : null;

    return {
      window_days: window,
      // Taken from the walk rather than a separate count query, so every figure
      // here describes the same set of rows on a table that is written to live.
      total_jobs: scan.scanned,
      jobs_with_a_completion_date: withCompletion.count,
      active_jobs: statusTotals.A ?? 0,
      completed_status_jobs: statusTotals.C ?? 0,
      cancelled_jobs: statusTotals.X ?? 0,
      jobs_with_no_status_code: byStatus.rows_without_a_value,
      received_in_window: recent.count,
      jobs_scanned: scan.scanned,
      total_calls: scan.calls,
      jobs_with_unallocated_calls: scan.jobsWithUnallocated,
      unallocated_note: 'Counted across every call on every job, not only the first call.',
      average_response_time: formatDuration(mean),
      median_response_time: formatDuration(median),
      response_times_recorded: samples.length,
      down_time_note: 'Down time is recorded as 00:00:00 on every job and carries no information.',
      ...(scan.truncated ? { truncated: true, note: 'Row walk hit its safety cap; totals may be incomplete.' } : {})
    };
  }
});

reg({
  name: 'get_service_job_response_times',
  description: 'Response and expected times across every recorded service job, with the whole-table average and the jobs that took longer than their expected time. Averaged over all jobs, never a sample. Down time is recorded as zero on every job and cannot be reported.',
  params: {
    status: str('Restrict to A/Active, C/Completed or X/Cancelled'),
    job_type: str('Job type, e.g. Maintenance'),
    limit: num(`Max breaching jobs listed (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`)
  },
  async run(i) {
    const statusCode = resolveJobStatus(i.status);
    const jobType = i.job_type ? i.job_type.toLowerCase() : null;

    // Filtered in memory over a full walk so the average always covers every
    // matching job. Averages taken from a single page disagreed with the
    // dashboard figure and would have been reported as fact.
    const scan = await scanServiceJobs((job) => {
      if (statusCode && job.status_code !== statusCode) return false;
      if (jobType && (job.job_type ?? '').toLowerCase().includes(jobType)) return false;
      return true;
    });

    let total = 0;
    const breaches = [];
    for (const job of scan.matches) {
      const actual = durationToSeconds(job.response_time);
      const expected = durationToSeconds(job.expected_time);
      if (actual === null) continue;
      total += actual;
      if (expected !== null && actual > expected) {
        breaches.push({
          id: job.id,
          status: job.status,
          summary: job.summary,
          response_time: job.response_time,
          expected_time: job.expected_time
        });
      }
    }

    const samples = scan.responseSamples.length;
    return {
      jobs_matching: scan.matches.length,
      response_times_recorded: samples,
      average_response_time: samples ? formatDuration(total / samples) : null,
      jobs_over_expected_time: breaches.length,
      breaches: breaches.slice(0, clampLimit(i.limit)),
      down_time_note: 'Down time is recorded as 00:00:00 on every job and carries no information.',
      ...(scan.truncated ? { truncated: true, note: 'Row walk hit its safety cap; these figures are incomplete.' } : {})
    };
  }
});

// ===========================================================================
// CROSS-DOMAIN SUMMARIES (5)
// ===========================================================================

reg({
  name: 'get_business_summary',
  description: 'Headline counts: customers, contracts, equipment (active split), staff and service jobs (active/completed/cancelled split).',
  params: {},
  async run() {
    const [customers, contracts, allEquipment, activeEquipment, staff, jobs] = await Promise.all([
      countRows('customers'),
      countRows('contracts'),
      countRows('equipment'),
      countRows('equipment', (q) => q.eq('is_active', true)),
      countRows('staff_members'),
      countRows('service_jobs')
    ]);
    return {
      summary: {
        total_customers: customers.count,
        total_contracts: contracts.count,
        total_equipment: allEquipment.count,
        active_equipment: activeEquipment.count,
        inactive_equipment: (allEquipment.count ?? 0) - (activeEquipment.count ?? 0),
        total_staff: staff.count,
        total_service_jobs: jobs.count
      }
    };
  }
});

reg({
  name: 'get_full_database_summary',
  description: 'Row counts for every business table, including reference data such as models, types, call types and branches.',
  params: {},
  async run() {
    const tables = [
      'customers', 'contracts', 'equipment', 'staff_members', 'branches', 'service_jobs',
      'billing_status', 'equipment_billing_type', 'equipment_types', 'equipment_models', 'service_call_types'
    ];
    const results = await Promise.all(tables.map((t) => countRows(t)));
    const counts = Object.fromEntries(results.map((r) => [r.table, r.count]));
    return { counts };
  }
});

reg({
  name: 'get_customer_profile',
  description: 'Everything about one customer in a single call: the customer record, contract count and machine count. A small number of machines reference a customer id that is not in the customer records, so a machine count can under-report.',
  params: { customer_id: num('Customer ID') },
  required: ['customer_id'],
  async run(i) {
    const supabase = getReadOnlySupabase();
    const [customer, contracts, equipment] = await Promise.all([
      supabase.from('customers').select('*').eq('id', i.customer_id).limit(1),
      supabase.from('contracts').select('*', { count: 'exact', head: true }).eq('customer_id', i.customer_id),
      supabase.from('equipment').select('*', { count: 'exact', head: true }).eq('customer->>id', String(i.customer_id))
    ]);
    if (customer.error) throw customer.error;
    if (contracts.error) throw contracts.error;
    if (equipment.error) throw equipment.error;
    return {
      customer: customer.data?.[0] ?? null,
      contract_count: contracts.count,
      equipment_count: equipment.count
    };
  }
});

reg({
  name: 'get_records_created_today',
  description: 'Rows added today to the tables that actually change day to day: customers, staff, branches and service jobs.',
  params: {},
  async run() {
    const since = `${isoToday()}T00:00:00`;
    const tables = ['customers', 'staff_members', 'branches', 'service_jobs'];
    const results = await Promise.all(tables.map((t) => countRows(t, (q) => q.gte('created_at', since))));
    return Object.fromEntries(results.map((r) => [`${r.table}_new_today`, r.count]));
  }
});

reg({
  name: 'get_customer_and_machine_summary_for_suburb',
  description: 'How many customers and how many machines sit in a given suburb. Only a small minority of customers have a suburb on record, so the customer figure will usually be far lower than the machine figure.',
  params: { suburb: str('Suburb name (partial)') },
  required: ['suburb'],
  async run(i) {
    const like = `%${i.suburb}%`;
    const [customers, equipment] = await Promise.all([
      countRows('customers', (q) => q.ilike('street_address->>suburb', like)),
      countRows('equipment', (q) => q.ilike('suburb', like))
    ]);
    return {
      suburb: i.suburb,
      customers: customers.count,
      machines: equipment.count,
      note: 'Customer addresses are recorded on only a small minority of customers.'
    };
  }
});

// ===========================================================================
// SERVICE JOBS (SIGNATURE SOFTWARE API) (2)
// ===========================================================================

reg({
  name: 'create_service_job',
  description: 'Creates a new service job via Signature Software API and saves the response to Supabase. Requires customer_id and equipment_id, and requires confirmed to be true - the details must have been shown to the user and agreed first.',
  params: {
    confirmed: bool('Must be true. Set this only after the user has seen and agreed to the details (Required)'),
    customer_id: num('Customer identifier (Required)'),
    equipment_id: num('Equipment identifier (Required)'),
    job_type: str('Job type, e.g. "Maintenance" (Optional, defaults to Maintenance)'),
    fault_description: str('Fault description detailing the issue (Optional)'),
    reported_by: str('Name of person reporting the fault (Optional)'),
    branch_id: num('Branch ID (Optional, defaults to 1)'),
    contract_id: num('Contract ID (Optional)'),
    service_order_number: str('Service order number (Optional)'),
    external_provider_identifier: str('External provider identifier (Optional)'),
    external_job_identifier: str('External job identifier (Optional)'),
    import_source: str('Import source (Optional)'),
    external_job_extra: str('External job extra information (Optional)'),
    work_order_category: str('Work order category (Optional)'),
    carry_over_notes: str('Carry over notes (Optional)')
  },
  required: ['confirmed', 'customer_id', 'equipment_id'],
  async run(i) {
    if (i.confirmed !== true) {
      throw new Error('Refusing to create a service job: the details have not been confirmed with the user. Show the customer, equipment, job type and fault first and get agreement.');
    }
    return createSignatureServiceJob(i);
  }
});

reg({
  name: 'get_service_job_by_id',
  description: 'Retrieves a service job from the live Signature Software API. For searching and reporting over recorded jobs use the service job record tools instead.',
  params: {
    id: num('Service job identifier (Required)')
  },
  required: ['id'],
  async run(i) {
    return getSignatureServiceJobById(i.id);
  }
});

// ===========================================================================
// CROSS-ANALYSIS TOOLS (2)
// ===========================================================================

reg({
  name: 'get_customers_with_both_active_and_inactive_equipment',
  description: 'Find customers who have both active and inactive equipment. Walks the entire equipment table to ensure complete results. Returns customer details with active and inactive counts.',
  params: { limit: num('Max customers to return (default 25)') },
  async run(i) {
    const { rows } = await fetchAllRows('equipment', 'customer->>id,customer->>tradingName,customer->>code,is_active');
    
    const byCustomer = new Map();
    for (const row of rows) {
      const id = row['customer->>id'];
      if (!id) continue;
      if (!byCustomer.has(id)) {
        byCustomer.set(id, { 
          customer_id: id, 
          trading_name: row['customer->>tradingName'] || 'Unknown',
          customer_code: row['customer->>code'] || null,
          active_count: 0, 
          inactive_count: 0 
        });
      }
      const entry = byCustomer.get(id);
      if (row.is_active === true) entry.active_count++;
      else if (row.is_active === false) entry.inactive_count++;
    }
    
    const both = [...byCustomer.values()]
      .filter(c => c.active_count > 0 && c.inactive_count > 0)
      .sort((a, b) => (b.active_count + b.inactive_count) - (a.active_count + a.inactive_count))
      .slice(0, i.limit ?? 25);
    
    return {
      customers: both,
      total_customers_with_both: both.length,
      total_equipment_scanned: rows.length,
      total_customers: byCustomer.size
    };
  }
});

reg({
  name: 'get_equipment_by_customer',
  description: 'List all equipment for a specific customer with their active/inactive status. Returns the full equipment list with status indicators.',
  params: { 
    customer_id: num('Customer ID (Required)'),
    limit: num(`Max rows (default ${DEFAULT_ROWS}, maximum ${MAX_ROWS})`)
  },
  required: ['customer_id'],
  async run(i) {
    return fetchList(
      'equipment',
      (q) => q.eq('customer->>id', String(i.customer_id)),
      { 
        columns: EQUIPMENT_LIST_COLUMNS, 
        orderBy: 'create_date', 
        ascending: false, 
        limit: i.limit 
      }
    );
  }
});

// ===========================================================================
// GENERIC QUERY TOOL (1)
// ===========================================================================

const VALID_TABLES = {
  equipment: ['id', 'serial_number', 'equipment_code', 'equipment_description', 'customer', 'billing_status', 'equipment_type', 'equipment_model', 'equipment_module', 'create_date', 'has_customer_warranty', 'has_supplier_warranty', 'is_trade_in', 'is_loan_equipment', 'is_active', 'sv_call_ack_option', 'street_address', 'suburb', 'state', 'post_code', 'supplier_id'],
  customers: ['id', 'code', 'trading_name', 'registered_name', 'email', 'phone', 'contact_person', 'street_address', 'postal_address', 'created_at'],
  contracts: ['id', 'agreement_number', 'billing_header_id', 'is_aggregate', 'customer_id', 'start_date', 'expiry_date'],
  service_jobs: ['id', 'job_type', 'summary', 'service_job_status', 'service_call_type', 'branch', 'customer', 'module', 'billing_status', 'received_date', 'completed_date', 'down_time', 'response_time', 'expected_time', 'service_job_calls', 'created_at', 'updated_at'],
  staff_members: ['id', 'first_name', 'surname', 'created_at'],
  branches: ['id', 'company_id', 'description', 'created_at'],
  billing_status: ['code', 'description', 'created_at'],
  equipment_billing_type: ['code', 'description', 'created_at'],
  equipment_types: ['id', 'description', 'created_at'],
  equipment_models: ['id', 'description', 'equipment_type', 'model_group', 'default_meters', 'created_at'],
  service_call_types: ['id', 'code', 'description', 'is_active', 'is_default_call_type', 'is_return_to_fit_type', 'is_maintenance_type', 'should_alert_on_excessive_call', 'should_calculate_response_times', 'should_bill_call_out', 'should_ignore_auto_bill', 'labour_depletion_rate', 'travel_depletion_rate', 'callout_depletion_rate', 'created_at'],
  created_service_jobs: ['id', 'job_id', 'customer_id', 'equipment_id', 'job_type', 'fault_description', 'reported_by', 'api_response', 'created_at']
};

// Define valid JOIN relationships between tables.
// NOTE: service_jobs has no equipment_id column (see Schema.sql), so there is
// intentionally no service_jobs_equipment join. Job->machine questions must use
// the service-job scan tools and say when the machine is not recorded.
const VALID_JOINS = {
  'equipment_customers': {
    tables: ['equipment', 'customers'],
    joinColumn: 'equipment.customer->>id = customers.id',
    description: 'Equipment with customer details'
  },
  'contracts_customers': {
    tables: ['contracts', 'customers'],
    joinColumn: 'contracts.customer_id = customers.id',
    description: 'Contracts with customer details'
  },
  'created_service_jobs_equipment': {
    tables: ['created_service_jobs', 'equipment'],
    joinColumn: 'created_service_jobs.equipment_id = equipment.id',
    description: 'Created service jobs with equipment details'
  },
  'created_service_jobs_customers': {
    tables: ['created_service_jobs', 'customers'],
    joinColumn: 'created_service_jobs.customer_id = customers.id',
    description: 'Created service jobs with customer details'
  }
};

reg({
  name: 'aggregate_table',
  description: 'Groups, counts, and aggregates records in any table by a specified column. Use this for ad-hoc aggregation questions like finding duplicates, distribution counts, ranking frequencies, or questions like "how many X have 2 or more Y" or "which items appear most frequently". Supports any table and column (including JSON columns like customer->>id).',
  params: {
    table: str('Table name: equipment, customers, contracts, service_jobs, staff_members, branches, billing_status, equipment_types, equipment_models, service_call_types'),
    group_by: str('Column to group by (e.g. "serial_number", "suburb", "state", "customer->>id", "equipment_type->>description")'),
    min_count: num('Minimum occurrences to include (e.g. 2 to find duplicates or items shared by 2+ records, default 1)'),
    limit: num('Maximum groups to return (default 25)'),
    filters: str('Optional filter conditions as key=value pairs separated by AND (e.g. "is_active=true")')
  },
  required: ['table', 'group_by'],
  async run(i) {
    const tableName = i.table;
    if (!VALID_TABLES[tableName]) {
      throw new Error(`Invalid table: ${tableName}. Valid tables: ${Object.keys(VALID_TABLES).join(', ')}`);
    }
    const filterFn = i.filters ? (q) => applyFilters(q, i.filters) : null;
    const minCount = Math.max(1, i.min_count ?? 1);
    const limit = Math.min(100, i.limit ?? 25);
    const res = await groupCount(tableName, i.group_by, filterFn, { minCount, limit });
    return {
      table: tableName,
      grouped_by: i.group_by,
      total_unique_groups: res.groups.length,
      groups: res.groups,
      rows_analyzed: res.total_rows,
      note: minCount > 1 ? `Showing groups with at least ${minCount} occurrences.` : undefined
    };
  }
});

reg({
  name: 'query_table',
  description: 'Query any table in the database with flexible filters, sorting, column selection, and optional JOINs. Prefer the specific search tools (get_customers, get_equipment, get_service_jobs, resolve_customer) for natural-language questions; use this for ad-hoc questions or cross-table analysis when no specific tool exists. Service jobs have no equipment link, so do not request a job->equipment JOIN. Always returns the true total count alongside the rows. Supports filtering by any column, sorting, selecting specific columns, and joining related tables.',
  params: {
    table: str('Table name: equipment, customers, contracts, service_jobs, staff_members, branches, billing_status, equipment_types, equipment_models, service_call_types, created_service_jobs'),
    columns: str('Columns to return, comma-separated (e.g., "id, serial_number, is_active" or "*" for all columns). For JOINs, prefix with table name (e.g., "equipment.id, customers.trading_name")'),
    filters: str('Filter conditions as key=value pairs separated by AND (e.g., "is_active=true AND state=NSW"). Supports: equals (=), not equals (!=), greater than (>), less than (<), contains (~). For JSON columns use ->> notation (e.g., "customer->>id=1000001")'),
    orderBy: str('Column to sort by'),
    ascending: bool('Sort ascending (true) or descending (false)'),
    limit: num(`Max rows to return (default ${DEFAULT_ROWS}, maximum 500)`),
    join: str('Optional JOIN. Format: "join_key:columns" where join_key is one of: equipment_customers, contracts_customers, created_service_jobs_equipment, created_service_jobs_customers. Columns are from the joined table, comma-separated (e.g., "equipment_customers:trading_name,code,email")')
  },
  required: ['table'],
  async run(i) {
    const supabase = getReadOnlySupabase();
    const tableName = i.table;
    
    // Validate table name
    if (!VALID_TABLES[tableName]) {
      throw new Error(`Invalid table: ${tableName}. Valid tables: ${Object.keys(VALID_TABLES).join(', ')}`);
    }

    // Handle JOIN query
    if (i.join) {
      const [joinKey, joinColumns] = i.join.split(':');
      const joinConfig = VALID_JOINS[joinKey];
      
      if (!joinConfig) {
        throw new Error(`Invalid JOIN: ${joinKey}. Valid JOINs: ${Object.keys(VALID_JOINS).join(', ')}`);
      }
      
      if (!joinConfig.tables.includes(tableName)) {
        throw new Error(`JOIN ${joinKey} is not compatible with table ${tableName}. Compatible tables: ${joinConfig.tables.join(', ')}`);
      }

      // Build JOIN query using embedded resources
      const joinTable = joinConfig.tables.find(t => t !== tableName);
      const selectColumns = i.columns || '*';
      const fullSelect = `${selectColumns}, ${joinTable}(${joinColumns || '*'})`;
      
      let query = supabase.from(tableName).select(fullSelect, { count: 'exact' });
      
      // Apply filters
      if (i.filters) {
        query = applyFilters(query, i.filters);
      }
      
      // Apply sorting
      if (i.orderBy) {
        query = query.order(i.orderBy, { ascending: i.ascending !== false });
      }
      
      // Apply limit
      const limit = Math.min(Math.max(1, i.limit || DEFAULT_ROWS), 500);
      query = query.limit(limit);
      
      const { data, error, count } = await query;
      if (error) throw error;
      
      return {
        [tableName]: data ?? [],
        returned: (data ?? []).length,
        count: count ?? 0,
        table: tableName,
        join: joinKey,
        query: {
          columns: selectColumns,
          filters: i.filters || null,
          orderBy: i.orderBy || null,
          limit
        }
      };
    }

    // Build regular query (no JOIN)
    let query = supabase.from(tableName).select(i.columns || '*', { count: 'exact' });
    
    // Apply filters
    if (i.filters) {
      query = applyFilters(query, i.filters);
    }
    
    // Apply sorting
    if (i.orderBy) {
      query = query.order(i.orderBy, { ascending: i.ascending !== false });
    }
    
    // Apply limit
    const limit = Math.min(Math.max(1, i.limit || DEFAULT_ROWS), 500);
    query = query.limit(limit);
    
    const { data, error, count } = await query;
    if (error) throw error;
    
    return {
      [tableName]: data ?? [],
      returned: (data ?? []).length,
      count: count ?? 0,
      table: tableName,
      query: {
        columns: i.columns || '*',
        filters: i.filters || null,
        orderBy: i.orderBy || null,
        limit
      }
    };
  }
});

// Helper function to apply filters to a query
function applyFilters(query, filters) {
  const filterParts = filters.split(' AND ').map(f => f.trim());
  for (const part of filterParts) {
    const match = part.match(/^([^!=><~]+)(!=|>=|<=|>|<|=|~)(.+)$/);
    if (!match) continue;
    const [, column, operator, value] = match;
    const col = column.trim();
    const val = value.trim();
    
    if (col.includes('->>')) {
      switch (operator) {
        case '=': query = query.eq(col, val); break;
        case '!=': query = query.neq(col, val); break;
        case '>': query = query.gt(col, val); break;
        case '<': query = query.lt(col, val); break;
        case '~': query = query.ilike(col, `%${val}%`); break;
      }
    } else {
      switch (operator) {
        case '=': query = query.eq(col, val); break;
        case '!=': query = query.neq(col, val); break;
        case '>': query = query.gt(col, val); break;
        case '<': query = query.lt(col, val); break;
        case '~': query = query.ilike(col, `%${val}%`); break;
      }
    }
  }
  return query;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const SUPABASE_TOOLS = registry.map(({ name, description, params, required }) => ({
  name,
  description,
  input_schema: {
    type: 'object',
    properties: params,
    ...(required ? { required } : {})
  }
}));

export async function executeTool(toolName, toolInput) {
  const spec = registry.find((r) => r.name === toolName);
  if (!spec) {
    return { error: `Unknown tool: ${toolName}` };
  }
  try {
    return await spec.run(toolInput ?? {});
  } catch (err) {
    console.error(`Tool ${toolName} error:`, err);
    return { error: err.message };
  }
}
