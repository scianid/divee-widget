import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { getRequestOriginUrl, isAllowedOrigin } from "../_shared/origin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { supabaseClient } from "../_shared/supabaseClient.ts";
import { errorResp, successRespWithCache } from "../_shared/responses.ts";
import { getProjectById, getProjectConfigById } from "../_shared/dao/projectDao.ts";

// @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
Deno.serve(async (req: Request) => {
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

    const supabase = await supabaseClient();

    // Fetch project and project_config in parallel
    const [project, projectConfig] = await Promise.all([
      getProjectById(projectId, supabase),
      getProjectConfigById(projectId, supabase),
    ]);

    const requestUrl = getRequestOriginUrl(req);

    // Allow bypass with a secret key passed as ?bypass_key=... (for internal tooling/testing)
    const bypassKey = url.searchParams.get("bypass_key");
    const validBypassKey = Deno.env.get("CONFIG_BYPASS_KEY");
    const isBypassed = !!(validBypassKey && bypassKey === validBypassKey);

    if (bypassKey && !isBypassed) {
      console.warn("config: bypass attempt failed", {
        envKeySet: !!validBypassKey,
        providedKey: bypassKey?.substring(0, 4) + "...",
      });
    }

    if (!isBypassed && !isAllowedOrigin(requestUrl, project.allowed_urls)) {
      console.warn("config: origin not allowed", {
        attempted: requestUrl,
        allowed: project.allowed_urls,
        projectId,
      });
      return errorResp("Origin not allowed", 403);
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
});
