import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { supabaseClient } from "../_shared/supabaseClient.ts";
import { getRequestOriginUrl, isAllowedOrigin } from "../_shared/origin.ts";
import {
  errorResp as sharedErrorResp,
  successRespWithCache,
  tooManyRequestsResp,
} from "../_shared/responses.ts";
import {
  getArticlesByIds,
  getArticlesByTag,
  getArticleTagsByArticleId,
  getArticleTagsByTagValues,
  getProjectForArticlesAuth,
  getSourceArticleTags,
} from "../_shared/dao/articleDao.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";

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

// ─── Dependency injection seam ────────────────────────────────────────────
// `articlesHandler` accepts an `ArticlesDeps` object so unit tests can stub
// the Supabase DAO calls without touching the network. Production wires the
// real implementations via `realArticlesDeps`. Same pattern as config/chat.
export interface ArticlesDeps {
  supabaseClient: typeof supabaseClient;
  getProjectForArticlesAuth: typeof getProjectForArticlesAuth;
  getArticleTagsByArticleId: typeof getArticleTagsByArticleId;
  getArticlesByTag: typeof getArticlesByTag;
  getSourceArticleTags: typeof getSourceArticleTags;
  getArticleTagsByTagValues: typeof getArticleTagsByTagValues;
  getArticlesByIds: typeof getArticlesByIds;
  checkRateLimit: typeof checkRateLimit;
}

export const realArticlesDeps: ArticlesDeps = {
  supabaseClient,
  getProjectForArticlesAuth,
  getArticleTagsByArticleId,
  getArticlesByTag,
  getSourceArticleTags,
  getArticleTagsByTagValues,
  getArticlesByIds,
  checkRateLimit,
};

export async function articlesHandler(
  req: Request,
  deps: ArticlesDeps = realArticlesDeps,
): Promise<Response> {
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

    const supabase = await deps.supabaseClient();

    // Validate projectId exists and check origin
    const project = await deps.getProjectForArticlesAuth(projectId, supabase);
    if (!project) {
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

    // Rate-limit per project (SECURITY_AUDIT_TODO item 2). Runs AFTER
    // origin check so unauthorized traffic doesn't consume the quota.
    const rateLimit = await deps.checkRateLimit(supabase, "articles", null, projectId);
    if (rateLimit.limited) {
      return tooManyRequestsResp(rateLimit.retryAfterSeconds);
    }

    const surrogateKey = `articles-${projectId}`;

    switch (route) {
      case "tags":
        return await handleTags(url, projectId, supabase, surrogateKey, deps);
      case "by-tag":
        return await handleByTag(url, projectId, supabase, surrogateKey, deps);
      case "related":
        return await handleRelated(url, projectId, supabase, surrogateKey, deps);
      default:
        return errorResp("Unknown route", 404);
    }
  } catch (err) {
    console.error("[Articles] Error:", err);
    return errorResp("Internal server error", 500);
  }
}

// ─── GET /articles/tags ──────────────────────────────────────────────
async function handleTags(
  url: URL,
  projectId: string,
  supabase: any,
  surrogateKey: string,
  deps: ArticlesDeps,
) {
  const articleId = url.searchParams.get("articleId");
  if (!articleId) {
    return errorResp("Missing required parameter: articleId");
  }

  const rows = await deps.getArticleTagsByArticleId(articleId, projectId, supabase);

  const tags = rows.map((row: any) => ({
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
  deps: ArticlesDeps,
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

  const rows = await deps.getArticlesByTag(
    projectId,
    tag,
    tagType,
    excludeId,
    limit,
    offset,
    supabase,
  );

  const articles = rows
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
  deps: ArticlesDeps,
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
  const sourceTags = await deps.getSourceArticleTags(articleId, projectId, supabase);

  if (!sourceTags || sourceTags.length === 0) {
    return sharedErrorResp("Article not indexed", 404);
  }

  const tagValues = sourceTags.map((t: any) => t.tag);

  // Step 2: Find all article_tag rows matching those tag values in same project, exclude source
  const matchingTags = await deps.getArticleTagsByTagValues(
    projectId,
    articleId,
    tagValues,
    supabase,
  );

  if (!matchingTags || matchingTags.length === 0) {
    return cachedResp({ articles: [] }, 300, 300, surrogateKey);
  }

  // Step 3: Score articles by weighted tag overlap
  const scoreMap = new Map<string, { tagCount: number; score: number }>();

  for (const row of matchingTags) {
    const weight = TAG_WEIGHTS[row.tag_type] || 1.0;
    const confidence = parseFloat(String(row.confidence)) || 1.0;
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
  const articleDetails = await deps.getArticlesByIds(topIds, supabase);

  // Build lookup map
  const detailsMap = new Map<string, any>();
  for (const a of articleDetails) {
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

// @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
Deno.serve((req: Request) => articlesHandler(req));
