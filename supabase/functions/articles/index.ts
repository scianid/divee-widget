import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { supabaseClient } from "../_shared/supabaseClient.ts";
import { getRequestOriginUrl, isAllowedOrigin } from "../_shared/origin.ts";
import { errorResp as sharedErrorResp, successRespWithCache } from "../_shared/responses.ts";

const TAG_WEIGHTS: Record<string, number> = {
  person: 2.0,
  place: 1.5,
  category: 1.0,
};

const cachedResp = (
  body: object,
  maxAge: number,
  sMaxAge: number,
  surrogateKey: string,
) => successRespWithCache(body, maxAge, sMaxAge, surrogateKey);

const errorResp = (message: string, status = 400) => sharedErrorResp(message, status);

// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return errorResp("Method not allowed", 405);
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname;

    // Extract route: last segment after /articles/
    // Handles both /articles/tags and /functions/v1/articles/tags
    const segments = path.split("/").filter(Boolean);
    const route = segments[segments.length - 1];

    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      return errorResp("Missing required parameter: projectId");
    }

    const supabase = await supabaseClient();

    // Validate projectId exists and check origin
    const { data: project, error: projectError } = await supabase
      .from("project")
      .select("project_id, allowed_urls")
      .eq("project_id", projectId)
      .single();

    if (projectError || !project) {
      return errorResp("Invalid projectId");
    }

    const requestUrl = getRequestOriginUrl(req);
    if (!isAllowedOrigin(requestUrl, project.allowed_urls)) {
      console.warn("[Articles] origin not allowed", {
        attempted: requestUrl,
        allowed: project.allowed_urls,
        projectId,
      });
      return errorResp("Origin not allowed", 403);
    }

    const surrogateKey = `articles-${projectId}`;

    switch (route) {
      case "tags":
        return await handleTags(url, projectId, supabase, surrogateKey);
      case "by-tag":
        return await handleByTag(url, projectId, supabase, surrogateKey);
      case "related":
        return await handleRelated(url, projectId, supabase, surrogateKey);
      default:
        return errorResp("Unknown route", 404);
    }
  } catch (err) {
    console.error("[Articles] Error:", err);
    return errorResp("Internal server error", 500);
  }
});

// ─── GET /articles/tags ──────────────────────────────────────────────
async function handleTags(
  url: URL,
  projectId: string,
  supabase: any,
  surrogateKey: string,
) {
  const articleId = url.searchParams.get("articleId");
  if (!articleId) {
    return errorResp("Missing required parameter: articleId");
  }

  console.log("[Articles/tags] Query params:", { articleId, projectId });

  const { data, error } = await supabase
    .from("article_tag")
    .select("tag, tag_type, confidence")
    .eq("article_unique_id", articleId)
    .eq("project_id", projectId)
    .order("confidence", { ascending: false });

  console.log("[Articles/tags] DB result:", {
    rows: data?.length,
    error,
    articleId,
    projectId,
  });

  if (error) {
    console.error("[Articles/tags] DB error:", error);
    return errorResp("Internal server error", 500);
  }

  const tags = (data || []).map((row: any) => ({
    value: row.tag,
    type: row.tag_type,
    confidence: row.confidence,
  }));

  // Don't cache empty results - article may not be indexed yet
  if (tags.length === 0) {
    return sharedErrorResp("No tags found", 404);
  }

  // Cache 5 minutes
  return cachedResp({ tags }, 300, 300, surrogateKey);
}

// ─── GET /articles/by-tag ────────────────────────────────────────────
async function handleByTag(
  url: URL,
  projectId: string,
  supabase: any,
  surrogateKey: string,
) {
  const tag = url.searchParams.get("tag");
  if (!tag) {
    return errorResp("Missing required parameter: tag");
  }

  const tagType = url.searchParams.get("tagType");
  const excludeId = url.searchParams.get("excludeId");
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "20", 10) || 20,
    50,
  );
  const offset = parseInt(url.searchParams.get("offset") || "0", 10) || 0;

  // Build query: join article_tag → article
  let query = supabase
    .from("article_tag")
    .select(`
      confidence,
      article:article_unique_id (
        unique_id,
        title,
        url,
        image_url,
        created_at
      )
    `)
    .eq("project_id", projectId)
    .eq("tag", tag);

  if (tagType) {
    query = query.eq("tag_type", tagType);
  }

  if (excludeId) {
    query = query.neq("article_unique_id", excludeId);
  }

  const { data, error } = await query.range(offset, offset + limit - 1);

  if (error) {
    console.error("[Articles/by-tag] DB error:", error);
    return errorResp("Internal server error", 500);
  }

  const articles = (data || [])
    .filter((row: any) => row.article) // filter out any orphaned tags
    .map((row: any) => ({
      unique_id: row.article.unique_id,
      title: row.article.title,
      url: row.article.url,
      image_url: row.article.image_url,
      created_at: row.article.created_at,
      confidence: row.confidence,
    }));

  if (articles.length === 0) {
    return sharedErrorResp("No articles found", 404);
  }

  // Cache 5 minutes
  return cachedResp({ articles }, 300, 300, surrogateKey);
}

// ─── GET /articles/related ───────────────────────────────────────────
async function handleRelated(
  url: URL,
  projectId: string,
  supabase: any,
  surrogateKey: string,
) {
  const articleId = url.searchParams.get("articleId");
  if (!articleId) {
    return errorResp("Missing required parameter: articleId");
  }

  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "5", 10) || 5,
    20,
  );

  // Step 1: Get the source article's tags
  const { data: sourceTags, error: sourceError } = await supabase
    .from("article_tag")
    .select("tag, tag_type")
    .eq("article_unique_id", articleId)
    .eq("project_id", projectId);

  if (sourceError) {
    console.error("[Articles/related] Source tags DB error:", sourceError);
    return errorResp("Internal server error", 500);
  }

  if (!sourceTags || sourceTags.length === 0) {
    return sharedErrorResp("Article not indexed", 404);
  }

  const tagValues = sourceTags.map((t: any) => t.tag);

  // Step 2: Find all article_tag rows matching those tag values in same project, exclude source
  const { data: matchingTags, error: matchError } = await supabase
    .from("article_tag")
    .select("article_unique_id, tag, tag_type, confidence")
    .eq("project_id", projectId)
    .neq("article_unique_id", articleId)
    .in("tag", tagValues);

  if (matchError) {
    console.error("[Articles/related] Matching tags DB error:", matchError);
    return errorResp("Internal server error", 500);
  }

  if (!matchingTags || matchingTags.length === 0) {
    return cachedResp({ articles: [] }, 300, 300, surrogateKey);
  }

  // Step 3: Score articles by weighted tag overlap
  const scoreMap = new Map<string, { tagCount: number; score: number }>();

  for (const row of matchingTags) {
    const weight = TAG_WEIGHTS[row.tag_type] || 1.0;
    const confidence = parseFloat(row.confidence) || 1.0;
    const entry = scoreMap.get(row.article_unique_id) ||
      { tagCount: 0, score: 0 };
    entry.tagCount += 1;
    entry.score += weight * confidence;
    scoreMap.set(row.article_unique_id, entry);
  }

  // Step 4: Sort by score descending, take top N
  const ranked = [...scoreMap.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);

  if (ranked.length === 0) {
    return cachedResp({ articles: [] }, 300, 300, surrogateKey);
  }

  // Step 5: Fetch article details for top results
  const topIds = ranked.map(([id]) => id);
  const { data: articleDetails, error: detailsError } = await supabase
    .from("article")
    .select("unique_id, title, url, image_url, created_at")
    .in("unique_id", topIds);

  if (detailsError) {
    console.error("[Articles/related] Article details DB error:", detailsError);
    return errorResp("Internal server error", 500);
  }

  // Build lookup map
  const detailsMap = new Map<string, any>();
  for (const a of (articleDetails || [])) {
    detailsMap.set(a.unique_id, a);
  }

  // Merge scores with article details, maintaining score order
  const articles = ranked
    .filter(([id]) => detailsMap.has(id))
    .map(([id, scores]) => {
      const a = detailsMap.get(id);
      return {
        unique_id: a.unique_id,
        title: a.title,
        url: a.url,
        image_url: a.image_url,
        created_at: a.created_at,
        shared_tag_count: scores.tagCount,
        tag_score: parseFloat(scores.score.toFixed(2)),
      };
    });

  // Cache 5 minutes
  return cachedResp({ articles }, 300, 300, surrogateKey);
}
