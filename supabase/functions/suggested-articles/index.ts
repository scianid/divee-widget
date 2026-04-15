import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { projectId, currentUrl, conversationId } = await req.json();

    // Validate required fields
    if (!projectId || !currentUrl) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: projectId, currentUrl",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Validate URL format
    try {
      new URL(currentUrl);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid URL format" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Create Supabase client with service role key (bypass RLS)
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Get round-robin counter from conversation (just for tracking rotation)
    let suggestionIndex = 0;
    if (conversationId) {
      const { data: conversation } = await supabase
        .from("conversations")
        .select("suggestion_index")
        .eq("id", conversationId)
        .single();

      if (conversation) {
        suggestionIndex = conversation.suggestion_index || 0;
      }
    }

    // ========================================
    // FETCH ARTICLES FROM ARTICLE TABLE
    // Filters: same project_id only, exclude current article
    // ========================================
    const { data: recentArticles, error } = await supabase
      .from("article") // ← Source: ARTICLE table
      .select("unique_id, url, title, image_url, cache")
      .eq("project_id", projectId) // ← Filter: same project only
      .neq("url", currentUrl) // ← Exclude current article
      .order("cache->created_at", { ascending: false })
      .limit(10);

    if (error) {
      console.error("[Suggested Articles] Database error:", error);
      return new Response(
        JSON.stringify({ error: "Failed to fetch articles" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // If no articles available, return empty
    if (!recentArticles || recentArticles.length === 0) {
      return new Response(
        JSON.stringify({ suggestion: null }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Randomly select 4 articles from the pool of 10
    const shuffled = [...recentArticles].sort(() => Math.random() - 0.5);
    const selectedArticles = shuffled.slice(0, Math.min(4, shuffled.length));

    // Use round-robin to pick one article from the 4 selected
    const position = suggestionIndex % selectedArticles.length;
    const suggestion = selectedArticles[position];

    // Get image URL from the image_url column
    const imageUrl = suggestion.image_url || null;

    // Update round-robin counter in conversation (for next suggestion rotation)
    if (conversationId) {
      await supabase
        .from("conversations")
        .update({ suggestion_index: suggestionIndex + 1 })
        .eq("id", conversationId);
    }

    // Return suggestion
    return new Response(
      JSON.stringify({
        suggestion: {
          unique_id: suggestion.unique_id,
          url: suggestion.url,
          title: suggestion.title,
          image_url: imageUrl,
        },
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("[Suggested Articles] Error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
