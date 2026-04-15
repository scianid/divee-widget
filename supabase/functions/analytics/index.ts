import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getRequestOriginUrl, isAllowedOrigin } from "../_shared/origin.ts";
import { supabaseClient } from "../_shared/supabaseClient.ts";
import { getProjectById } from "../_shared/dao/projectDao.ts";

// analytics_impressions and analytics_events tables are deprecated.
// This function now reverse-proxies all analytics traffic to the secondary
// project's analytics endpoint (configured via ANALYTICS_PROXY_URL).
// Origin validation is still enforced locally before forwarding.

// ─── Dependency injection seam ────────────────────────────────────────────
// `analyticsHandler` accepts an `AnalyticsDeps` object so unit tests can
// stub the Supabase DAO + the outbound fetch without touching the network.
// Production wires the real implementations via `realAnalyticsDeps`. Same
// pattern as chat/config/articles/etc.
export interface AnalyticsDeps {
  supabaseClient: typeof supabaseClient;
  getProjectById: typeof getProjectById;
  fetchFn: typeof fetch;
}

export const realAnalyticsDeps: AnalyticsDeps = {
  supabaseClient,
  getProjectById,
  fetchFn: fetch,
};

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function analyticsHandler(
  req: Request,
  deps: AnalyticsDeps = realAnalyticsDeps,
): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Read raw body once so we can both parse it (for validation) and forward it
    let rawBody: string;
    let body: Record<string, unknown>;
    try {
      rawBody = await req.text();
      body = JSON.parse(rawBody);
    } catch {
      return jsonResp({ error: "Invalid or empty request body" }, 400);
    }

    // Resolve project_id from single event or first batch event
    const projectId = (body.project_id as string | undefined) ||
      (Array.isArray(body.batch) && body.batch.length > 0
        ? (body.batch[0] as Record<string, unknown>).project_id as
          | string
          | undefined
        : undefined);

    if (!projectId) {
      return jsonResp({ error: "Missing required field: project_id" }, 400);
    }

    // Validate project exists and origin is allowed
    const supabase = await deps.supabaseClient();
    let project;
    try {
      project = await deps.getProjectById(projectId, supabase);
    } catch {
      return jsonResp({ error: "Invalid project_id" }, 404);
    }

    const requestUrl = getRequestOriginUrl(req);
    if (!isAllowedOrigin(requestUrl, project.allowed_urls)) {
      console.warn("analytics: origin not allowed", {
        attempted: requestUrl,
        projectId,
      });
      return jsonResp({ error: "Origin not allowed" }, 403);
    }

    // Forward to secondary project's analytics endpoint
    // @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
    const proxyUrl = Deno.env.get("ANALYTICS_PROXY_URL");
    if (!proxyUrl) {
      console.error("analytics: ANALYTICS_PROXY_URL is not configured");
      return jsonResp({ error: "Analytics proxy not configured" }, 503);
    }

    const forwardHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // H-1: forward the authoritative Cloudflare IP header for geo enrichment
    const clientIp = req.headers.get("cf-connecting-ip");
    if (clientIp) forwardHeaders["cf-connecting-ip"] = clientIp;

    const referer = req.headers.get("referer");
    if (referer) forwardHeaders["referer"] = referer;

    const origin = req.headers.get("origin");
    if (origin) forwardHeaders["origin"] = origin;

    const proxyResponse = await deps.fetchFn(proxyUrl, {
      method: "POST",
      headers: forwardHeaders,
      body: rawBody,
    });

    const proxyBody = await proxyResponse.text();

    return new Response(proxyBody, {
      status: proxyResponse.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error proxying analytics event:", error);
    return jsonResp({ error: "Internal server error" }, 500);
  }
}

// @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
Deno.serve((req: Request) => analyticsHandler(req));
