# sync-service-job-gaps

Detects and fills missing ID gaps between a base ID (default: `66001`) and a target ID in the `service_jobs` table. It performs an in-memory comparison to find missing integers, queries the Signature Software ICE API for those specific IDs, and upserts them into the database.

## Secrets required

- `SUPABASE_URL` (Auto-injected)
- `SUPABASE_SERVICE_ROLE_KEY` (Auto-injected)
- `SS_CLIENT_ID`
- `SS_CLIENT_SECRET`
- `SS_PROXY_CLIENT_ID`

## Request

```
POST /functions/v1/sync-service-job-gaps
Content-Type: application/json

{ "id": 66891 }
```

*(Optional: You can provide `"start_id": 66001` to manually override the starting boundary).*

## Response

**Success (200) - Gaps Filled:**
```json
{
  "message": "Gap sync complete",
  "start_id": 66001,
  "target_id": 66891,
  "total_missing_identified": 2,
  "synced_count": 2,
  "not_found_count": 0,
  "missing_ids_processed": [66004, 66783]
}
```

**Success (200) - No Gaps Detected:**
```json
{
  "message": "No gaps detected. All IDs exist in the database.",
  "start_id": 66001,
  "target_id": 66891,
  "total_missing_identified": 0
}
```

**Bad request (400):** Missing/invalid `id` or if `start_id` is greater than the target `id`.

**Server error (500):** Missing environment secrets or database lookup failure.

## Notes

- Gap detection is entirely handled in-memory using a JavaScript `Set`. No custom SQL or PostgreSQL functions are required.
- Automatically handles Supabase's 1,000-row pagination limit when scanning existing IDs.
- If a missing ID returns `404` from the Signature API (indicating it was permanently deleted or skipped by the system), it is recorded in `not_found_count` and bypassed.

## Full source (`sync-service-job-gaps/index.ts`)

```typescript
// supabase/functions/sync-service-job-gaps/index.ts
//
// Detects missing IDs in the service_jobs table up to a target ID,
// fetches them from the Signature Software ICE API, and upserts them.

import { createClient } from "[https://esm.sh/@supabase/supabase-js@2](https://esm.sh/@supabase/supabase-js@2)";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SS_CLIENT_ID = Deno.env.get("SS_CLIENT_ID")!;
const SS_CLIENT_SECRET = Deno.env.get("SS_CLIENT_SECRET")!;
const SS_PROXY_CLIENT_ID = Deno.env.get("SS_PROXY_CLIENT_ID")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// 1. Get OAuth Bearer Token
async function getAccessToken(): Promise<string> {
  const tokenUrl = "[https://auth.signaturesoftware.com.au/connect/token](https://auth.signaturesoftware.com.au/connect/token)";
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SS_CLIENT_ID,
    client_secret: SS_CLIENT_SECRET,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch access token: ${res.statusText}`);
  }

  const data = await res.json();
  return data.access_token;
}

// 2. Parse API response payload safely
function parseJobPayload(raw: any) {
  let parsed = raw;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch {}
  }
  if (parsed?.data && typeof parsed.data === "string") {
    try { parsed = JSON.parse(parsed.data); } catch {}
  }
  return parsed?.result ?? parsed?.data ?? parsed;
}

// 3. Map API object to Postgres snake_case table columns
function mapToTableRow(job: any) {
  return {
    id: job.id,
    company_id: job.companyId ?? null,
    branch: job.branch ?? null,
    customer: job.customer ?? null,
    module: job.module ?? null,
    job_type: job.jobType ?? null,
    summary: job.summary ?? null,
    service_job_status: job.serviceJobStatus ?? null,
    service_call_type: job.serviceCallType ?? null,
    billing_status: job.billingStatus ?? null,
    received_date: job.receivedDate ? new Date(job.receivedDate).toISOString() : null,
    completed_date: job.completedDate ? new Date(job.completedDate).toISOString() : null,
    down_time: job.downTime ?? null,
    response_time: job.responseTime ?? null,
    expected_time: job.expectedTime ?? null,
    service_job_calls: Array.isArray(job.serviceJobCalls) ? job.serviceJobCalls : [],
    updated_at: new Date().toISOString(),
  };
}

// 4. Fetch all existing IDs in the target range (handles Supabase 1,000-row pagination)
async function fetchExistingIdsInRange(startId: number, endId: number): Promise<Set<number>> {
  const existingSet = new Set<number>();
  let from = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("service_jobs")
      .select("id")
      .gte("id", startId)
      .lte("id", endId)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Failed to query existing IDs: ${error.message}`);
    }

    if (data && data.length > 0) {
      for (const row of data) {
        existingSet.add(Number(row.id));
      }
      from += pageSize;
      if (data.length < pageSize) {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }
  }

  return existingSet;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    let body: { id?: number | string; start_id?: number | string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Request body must be valid JSON" }, 400);
    }

    const targetId = Number(body.id);
    if (!targetId || isNaN(targetId)) {
      return json({ error: "A valid numerical 'id' is required" }, 400);
    }

    // Base start ID is 66001 unless explicitly overridden
    const startId = Number(body.start_id) || 66001;

    if (startId > targetId) {
      return json({
        message: "Start ID cannot be greater than target ID",
        start_id: startId,
        target_id: targetId,
      }, 400);
    }

    // Step 1: Detect existing IDs from the database
    const existingIdsSet = await fetchExistingIdsInRange(startId, targetId);

    // Step 2: Calculate missing gaps completely in TypeScript memory
    const missingIds: number[] = [];
    for (let currentId = startId; currentId <= targetId; currentId++) {
      if (!existingIdsSet.has(currentId)) {
        missingIds.push(currentId);
      }
    }

    if (missingIds.length === 0) {
      return json({
        message: "No gaps detected. All IDs exist in the database.",
        start_id: startId,
        target_id: targetId,
        total_missing_identified: 0,
      });
    }

    // Step 3: Fetch OAuth Token
    const token = await getAccessToken();

    let syncedCount = 0;
    let notFoundCount = 0;

    // Step 4: Fetch only the detected missing IDs
    for (const missingId of missingIds) {
      const jobUrl = `[https://apiproxy.signaturesoftware.com.au/api/v1/service/job/$](https://apiproxy.signaturesoftware.com.au/api/v1/service/job/$){missingId}`;

      try {
        const res = await fetch(jobUrl, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${token}`,
            "X-ProxyHub-ClientId": SS_PROXY_CLIENT_ID,
            "Accept": "application/json",
          },
        });

        if (res.status === 200) {
          const raw = await res.json();
          const job = parseJobPayload(raw);

          if (job && job.id) {
            const row = mapToTableRow(job);
            const { error: upsertErr } = await supabase
              .from("service_jobs")
              .upsert(row, { onConflict: "id" });

            if (upsertErr) {
              console.error(`Failed to upsert job ${missingId}:`, upsertErr);
            } else {
              syncedCount++;
            }
          }
        } else if (res.status === 404) {
          notFoundCount++;
        } else {
          console.warn(`Job ID ${missingId} returned unexpected status: ${res.status}`);
        }
      } catch (err) {
        console.error(`Failed during fetch for ID ${missingId}:`, err);
      }

      // 50ms delay between requests to avoid server throttling
      await delay(50);
    }

    return json({
      message: "Gap sync complete",
      start_id: startId,
      target_id: targetId,
      total_missing_identified: missingIds.length,
      synced_count: syncedCount,
      not_found_count: notFoundCount,
      missing_ids_processed: missingIds,
    });
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
```