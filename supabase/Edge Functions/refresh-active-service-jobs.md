# refresh-active-service-jobs

Scans the `service_jobs` table for all active records (where `service_job_status->>'code' == 'A'`), queries the Signature Software ICE API for their latest state, and updates the database records. Designed to be run hourly via a `pg_cron` schedule or on-demand via a `GET` request.

## Secrets required

- `SUPABASE_URL` (Auto-injected)
- `SUPABASE_SERVICE_ROLE_KEY` (Auto-injected)
- `SS_CLIENT_ID`
- `SS_CLIENT_SECRET`
- `SS_PROXY_CLIENT_ID`

## Request

```
GET /functions/v1/refresh-active-service-jobs
Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
```

*(No request body is required. The function supports both GET and POST methods).*

## Response

**Success (200) - Refreshed:**
```json
{
  "message": "Active service jobs refresh completed",
  "active_jobs_found": 14,
  "refreshed_count": 14,
  "failed_count": 0
}
```

**Success (200) - No jobs to refresh:**
```json
{
  "message": "No active service jobs with status code 'A' to refresh",
  "active_jobs_found": 0,
  "refreshed_count": 0,
  "failed_count": 0
}
```

**Server error (500):** Missing environment secrets or database lookup failure.

## Notes

- Uses `.contains("service_job_status", { code: "A" })` to query the JSONB column accurately without PostgREST syntax errors.
- Includes a 50ms `delay()` block between requests to the Signature Software API to avoid hitting rate limits.
- Can be scheduled via Supabase's SQL Editor using `pg_cron` and `pg_net`:
  ```sql
  select cron.schedule('refresh-active-service-jobs-hourly', '0 * * * *', $$
    select net.http_get(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/refresh-active-service-jobs',
      headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')
    );
  $$);
  ```

## Full source (`refresh-active-service-jobs/index.ts`)

```typescript
// supabase/functions/refresh-active-service-jobs/index.ts
//
// Finds all active service jobs where service_job_status->code is 'A'
// and refreshes their state from the Signature Software ICE API.
//
// Triggered via HTTP GET (or POST) on demand or hourly via pg_cron.

import { createClient } from "[https://esm.sh/@supabase/supabase-js@2](https://esm.sh/@supabase/supabase-js@2)";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SS_CLIENT_ID = Deno.env.get("SS_CLIENT_ID");
const SS_CLIENT_SECRET = Deno.env.get("SS_CLIENT_SECRET");
const SS_PROXY_CLIENT_ID = Deno.env.get("SS_PROXY_CLIENT_ID");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// 1. Authenticate with OAuth endpoint
async function getAccessToken(): Promise<string> {
  const tokenUrl = "[https://auth.signaturesoftware.com.au/connect/token](https://auth.signaturesoftware.com.au/connect/token)";
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SS_CLIENT_ID!,
    client_secret: SS_CLIENT_SECRET!,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token generation failed (${res.status}): ${errText}`);
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

// 3. Map API fields to table columns
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Accepts GET and POST
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ error: `Method ${req.method} not allowed. Use GET.` }, 405);
  }

  try {
    // 1. Verify environment secrets
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return jsonResponse({
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY."
      }, 500);
    }

    if (!SS_CLIENT_ID || !SS_CLIENT_SECRET || !SS_PROXY_CLIENT_ID) {
      return jsonResponse({
        error: "Missing Signature Software secrets (SS_CLIENT_ID, SS_CLIENT_SECRET, SS_PROXY_CLIENT_ID)."
      }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 2. Fetch jobs where status code is strictly 'A'
    const { data: activeJobs, error: dbError } = await supabase
      .from("service_jobs")
      .select("id, service_job_status")
      .contains("service_job_status", { code: "A" });

    if (dbError) {
      throw new Error(`Database query failed: ${dbError.message}`);
    }

    // Double check in memory to ensure code is strictly 'A'
    const targetJobs = (activeJobs || []).filter((job: any) => {
      return job.service_job_status?.code === "A";
    });

    if (targetJobs.length === 0) {
      return jsonResponse({
        message: "No active service jobs with status code 'A' to refresh",
        active_jobs_found: 0,
        refreshed_count: 0,
        failed_count: 0,
      }, 200);
    }

    // 3. Acquire OAuth Token
    const token = await getAccessToken();

    let refreshedCount = 0;
    let failedCount = 0;

    // 4. Update each active job
    for (const record of targetJobs) {
      const jobId = record.id;
      const jobUrl = `[https://apiproxy.signaturesoftware.com.au/api/v1/service/job/$](https://apiproxy.signaturesoftware.com.au/api/v1/service/job/$){jobId}`;

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
              console.error(`Failed upsert for job ${jobId}:`, upsertErr);
              failedCount++;
            } else {
              refreshedCount++;
            }
          }
        } else {
          console.warn(`Job ${jobId} returned status ${res.status}`);
          failedCount++;
        }
      } catch (err) {
        console.error(`Fetch error for job ${jobId}:`, err);
        failedCount++;
      }

      await delay(50); // Rate limit guard
    }

    return jsonResponse({
      message: "Active service jobs refresh completed",
      active_jobs_found: targetJobs.length,
      refreshed_count: refreshedCount,
      failed_count: failedCount,
    }, 200);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Function execution error:", errorMsg);

    return jsonResponse({
      error: errorMsg,
      timestamp: new Date().toISOString(),
    }, 500);
  }
});
```