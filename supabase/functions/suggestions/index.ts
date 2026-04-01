import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getRequestOriginUrl, isAllowedOrigin } from '../_shared/origin.ts';
import { generateSuggestions } from '../_shared/ai.ts';
import { logEvent } from '../_shared/analytics.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResp, successResp } from '../_shared/responses.ts';
import { getProjectById } from '../_shared/dao/projectDao.ts';
import { extractCachedSuggestions, getArticleById, insertArticle, updateArticleCache } from '../_shared/dao/articleDao.ts';
import { supabaseClient } from '../_shared/supabaseClient.ts';
import { MAX_CONTENT_LENGTH, MAX_TITLE_LENGTH, sanitizeContent } from "../_shared/constants.ts";
import { insertTokenUsage } from "../_shared/dao/tokenUsageDao.ts";
import { checkRateLimit } from '../_shared/rateLimit.ts';

// @ts-ignore
Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    let { projectId, title, content, url, visitor_id, session_id, metadata } = await req.json();

    // Truncate then sanitize inputs — mitigates stored prompt injection (C-1)
    if (title) title = sanitizeContent(title.substring(0, MAX_TITLE_LENGTH));
    if (content) content = sanitizeContent(content.substring(0, MAX_CONTENT_LENGTH));

    if (!projectId) {
      console.error(`suggestions: missing projectId in request, url: ${req.url}`);
      return errorResp('suggestions: missing projectId', 400, { suggestions: [] });
    }
    // Validate required fields
    if (!url || !title || !content) 
      return errorResp('suggestions: missing required fields:url,title,content', 400, { suggestions: [] });

    // Initialize Supabase client with service role key (bypasses RLS)
    const supabase = await supabaseClient();

    const project = await getProjectById(projectId, supabase);
    const requestUrl = getRequestOriginUrl(req);

    if (!isAllowedOrigin(requestUrl, project?.allowed_urls)) {
      console.warn('suggestions: origin not allowed', { attempted: requestUrl, allowed: project?.allowed_urls, projectId });
      return errorResp('suggestions: origin not allowed', 403, { suggestions: [] });
    }

    // Track Event (Async)
    logEvent({
      projectId,
      visitorId: visitor_id,
      sessionId: session_id,
      url,
    }, 'get_suggestions');

    let article = await getArticleById(url, projectId, supabase);

    if (!article) {
      article = await insertArticle(url, title, content, projectId, supabase, metadata);
    }

    // Return cached suggestions if available — cache hits are cheap and don't consume rate limit quota
    const cachedSuggestions = extractCachedSuggestions(article);
    
    if (cachedSuggestions)
      return successResp({ suggestions: cachedSuggestions });

    // H-2 fix: enforce per-visitor and per-project rate limits before hitting the AI
    // Only runs when a real AI call is needed (cache miss)
    const rateLimit = await checkRateLimit(supabase, 'suggestions', visitor_id, projectId);
    if (rateLimit.limited) {
      return new Response(
        JSON.stringify({ error: 'Too many requests', retryAfter: rateLimit.retryAfterSeconds }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(rateLimit.retryAfterSeconds) } }
      );
    }

    // Fallback: generate hard-coded suggestions
    console.log('suggestions: cache miss, generating');
    const result = await generateSuggestions(title, content, project?.language || 'en');
    const { suggestions, tokenUsage, model } = result;
    console.log('suggestions: ai result', { suggestions, tokenUsage });

    // Track token usage (async, don't block)
    if (tokenUsage) {
      console.log('suggestions: inserting token usage', tokenUsage);
      insertTokenUsage(supabase, {
        projectId,
        visitorId: visitor_id,
        sessionId: session_id,
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        model,
        endpoint: 'suggestions',
        metadata: {
          article_url: url,
          article_id: article?.unique_id || null,
          language: project?.language || 'en'
        }
      }).then(() => console.log('suggestions: token usage tracked successfully')).catch(err => console.error('suggestions: failed to track tokens', err));
    } else {
      console.log('suggestions: no token usage data from AI provider');
    }

    // Cache suggestions on the article (preserve existing metadata)
    const updatedCache = {
      ...article.cache,
      suggestions,
      created_at: article.cache?.created_at || new Date().toISOString()
    };
    await updateArticleCache(article, updatedCache, supabase);

    return successResp({ suggestions });

  } catch (error: any) {
    console.error('suggestions: unhandled error', error);
    console.error('Error:', error);
    return errorResp(error.message, 500);
  }
});
