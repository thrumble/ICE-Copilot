# sync-customers

Syncs the `customers` table from Signature Software.

## Endpoint used

`GET https://apiproxy.signaturesoftware.com.au/api/v1/service/customers`

Single call, no pagination (not supported by this endpoint per the API spec).

## Secrets required

| Secret | Purpose |
|---|---|
| `SS_CLIENT_ID` | Signature Software OAuth2 client id |
| `SS_CLIENT_SECRET` | Signature Software OAuth2 client secret |
| `SS_PROXY_CLIENT_ID` | Value for the `X-ProxyHub-ClientId` header |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## Field mapping (API → `customers` table)

| API field | Column |
|---|---|
| id | id |
| code | code |
| tradingName | trading_name |
| registeredName | registered_name |
| email | email |
| phone | phone |
| contactPerson | contact_person |
| streetAddress | street_address |
| postalAddress | postal_address |

Upsert key: `id`.

## Request

```bash
curl -i 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-customers' \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

## Response

**Success (200):**
```json
{ "ok": true, "received": <count>, "saved": <count> }
```

**Error (500):**
```json
{ "ok": false, "error": "..." }
```


## Full source (`sync-customers/index.ts`)

```typescript
// supabase/functions/sync-customers/index.ts
//
// Syncs the `customers` table from Signature Software (/customers).
// Fetched in a single call (this endpoint has no pagination in the API
// spec) and upserted on `id`.
//
// Required secrets: SS_CLIENT_ID, SS_CLIENT_SECRET, SS_PROXY_CLIENT_ID

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SS_CLIENT_ID = Deno.env.get("SS_CLIENT_ID")!;
const SS_CLIENT_SECRET = Deno.env.get("SS_CLIENT_SECRET")!;
const SS_PROXY_CLIENT_ID =
  Deno.env.get("SS_PROXY_CLIENT_ID") ?? "8E4A5983-2B81-4909-BE7F-B675C9144FC4/service";

const TOKEN_URL = "https://auth.signaturesoftware.com.au/connect/token";
const API_URL = "https://apiproxy.signaturesoftware.com.au/api/v1/service/customers";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function getAccessToken(): Promise<string> {
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
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!json.access_token) throw new Error("No access_token in token response");
  return json.access_token as string;
}

// Handles a plain top-level array, or data.result.data, and a string that
// needs JSON.parse (some responses arrive stringified).
// deno-lint-ignore no-explicit-any
function extractItems(raw: any): any[] {
  let node = raw;
  if (node && typeof node === "object" && "data" in node) node = node.data;
  if (node && typeof node === "object" && "result" in node) node = node.result;
  if (node && typeof node === "object" && "data" in node) node = node.data;
  if (typeof node === "string") node = JSON.parse(node);
  if (Array.isArray(node)) return node;
  if (Array.isArray(raw)) return raw;
  throw new Error("Could not locate an items array in the API response");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// deno-lint-ignore no-explicit-any
function mapItem(i: any) {
  return {
    id: i.id,
    code: i.code ?? null,
    trading_name: i.tradingName ?? null,
    registered_name: i.registeredName ?? null,
    email: i.email ?? null,
    phone: i.phone ?? null,
    contact_person: i.contactPerson ?? null,
    street_address: i.streetAddress ?? null,
    postal_address: i.postalAddress ?? null,
  };
}

Deno.serve(async (_req: Request) => {
  try {
    const token = await getAccessToken();

    const res = await fetch(API_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-ProxyHub-ClientId": SS_PROXY_CLIENT_ID,
      },
    });
    if (!res.ok) throw new Error(`API fetch failed: ${res.status} ${await res.text()}`);

    const items = extractItems(await res.json());
    const rows = items.map(mapItem);

    let saved = 0;
    for (const batch of chunk(rows, 500)) {
      const { error } = await supabase.from("customers").upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`Upsert failed: ${error.message}`);
      saved += batch.length;
    }

    return new Response(
      JSON.stringify({ ok: true, received: items.length, saved }),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { headers: { "Content-Type": "application/json" }, status: 500 },
    );
  }
});

```
