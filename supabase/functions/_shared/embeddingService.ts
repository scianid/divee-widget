const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_URL = "https://api.openai.com/v1/embeddings";

/**
 * Generate a vector embedding for the given text using OpenAI text-embedding-3-small.
 * Returns a 1536-dimensional float array.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const response = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.substring(0, 8192), // API hard limit
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = await response.json() as {
    data: Array<{ embedding: number[] }>;
  };
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("Embedding API returned empty result");
  }
  return embedding;
}
