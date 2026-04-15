// @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getRequestOriginUrl, isAllowedOrigin } from "../_shared/origin.ts";
import { supabaseClient } from "../_shared/supabaseClient.ts";
import { getProjectById } from "../_shared/dao/projectDao.ts";

// analytics_impressions and analytics_events tables are deprecated.
// This function now reverse-proxies all analytics traffic to the secondary
// project's analytics endpoint (configured via ANALYTICS_PROXY_URL).
// Origin validation is still enforced locally before forwarding.

serve(async (req: Request) => {
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
      return new Response(
        JSON.stringify({ error: "Invalid or empty request body" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Resolve project_id from single event or first batch event
    const projectId = (body.project_id as string | undefined) ||
      (Array.isArray(body.batch) && body.batch.length > 0
        ? (body.batch[0] as Record<string, unknown>).project_id as
          | string
          | undefined
        : undefined);

    if (!projectId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: project_id" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Validate project exists and origin is allowed
    const supabase = await supabaseClient();
    let project;
    try {
      project = await getProjectById(projectId, supabase);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid project_id" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const requestUrl = getRequestOriginUrl(req);
    if (!isAllowedOrigin(requestUrl, project.allowed_urls)) {
      console.warn("analytics: origin not allowed", {
        attempted: requestUrl,
        projectId,
      });
      return new Response(
        JSON.stringify({ error: "Origin not allowed" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Forward to secondary project's analytics endpoint
    // @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
    const proxyUrl = Deno.env.get("ANALYTICS_PROXY_URL");
    if (!proxyUrl) {
      console.error("analytics: ANALYTICS_PROXY_URL is not configured");
      return new Response(
        JSON.stringify({ error: "Analytics proxy not configured" }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
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

    const proxyResponse = await fetch(proxyUrl, {
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
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
