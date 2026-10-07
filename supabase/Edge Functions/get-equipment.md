# get-equipment

Looks up one equipment record by serial number from our own `equipment`
table (kept in sync by `sync-equipment`). This is a **local DB lookup** —
it does not call the Signature Software API, so it needs none of the
`SS_*` secrets.

## Secrets required

None beyond the auto-injected `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.

## Request

```
POST /functions/v1/get-equipment
Content-Type: application/json

{ "serial_number": "060558" }
```

## Response

**Found (200):**
```json
{
  "equipment_description": "COPY CENTRE COFFS PTY LTD, DW3030, T&M",
  "customer_registered_name": "COPY CENTRE COFFS PTY LTD**** HENRY'S MANAGEMENT"
}
```

**Not found (404):**
```json
{ "error": "No equipment found for that serial number" }
```

**Bad request (400):** missing/empty `serial_number`, or invalid JSON body.

**Server error (500):** DB lookup failed.

## Notes

- Assumes `serial_number` is unique — uses `.maybeSingle()`, so it always
  returns at most one record.
- Only returns `equipment_description` and the customer's
  `registered_name` (pulled out of the `customer` json column). To return
  more fields, edit the `.select(...)` list and the response object in
  `index.ts`.
- Matching is exact (`.eq`). For partial/"contains" search, change `.eq`
  to `.ilike` with `%${serialNumber}%`.

## Full source (`get-equipment/index.ts`)

```typescript
// supabase/functions/get-equipment/index.ts
//
// Looks up equipment by serial number from our own `equipment` table
// (the one kept in sync by sync-equipment). This is a local DB lookup —
// it does NOT call the Signature Software API directly, so it's fast and
// doesn't need the SS_CLIENT_ID/SS_CLIENT_SECRET secrets.
//
// Request:
//   POST /functions/v1/get-equipment
//   { "serial_number": "060558" }
//
// Response (found):
//   { "equipment_description": "...", "customer_registered_name": "..." }
// Response (not found):
//   { "error": "No equipment found for that serial number" }   (404)
// Response (bad request / error):
//   { "error": "..." }   (400 / 500)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  // Browsers send a preflight OPTIONS request before the real POST — just
  // acknowledge it, no logic needed.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    // STEP 1: Read serial_number out of the request body.
    let body: { serial_number?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Request body must be valid JSON" }, 400);
    }

    const serialNumber = body.serial_number?.trim();
    if (!serialNumber) {
      return json({ error: "serial_number is required" }, 400);
    }

    // STEP 2: Look it up in our equipment table — exact match on
    // serial_number. Only pulling equipment_description and customer here
    // (customer is a json column; registeredName is picked out of it
    // below before responding). .single() because serial_number is
    // effectively unique — we only ever expect one match.
    const { data, error } = await supabase
      .from("equipment")
      .select("equipment_description, customer")
      .eq("serial_number", serialNumber)
      .maybeSingle();

    if (error) {
      throw new Error(`Lookup failed: ${error.message}`);
    }

    if (!data) {
      return json({ error: "No equipment found for that serial number" }, 404);
    }

    // STEP 3: Respond with just the two fields asked for, as a plain
    // object (not wrapped in ok/count/data).
    return json({
      equipment_description: data.equipment_description,
      customer_registered_name: data.customer?.registeredName ?? null,
    });
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

```
