import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { enforceContentLength, errorResp, successResp } from "../_shared/responses.ts";
import { supabaseClient } from "../_shared/supabaseClient.ts";
import { getRequestOriginUrl, isAllowedOrigin } from "../_shared/origin.ts";
import {
  getProjectForArticlesAuth,
  getRecentArticlesForProject,
} from "../_shared/dao/articleDao.ts";
import { getSuggestionIndex, updateSuggestionIndex } from "../_shared/dao/conversationDao.ts";

// ─── Dependency injection seam ────────────────────────────────────────────
// `suggestedArticlesHandler` accepts a `SuggestedArticlesDeps` object so
// unit tests can stub the Supabase DAOs AND the random shuffle. The
// `random` field lets tests make the round-robin selection deterministic
// by passing a stable RNG. Same DI pattern as chat/config/articles/etc.
export interface SuggestedArticlesDeps {
  supabaseClient: typeof supabaseClient;
  getProjectForArticlesAuth: typeof getProjectForArticlesAuth;
  getRecentArticlesForProject: typeof getRecentArticlesForProject;
  getSuggestionIndex: typeof getSuggestionIndex;
  updateSuggestionIndex: typeof updateSuggestionIndex;
  random: () => number;
}

export const realSuggestedArticlesDeps: SuggestedArticlesDeps = {
  supabaseClient,
  getProjectForArticlesAuth,
  getRecentArticlesForProject,
  getSuggestionIndex,
  updateSuggestionIndex,
  random: Math.random,
};

export async function suggestedArticlesHandler(
  req: Request,
  deps: SuggestedArticlesDeps = realSuggestedArticlesDeps,
): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // SECURITY_AUDIT_TODO item 3: cap body size BEFORE parsing. The request
  // body is three short fields (projectId, currentUrl, conversationId) —
  // 4KB is generous. Anything bigger is abuse.
  const oversize = enforceContentLength(req, 4096);
  if (oversize) return oversize;

  try {
    const { projectId, currentUrl, conversationId } = await req.json();

    // Validate required fields
    if (!projectId || !currentUrl) {
      return errorResp("Missing required fields: projectId, currentUrl", 400, {
        error: "Missing required fields: projectId, currentUrl",
      });
    }

    // Validate URL format
    try {
      new URL(currentUrl);
    } catch {
      return errorResp("Invalid URL format", 400, { error: "Invalid URL format" });
    }

    const supabase = await deps.supabaseClient();

    // Auth: validate projectId exists and the caller's Origin is in the
    // project's allowed_urls. Closes the "KNOWN GAP" tracked in
    // scripts/check-edge-auth.ts — before this check, anyone who scraped
    // a projectId from a widget snippet could enumerate the article corpus.
    const project = await deps.getProjectForArticlesAuth(projectId, supabase);
    if (!project) {
      return errorResp("Invalid projectId", 400, { error: "Invalid projectId" });
    }

    const requestUrl = getRequestOriginUrl(req);
    if (!isAllowedOrigin(requestUrl, project.allowed_urls)) {
      console.warn("[Suggested Articles] origin not allowed", {
        attempted: requestUrl,
        allowed: project.allowed_urls,
        projectId,
      });
      return errorResp("Origin not allowed", 403, { error: "Origin not allowed" });
    }

    // Get round-robin counter from conversation (just for tracking rotation)
    let suggestionIndex = 0;
    if (conversationId) {
      const idx = await deps.getSuggestionIndex(supabase, conversationId);
      if (idx !== null) suggestionIndex = idx;
    }

    // ========================================
    // FETCH ARTICLES FROM ARTICLE TABLE
    // Filters: same project_id only, exclude current article
    // ========================================
    const recentArticles = await deps.getRecentArticlesForProject(
      supabase,
      projectId,
      currentUrl,
      10,
    );

    // If no articles available, return empty
    if (!recentArticles || recentArticles.length === 0) {
      return successResp({ suggestion: null });
    }

    // Randomly select 4 articles from the pool of 10
    const shuffled = [...recentArticles].sort(() => deps.random() - 0.5);
    const selectedArticles = shuffled.slice(0, Math.min(4, shuffled.length));

    // Use round-robin to pick one article from the 4 selected
    const position = suggestionIndex % selectedArticles.length;
    const suggestion = selectedArticles[position];

    // Get image URL from the image_url column
    const imageUrl = suggestion.image_url || null;

    // Update round-robin counter in conversation (for next suggestion rotation)
    if (conversationId) {
      await deps.updateSuggestionIndex(supabase, conversationId, suggestionIndex + 1);
    }

    // Return suggestion
    return successResp({
      suggestion: {
        unique_id: suggestion.unique_id,
        url: suggestion.url,
        title: suggestion.title,
        image_url: imageUrl,
      },
    });
  } catch (err) {
    console.error("[Suggested Articles] Error:", err);
    return errorResp("Internal server error", 500, { error: "Internal server error" });
  }
}

// @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
Deno.serve((req: Request) => suggestedArticlesHandler(req));
