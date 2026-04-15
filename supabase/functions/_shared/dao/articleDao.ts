import { SuggestionItem } from "../ai.ts";

export async function getProjectForArticlesAuth(
  projectId: string,
  supabase: any,
): Promise<{ project_id: string; allowed_urls: string[] } | null> {
  const { data, error } = await supabase
    .from("project")
    .select("project_id, allowed_urls")
    .eq("project_id", projectId)
    .single();
  if (error || !data) return null;
  return data;
}

export async function getArticleTagsByArticleId(
  articleId: string,
  projectId: string,
  supabase: any,
): Promise<Array<{ tag: string; tag_type: string; confidence: number }>> {
  const { data, error } = await supabase
    .from("article_tag")
    .select("tag, tag_type, confidence")
    .eq("article_unique_id", articleId)
    .eq("project_id", projectId)
    .order("confidence", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getArticlesByTag(
  projectId: string,
  tag: string,
  tagType: string | null,
  excludeId: string | null,
  limit: number,
  offset: number,
  supabase: any,
): Promise<any[]> {
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

  if (tagType) query = query.eq("tag_type", tagType);
  if (excludeId) query = query.neq("article_unique_id", excludeId);

  const { data, error } = await query.range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

export async function getSourceArticleTags(
  articleId: string,
  projectId: string,
  supabase: any,
): Promise<Array<{ tag: string; tag_type: string }>> {
  const { data, error } = await supabase
    .from("article_tag")
    .select("tag, tag_type")
    .eq("article_unique_id", articleId)
    .eq("project_id", projectId);
  if (error) throw error;
  return data || [];
}

export async function getArticleTagsByTagValues(
  projectId: string,
  articleId: string,
  tagValues: string[],
  supabase: any,
): Promise<
  Array<{ article_unique_id: string; tag: string; tag_type: string; confidence: number }>
> {
  const { data, error } = await supabase
    .from("article_tag")
    .select("article_unique_id, tag, tag_type, confidence")
    .eq("project_id", projectId)
    .neq("article_unique_id", articleId)
    .in("tag", tagValues);
  if (error) throw error;
  return data || [];
}

export async function getArticlesByIds(
  ids: string[],
  supabase: any,
): Promise<any[]> {
  const { data, error } = await supabase
    .from("article")
    .select("unique_id, title, url, image_url, created_at")
    .in("unique_id", ids);
  if (error) throw error;
  return data || [];
}

export async function getArticleById(
  url: string,
  projectId: string,
  supabase: any,
) {
  // Look for article by URL
  const { data: article, error: articleError } = await supabase
    .from("article")
    .select("*")
    .eq("unique_id", url + projectId)
    .maybeSingle();

  if (articleError) {
    console.error("suggestions: article lookup error", articleError);
    throw articleError;
  }

  return article;
}

export async function insertArticle(
  url: string,
  title: string,
  content: string,
  projectId: string,
  supabase: any,
  metadata?: {
    image_url?: string | null;
    og_image?: string | null;
    created_at?: string;
  },
) {
  const cacheData: any = {
    created_at: metadata?.created_at || new Date().toISOString(),
  };

  // Prioritize og_image over image_url for featured image
  const imageUrl = metadata?.og_image || metadata?.image_url || null;

  const article = {
    unique_id: url + projectId,
    url,
    title,
    content,
    cache: cacheData,
    image_url: imageUrl,
    project_id: projectId,
  };

  const { error: insertError } = await supabase
    .from("article")
    .insert(article);

  if (insertError) {
    console.error("suggestions: article insert error", insertError);
    throw insertError;
  }

  console.log("suggestions: inserted new article", { url });
  return article;
}

export function extractCachedSuggestions(article: any) {
  const cachedSuggestions = (article?.cache as {
    suggestions?: { id: string; question: string; answer: string | null }[];
  } | null)?.suggestions;
  if (Array.isArray(cachedSuggestions) && cachedSuggestions.length > 0) {
    console.log("suggestions: cache hit", { count: cachedSuggestions.length });
    return cachedSuggestions;
  }
}

export async function updateArticleCache(
  article: any,
  cache: Record<string, any>,
  supabase: any,
) {
  await supabase
    .from("article")
    .update({ cache })
    .eq("unique_id", article.unique_id);
  console.log("suggestions: cached", { count: cache.suggestions?.length || 0 });
}

export async function updateArticleImage(
  article: any,
  imageUrl: string,
  supabase: any,
) {
  await supabase
    .from("article")
    .update({ image_url: imageUrl })
    .eq("unique_id", article.unique_id);
  console.log("article: updated image_url");
}

export async function updateCacheAnswer(
  supabase: any,
  unique_id: any,
  questionId: string,
  question: string,
  answer: string,
) {
  console.log("updateCacheAnswer start");

  const { data: articleData, error } = await supabase
    .from("article")
    .select("cache")
    .eq("unique_id", unique_id)
    .maybeSingle();

  if (error) {
    console.error("chat: failed to fetch article for caching answer", error);
    return;
  }

  const cache = (articleData?.cache ?? {}) as {
    suggestions?: SuggestionItem[];
  };

  const suggestions = Array.isArray(cache.suggestions) ? cache.suggestions.slice() : [];
  const idx = suggestions.findIndex((s) => s.id === questionId);

  if (idx >= 0) {
    suggestions[idx] = { ...suggestions[idx], question, answer };
  } else {
    suggestions.push({ id: questionId, question, answer });
  }

  await supabase
    .from("article")
    .update({ cache: { suggestions } })
    .eq("unique_id", unique_id);
}
