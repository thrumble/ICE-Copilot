# sync-equipment

Syncs the `equipment` table from the Signature Software `equipmentitems` API.

## Endpoint used

`GET https://apiproxy.signaturesoftware.com.au/api/v1/service/equipmentitems?pageNumber={n}&pageSize=1000`

Paginated — the function loops through pages of 1000 until a page comes
back with fewer than 1000 items (last page).

## Known API limitation

This endpoint only ever returns **active** equipment. It never tells us
directly that something became inactive — it just stops appearing in the
response. To handle this, after every sync the function marks any row in
`equipment` that is **not** in the current fetch as `is_active = false`
(via the `mark_inactive_equipment` SQL function — see `functions-sql.md`).

## Secrets required

| Secret | Purpose |
|---|---|
| `SS_CLIENT_ID` | Signature Software OAuth2 client id |
| `SS_CLIENT_SECRET` | Signature Software OAuth2 client secret |
| `SS_PROXY_CLIENT_ID` | Value for the `X-ProxyHub-ClientId` header |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## Field mapping (API → `equipment` table)

| API field | Column |
|---|---|
| id | id |
| serialNumber | serial_number |
| equipmentCode | equipment_code |
| salesStaff | sales_staff |
| customer | customer |
| billingStatus | billing_status |
| equipmentType | equipment_type |
| equipmentModel | equipment_model |
| equipmentModule | equipment_module |
| modelGroup | model_group |
| installDate | install_date |
| createDate | create_date |
| hasCustomerWarranty | has_customer_warranty |
| hasSupplierWarranty | has_supplier_warranty |
| isTaxExempt | is_tax_exempt |
| isGSTExempt | is_gst_exempt |
| isTradeIn | is_trade_in |
| isLoanEquipment | is_loan_equipment |
| hasMailerSelect | has_mailer_select |
| hasBillingSelect | has_billing_select |
| hasMifReportSelect | has_mif_report_select |
| isActive | is_active |
| svCallAcknowledgeOption | sv_call_ack_option |
| phoneStd | phone_std |
| phoneNo | phone_no |
| faxNo | fax_no |
| faxStd | fax_std |
| mobile | mobile |
| streetAddress | street_address |
| suburb | suburb |
| state | state |
| postCode | post_code |
| equipNo | equip_no |
| supplierId | supplier_id |
| equipmentDescription | equipment_description |
| tradingName | trading_name |

Upsert key: `id`.

## Request

No body needed. Any HTTP method works (GET, POST) since the function
doesn't check `req.method`.

```bash
curl -i 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-equipment' \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

## Response

```json
{
  "ok": true,
  "totalReceived": 2877,
  "totalInTable": 3359,
  "totalMatched": 2871,
  "totalNotMatched": 6,
  "totalUpdated": 2871,
  "totalSaved": 2877,
  "countMismatch": false
}
```

| Field | Meaning |
|---|---|
| totalReceived | Items pulled from the API this run (all pages combined) |
| totalInTable | Row count in `equipment` after this sync finished |
| totalMatched / totalUpdated | Ids that already existed → got updated |
| totalNotMatched | Ids that were new → got inserted |
| totalSaved | totalMatched + totalNotMatched (rows written this run) |
| countMismatch | `true` if the API's reported total and what we actually fetched don't line up — a red flag to investigate |

On error: `{ "ok": false, "error": "..." }` with HTTP 500.

## Dependencies

Run `functions.sql` in the SQL editor **before** deploying this function —
it creates `mark_inactive_equipment` and `count_matching_ids`, both of
which this function calls.

## Scheduling

Triggered from n8n on whatever schedule you set up there (no `pg_cron`
needed) — call the function URL with the `Authorization` header, same as
the curl example above.

## Full source (`sync-equipment/index.ts`)

```typescript
// supabase/functions/sync-equipment/index.ts
//
// Fetches every equipment item from the Signature Software API and
// upserts it into public.equipment, keyed on id. Intended to be called
// on a schedule (see schedule.sql).
//
// Required secrets (set with `supabase secrets set`):
//   SS_CLIENT_ID          - Signature Software OAuth2 client id
//   SS_CLIENT_SECRET      - Signature Software OAuth2 client secret
//   SS_PROXY_CLIENT_ID    - value for the X-ProxyHub-ClientId header
//                            (defaults to the one from your n8n flow)
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
// by the Edge Functions runtime — you don't need to set those yourself.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SS_CLIENT_ID = Deno.env.get("SS_CLIENT_ID")!;
const SS_CLIENT_SECRET = Deno.env.get("SS_CLIENT_SECRET")!;
const SS_PROXY_CLIENT_ID =
  Deno.env.get("SS_PROXY_CLIENT_ID") ?? "8E4A5983-2B81-4909-BE7F-B675C9144FC4/service";

const TOKEN_URL = "https://auth.signaturesoftware.com.au/connect/token";
const EQUIPMENT_URL = "https://apiproxy.signaturesoftware.com.au/api/v1/service/equipmentitems";
const PAGE_SIZE = 1000;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function getAccessToken(): Promise<string> {
  // Signature Software uses OAuth2 "client credentials" login: we send our
  // client_id + client_secret, and get back a short-lived access_token to
  // use on the actual equipment API call.
  const body = new URLSearchParams({
    client_id: SS_CLIENT_ID,
    client_secret: SS_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("No access_token in token response");
  return json.access_token as string;
}

// The API can nest the item array under data.result.data, and that value
// sometimes arrives as a JSON-encoded string rather than a real array
// (this is the "comes back as a string" behaviour you saw in n8n).
// This handles both that shape and a plain top-level array. It also pulls
// out data.result.totalRecords when present, so we can log/verify the
// full expected count.
function extractPage(raw: unknown): { items: any[]; totalRecords: number | null } {
  // deno-lint-ignore no-explicit-any
  let node: any = raw;
  let totalRecords: number | null = null;

  if (node && typeof node === "object" && "data" in node) node = node.data;
  if (node && typeof node === "object" && "result" in node) {
    if (typeof node.result?.totalRecords === "number") {
      totalRecords = node.result.totalRecords;
    }
    node = node.result;
  }
  if (node && typeof node === "object" && "totalRecords" in node && typeof node.totalRecords === "number") {
    totalRecords = node.totalRecords;
  }
  if (node && typeof node === "object" && "data" in node) node = node.data;

  if (typeof node === "string") {
    node = JSON.parse(node);
  }

  if (Array.isArray(node)) return { items: node, totalRecords };
  if (Array.isArray(raw)) return { items: raw as any[], totalRecords }; // body was already the plain array

  throw new Error("Could not locate an items array in the API response");
}

async function fetchPage(
  token: string,
  pageNumber: number,
): Promise<{ items: any[]; totalRecords: number | null }> {
  const url = `${EQUIPMENT_URL}?pageNumber=${pageNumber}&pageSize=${PAGE_SIZE}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-ProxyHub-ClientId": SS_PROXY_CLIENT_ID,
    },
  });

  if (!res.ok) {
    throw new Error(`Equipment fetch failed (page ${pageNumber}): ${res.status} ${await res.text()}`);
  }
  const raw = await res.json();
  return extractPage(raw);
}

// deno-lint-ignore no-explicit-any
function mapItem(item: any) {
  // Converts one equipment object from the API's naming style (camelCase,
  // e.g. serialNumber) into our table's column naming style (snake_case,
  // e.g. serial_number). This is what actually gets inserted/updated.
  return {
    id: item.id,
    serial_number: item.serialNumber ?? null,
    equipment_code: item.equipmentCode ?? null,
    sales_staff: item.salesStaff ?? null,
    customer: item.customer ?? null,
    billing_status: item.billingStatus ?? null,
    equipment_type: item.equipmentType ?? null,
    equipment_model: item.equipmentModel ?? null,
    equipment_module: item.equipmentModule ?? null,
    model_group: item.modelGroup ?? null,
    install_date: item.installDate ?? null,
    create_date: item.createDate,
    has_customer_warranty: item.hasCustomerWarranty ?? null,
    has_supplier_warranty: item.hasSupplierWarranty ?? null,
    is_tax_exempt: item.isTaxExempt ?? null,
    is_gst_exempt: item.isGSTExempt ?? null,
    is_trade_in: item.isTradeIn ?? null,
    is_loan_equipment: item.isLoanEquipment ?? null,
    has_mailer_select: item.hasMailerSelect ?? null,
    has_billing_select: item.hasBillingSelect ?? null,
    has_mif_report_select: item.hasMifReportSelect ?? null,
    is_active: item.isActive ?? null,
    sv_call_ack_option: item.svCallAcknowledgeOption ?? null,
    phone_std: item.phoneStd ?? null,
    phone_no: item.phoneNo ?? null,
    fax_no: item.faxNo ?? null,
    fax_std: item.faxStd ?? null,
    mobile: item.mobile ?? null,
    street_address: item.streetAddress ?? null,
    suburb: item.suburb ?? null,
    state: item.state ?? null,
    post_code: item.postCode ?? null,
    equip_no: item.equipNo ?? null,
    supplier_id: item.supplierId ?? null,
    equipment_description: item.equipmentDescription ?? null,
    trading_name: item.tradingName ?? null,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  // Splits one big array into smaller arrays of `size` items each.
  // Used so we upsert 500 rows at a time instead of all rows in one go.
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Deno.serve(async (_req: Request) => {
  try {
    // STEP 1: Login to Signature Software (OAuth2) to get an access token.
    // Every call to their API needs this token in the Authorization header.
    const token = await getAccessToken();

    let pageNumber = 1;
    let totalFetched = 0;
    let totalRecords: number | null = null;
    // deno-lint-ignore no-explicit-any
    const allRows: any[] = []; // holds every equipment row, mapped to our table's column names
    const activeIds: number[] = []; // holds just the ids — used later to detect who went inactive

    // STEP 2: Pull equipment items page by page (1000 at a time) until
    // there are no more pages left. This is needed because the API caps
    // how many records it returns per request.
    while (true) {
      const page = await fetchPage(token, pageNumber);
      if (page.totalRecords !== null) totalRecords = page.totalRecords;
      if (page.items.length === 0) break; // nothing more to fetch, stop

      totalFetched += page.items.length;
      for (const item of page.items) {
        allRows.push(mapItem(item)); // convert API's field names -> our table's column names
        activeIds.push(item.id);
      }

      if (page.items.length < PAGE_SIZE) break; // got less than a full page = this was the last page
      if (totalRecords !== null && totalFetched >= totalRecords) break; // we already have everything the API said exists
      pageNumber += 1; // otherwise, go fetch the next page
    }

    // STEP 3: Save everything we fetched into the `equipment` table.
    // upsert = if a row with this id already exists, UPDATE it;
    //          if it doesn't exist yet, INSERT it as a new row.
    // We send it in batches of 500 (instead of all at once) to keep each
    // database call small and reliable.
    //
    // Before upserting, we grab the set of ids already in the table so we
    // can report how many of this fetch MATCHED an existing row (= got
    // updated) vs how many did NOT match (= brand new inserts).
    // Before upserting, count how many of this fetch's ids already exist
    // in the table (= will be updated) vs are brand new (= will be
    // inserted). This MUST be done via SQL (RPC), not by pulling all
    // existing ids into the edge function with .select("id") — that
    // approach is capped at 1000 rows by PostgREST's default row limit,
    // which silently gave a wrong (too-low) matched count on tables with
    // more than 1000 rows.
    const { data: matchedCount, error: matchedCountError } = await supabase.rpc(
      "count_matching_ids",
      { active_ids: activeIds },
    );
    if (matchedCountError) {
      throw new Error(`count_matching_ids failed: ${matchedCountError.message}`);
    }
    const totalMatched = matchedCount as number;
    const totalNotMatched = activeIds.length - totalMatched;

    let totalUpserted = 0;
    for (const batch of chunk(allRows, 500)) {
      const { error } = await supabase.from("equipment").upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`Upsert failed: ${error.message}`);
      totalUpserted += batch.length;
    }
    const totalUpdated = totalMatched; // rows that already existed and just got refreshed

    // STEP 4: Mark equipment as inactive if it's missing from this fetch.
    // Why: the API only ever returns ACTIVE equipment — it never tells us
    // "this one turned inactive". So if something that used to be active
    // no longer shows up in activeIds, that's our only signal that it
    // must have gone inactive on their side. We flip is_active to false
    // for exactly those rows, via the mark_inactive_equipment SQL function.
    //
    // Safety guard: if activeIds ended up empty (e.g. the API call failed
    // silently or returned nothing), skip this step — otherwise we'd
    // wrongly mark EVERY row in the table as inactive.
    if (activeIds.length > 0) {
      const { error: markInactiveError } = await supabase.rpc("mark_inactive_equipment", {
        active_ids: activeIds,
      });
      if (markInactiveError) {
        throw new Error(`mark_inactive_equipment failed: ${markInactiveError.message}`);
      }
    }

    // STEP 5: Report back what happened.
    // countMismatch: quick sanity check. true = the count the API reported
    // and the count we actually fetched don't match (something may have
    // gone wrong with pagination). false = counts line up, all good.
    const countMismatch = totalRecords !== null && totalRecords !== totalFetched;

    // Total rows currently in the table, after this sync finished.
    const { count: totalInTable, error: countError } = await supabase
      .from("equipment")
      .select("*", { count: "exact", head: true });
    if (countError) {
      throw new Error(`Counting table rows failed: ${countError.message}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        totalReceived: totalFetched, // total count the API reported = total items we actually pulled via HTTP
        totalInTable, // row count in equipment table right now
        totalMatched, // ids that already existed in the table -> got updated
        totalNotMatched, // ids that were new -> got inserted
        totalUpdated, // same as totalMatched, named for clarity
        totalSaved: totalUpserted, // "upserted" = insert + update combined. This is how many rows were written to the DB this run (totalMatched + totalNotMatched)
        countMismatch,
      }),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    );
  } catch (err) {
    // Catches anything that failed above (bad token, API down, DB error,
    // etc.) and returns it as a clean JSON error instead of crashing.
    console.error(err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { headers: { "Content-Type": "application/json" }, status: 500 },
    );
  }
});

```
