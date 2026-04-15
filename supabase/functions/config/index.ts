import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { getRequestOriginUrl, isAllowedOrigin } from "../_shared/origin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { supabaseClient } from "../_shared/supabaseClient.ts";
import { errorResp, successRespWithCache, tooManyRequestsResp } from "../_shared/responses.ts";
import { getProjectById, getProjectConfigById } from "../_shared/dao/projectDao.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { verifyConfigBypassToken } from "../_shared/configBypassToken.ts";

// ─── Dependency injection seam ────────────────────────────────────────────
// `configHandler` takes a `ConfigDeps` object so unit tests can stub the
// Supabase DAO calls without touching the network. Production wires the
// real implementations below via `realConfigDeps`. Tests construct their
// own stubs and call `configHandler` directly. Same pattern as chat.
export interface ConfigDeps {
  supabaseClient: typeof supabaseClient;
  getProjectById: typeof getProjectById;
  getProjectConfigById: typeof getProjectConfigById;
  checkRateLimit: typeof checkRateLimit;
  verifyConfigBypassToken: typeof verifyConfigBypassToken;
}

export const realConfigDeps: ConfigDeps = {
  supabaseClient,
  getProjectById,
  getProjectConfigById,
  checkRateLimit,
  verifyConfigBypassToken,
};

export async function configHandler(
  req: Request,
  deps: ConfigDeps = realConfigDeps,
): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get projectId from query params (GET request)
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId") ||
      url.searchParams.get("client_id");

    if (!projectId) {
      console.error(`config: missing projectId in request, url: ${req.url}`);
      return errorResp("Missing projectId", 400);
    }

    const supabase = await deps.supabaseClient();

    // Fetch project and project_config in parallel
    const [project, projectConfig] = await Promise.all([
      deps.getProjectById(projectId, supabase),
      deps.getProjectConfigById(projectId, supabase),
    ]);

    const requestUrl = getRequestOriginUrl(req);

    // SECURITY_AUDIT_TODO item 7: the bypass is now a short-lived
    // HMAC-signed token carrying an operator identifier and explicit
    // expiry — not a static shared secret. See
    // _shared/configBypassToken.ts for the rationale.
    //
    // The bypass token is accepted from either the `bypass_token` query
    // param (for quick curl use) or the `x-config-bypass-token` header
    // (for tooling that prefers headers). Both must pass the same
    // verification; we pick whichever is supplied.
    const bypassToken = url.searchParams.get("bypass_token") ??
      req.headers.get("x-config-bypass-token");

    let isBypassed = false;
    if (bypassToken) {
      const verified = await deps.verifyConfigBypassToken(bypassToken);
      if (verified) {
        isBypassed = true;
        // Attribution log. `operator` is an allowlisted ASCII identifier,
        // and the raw token is never logged — incident response can
        // still correlate by operator + timestamp.
        console.warn("config: bypass token accepted", {
          operator: verified.operator,
          expiresMs: verified.expiresMs,
          projectId,
        });
      } else {
        console.warn("config: bypass token rejected", {
          tokenPrefix: bypassToken.substring(0, 8) + "...",
          projectId,
        });
      }
    }

    if (!isBypassed && !isAllowedOrigin(requestUrl, project.allowed_urls)) {
      console.warn("config: origin not allowed", {
        attempted: requestUrl,
        allowed: project.allowed_urls,
        projectId,
      });
      return errorResp("Origin not allowed", 403);
    }

    // Rate-limit per project (SECURITY_AUDIT_TODO item 2). Runs AFTER
    // origin check so unauthorized traffic never consumes the quota.
    // visitor_id is unknown at config time (called on initial widget
    // mount), so we only check the project-level bucket.
    const rateLimit = await deps.checkRateLimit(supabase, "config", null, projectId);
    if (rateLimit.limited) {
      return tooManyRequestsResp(rateLimit.retryAfterSeconds);
    }

    // Map database fields to widget config format
    const config = {
      direction: project.direction || "ltr",
      language: project.language || "en",
      icon_url: project.icon_url || "",
      client_name: project.client_name || "",
      client_description: project.client_description || "",
      highlight_color: project.highlight_color || ["#68E5FD", "#A389E0"],
      show_ad: typeof project.show_ad === "boolean" ? project.show_ad : true,
      input_text_placeholders: project.input_text_placeholders || [
        "Ask anything about this article...",
      ],
      display_mode: project.display_mode || "anchored",
      display_position: ["bottom-left", "bottom-right"].includes(project.display_position)
        ? project.display_position
        : "bottom-right",
      anchored_position: ["top", "bottom"].includes(project.display_position)
        ? project.display_position
        : "bottom",
      article_class: project.article_class || null,
      widget_container_class: project.widget_container_class || null,
      override_mobile_container_selector: project.override_mobile_container_selector || null,
      disclaimer_text: project.disclaimer_text || null,
      widget_mode: project.widget_mode || "article",
      ask_concent: project.ask_concent === true,
      allowed_urls: project.allowed_urls || [],
      // Merge project_config fields (e.g., ad tag ID, ad size overrides)
      ...(projectConfig && {
        ad_tag_id: projectConfig.ad_tag_id || null,
        override_mobile_ad_size: projectConfig.override_mobile_ad_size || null,
        override_desktop_ad_size: projectConfig.override_desktop_ad_size ||
          null,
        white_label: projectConfig.white_label || false,
      }),
    };

    return successRespWithCache(config);
  } catch (error) {
    console.error("Error:", error);
    return errorResp("Internal Server Error", 500);
  }
}

// @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
Deno.serve((req: Request) => configHandler(req));
