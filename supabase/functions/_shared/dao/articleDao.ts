import { SuggestionItem } from "../ai.ts";

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
