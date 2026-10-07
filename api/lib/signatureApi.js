import { getSupabase } from './supabase.js';

// The token is good for hours but was being re-fetched on every single API call,
// costing an extra sequential round trip each time.
let tokenCache = { token: null, expiresAt: 0 };
const TOKEN_CACHE_MS = 50 * 60 * 1000;

/**
 * Generates an OAuth 2.0 access token via client_credentials, cached until it is
 * close to expiry.
 */
export async function getSignatureToken() {
  if (tokenCache.token && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  const authUrl = (process.env.SIGNATURE_AUTH_URL || 'https://auth.signaturesoftware.com.au').trim();
  const clientId = process.env.SIGNATURE_CLIENT_ID?.trim();
  const clientSecret = process.env.SIGNATURE_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error('Signature API credentials are not configured. Set SIGNATURE_CLIENT_ID and SIGNATURE_CLIENT_SECRET in environment variables.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials'
  });

  const res = await fetch(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Signature auth token request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Signature auth response did not contain an access_token.');
  }

  tokenCache = { token: data.access_token, expiresAt: Date.now() + TOKEN_CACHE_MS };
  return data.access_token;
}

/**
 * Sends request to Signature Software API.
 */
async function callSignatureApi(endpoint, options = {}) {
  const apiBase = (process.env.SIGNATURE_API_BASE || 'https://apiproxy.signaturesoftware.com.au').trim();
  const proxyClientId = process.env.SIGNATURE_PROXY_CLIENT_ID?.trim();

  console.log(`🚀 [STAGE 2] Preparing Signature API request. Proxy client ID: ${proxyClientId ? `configured (length: ${proxyClientId.length})` : 'MISSING OR EMPTY'}.`);
  if (!proxyClientId) {
    throw new Error('SIGNATURE_PROXY_CLIENT_ID is not configured in environment variables.');
  }

  const token = await getSignatureToken();
  const url = `${apiBase.replace(/\/$/, '')}${endpoint}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    'X-ProxyHub-ClientId': proxyClientId,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  console.log(`📦 [STAGE 3] Request body sent to ${url}:\n${options.body || '(no request body)'}`);
  const response = await fetch(url, {
    ...options,
    headers
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`❌ [STAGE 3 FAILED] Signature API returned ${response.status} ${response.statusText}:`, errText || '(empty response body)');
    throw new Error(`Signature API error (${response.status}): ${errText.slice(0, 500)}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return await response.json();
  }
  return await response.text();
}

/**
 * Creates a service job in Signature Software API and saves response to Supabase.
 */
export async function createServiceJob(params) {
  const nowIso = new Date().toISOString();

  // Construct payload with provided fields & safe required defaults
  const payload = {
    BranchId: params.branchId ?? params.branch_id ?? 1,
    JobType: params.jobType ?? params.job_type ?? 'Maintenance',
    ServiceOrderNumber: params.serviceOrderNumber ?? params.service_order_number ?? null,
    FaultDescription: params.faultDescription ?? params.fault_description ?? '',
    ExternalProviderIdentifier: params.externalProviderIdentifier ?? params.external_provider_identifier ?? null,
    ExternalJobIdentifier: params.externalJobIdentifier ?? params.external_job_identifier ?? null,
    ImportSource: params.importSource ?? params.import_source ?? null,
    ExternalJobExtra: params.externalJobExtra ?? params.external_job_extra ?? null,
    WorkOrderCategory: params.workOrderCategory ?? params.work_order_category ?? null,
    UseSameCustomerAsChargeCustomer: params.useSameCustomerAsChargeCustomer ?? params.use_same_customer_as_charge_customer ?? true,
    CustomerId: Number(params.customerId ?? params.customer_id),
    EquipmentId: Number(params.equipmentId ?? params.equipment_id),
    ContractId: (params.contractId ?? params.contract_id) ? Number(params.contractId ?? params.contract_id) : null,
    Created: params.created || nowIso,
    InstallDate: (params.installDate ?? params.install_date) || nowIso,
    ReportedBy: (params.reportedBy ?? params.reported_by) || '',
    JobDate: (params.jobDate ?? params.job_date) || nowIso,
    ResponseDateTime: (params.responseDateTime ?? params.response_date_time) || nowIso,
    ResolutionDateTime: (params.resolutionDateTime ?? params.resolution_date_time) || nowIso,
    ServiceJobExternalMeters: params.serviceJobExternalMeters ?? params.service_job_external_meters ?? [],
    CarryOverNotes: params.carryOverNotes ?? params.carry_over_notes ?? null
  };


  // Clean out nulls if optional
  Object.keys(payload).forEach((key) => {
    if (payload[key] === null) {
      delete payload[key];
    }
  });

  const apiResult = await callSignatureApi('/api/v1/service/job', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  // Save the response to Supabase table
  let supabaseRecordSaved = false;
  let supabaseError = null;
  try {
    const supabase = getSupabase();
    const serviceJobId = typeof apiResult === 'object' && apiResult ? (apiResult.id ?? apiResult.Id ?? apiResult.serviceJobId ?? null) : null;
    
    const insertPayload = {
      job_id: serviceJobId,
      customer_id: payload.CustomerId,
      equipment_id: payload.EquipmentId,
      job_type: payload.JobType,
      fault_description: payload.FaultDescription,
      reported_by: payload.ReportedBy,
      api_response: apiResult,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('created_service_jobs').insert([insertPayload]);
    if (error) {
      // Try fallback table name 'service_jobs' if created_service_jobs doesn't exist
      const { error: fallbackErr } = await supabase.from('service_jobs').insert([insertPayload]);
      if (fallbackErr) {
        supabaseError = error.message || fallbackErr.message;
      } else {
        supabaseRecordSaved = true;
      }
    } else {
      supabaseRecordSaved = true;
    }
  } catch (err) {
    supabaseError = err.message;
    console.warn('Failed to insert service job response into Supabase:', err.message);
  }

  return {
    success: true,
    data: apiResult,
    supabase_saved: supabaseRecordSaved,
    ...(supabaseError ? { supabase_note: `Job created via API, but Supabase record notice: ${supabaseError}` } : {})
  };
}

/**
 * Retrieves a specific service job by ID from Signature Software API with Supabase fallback.
 */
export async function getServiceJobById(id) {
  if (!id) {
    throw new Error('Service job ID is required.');
  }

  try {
    const result = await callSignatureApi(`/api/v1/service/job/${encodeURIComponent(id)}`, {
      method: 'GET'
    });
    return { found: true, source: 'signature_api', data: result };
  } catch (err) {
    // If API returned 404 or failed, check Supabase records for a saved service job
    try {
      const supabase = getSupabase();
      const numId = Number(id);
      
      const { data, error } = await supabase
        .from('created_service_jobs')
        .select('*')
        .or(`job_id.eq.${numId},id.eq.${numId}`)
        .maybeSingle();

      if (data && !error) {
        return {
          found: true,
          source: 'supabase_store',
          note: 'Service job record retrieved from Supabase cache.',
          data
        };
      }

      // Fallback check on service_jobs table
      const { data: fallbackData } = await supabase
        .from('service_jobs')
        .select('*')
        .or(`job_id.eq.${numId},id.eq.${numId}`)
        .maybeSingle();

      if (fallbackData) {
        return {
          found: true,
          source: 'supabase_store',
          note: 'Service job record retrieved from Supabase cache.',
          data: fallbackData
        };
      }
    } catch (dbErr) {
      console.warn('Supabase fallback query error:', dbErr.message);
    }

    // Return structured not found response
    return {
      found: false,
      id,
      message: `No service job was found with ID ${id}.`
    };
  }
}
