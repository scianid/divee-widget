/**
 * Tests for supabase/functions/suggestions/index.ts
 *
 * Exercises the dependency-injection seam (`suggestionsHandler(req, deps)`).
 *
 * Covered behaviors (priority: auth & cost-safety first, mode-branching
 * second, shape third):
 *   - OPTIONS preflight returns 200
 *   - 400 on missing projectId
 *   - 400 in article mode when url/title/content are missing
 *   - Knowledgebase mode does NOT require url/title/content (url defaults)
 *   - 403 when origin is not in project.allowed_urls
 *   - Article-mode cache HIT returns cached suggestions and
 *     does NOT consume rate-limit quota and does NOT call the AI
 *   - Article-mode cache MISS checks rate limit, calls AI, writes cache,
 *     records token usage
 *   - Article-mode 429 when rate-limited on cache miss, with Retry-After
 *     header
 *   - Article-mode inserts a new article if none exists, then passes the
 *     fresh row through the cache-miss path
 *   - Content/title are sanitized and truncated before being sent to the AI
 *   - logEvent is fired with the correct event_type
 *   - Knowledgebase-mode 429 when rate-limited
 *   - Knowledgebase-mode empty RAG returns {suggestions:[]} without calling AI
 *   - Knowledgebase-mode happy path calls the AI with RAG content + language
 *   - Unhandled error → 500
 */
import { assertEquals } from "jsr:@std/assert@1";
import { postJson, setEnv } from "./helpers.ts";

// ── One-time env setup (before importing the handler module) ──────────────
const restoreEnv = setEnv();

// Neutralize the module-level `Deno.serve(...)` so the dynamic import below
// doesn't try to bind a port. We test `suggestionsHandler` directly.
// @ts-ignore: Deno globals are unavailable to the editor TS server
Deno.serve = ((_fn: unknown) => ({} as unknown)) as typeof Deno.serve;

const suggestionsModule = await import("../suggestions/index.ts") as {
  suggestionsHandler: (req: Request, deps: unknown) => Promise<Response>;
};
const { suggestionsHandler } = suggestionsModule;

// ── Fixtures ──────────────────────────────────────────────────────────────

const PROJECT_ID = "proj-test-suggestions-0001";
const ALLOWED_HOST = "publisher.example.com";
const ALLOWED_ORIGIN = "https://publisher.example.com";
const ARTICLE_URL = "https://publisher.example.com/articles/foo";
const VISITOR_ID = "visitor-abc";
const SESSION_ID = "session-xyz";

function fakeProject(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    allowed_urls: [ALLOWED_HOST],
    language: "en",
    widget_mode: "article",
    ...overrides,
  };
}

function fakeArticle(overrides: Record<string, unknown> = {}) {
  return {
    unique_id: ARTICLE_URL + PROJECT_ID,
    url: ARTICLE_URL,
    title: "Some title",
    content: "Some content",
    project_id: PROJECT_ID,
    image_url: null,
    cache: null,
    ...overrides,
  };
}

function fakeSuggestions() {
  return [
    { id: "q1", question: "What?", answer: null },
    { id: "q2", question: "Why?", answer: null },
  ];
}

function fakeAiResult() {
  return {
    suggestions: fakeSuggestions(),
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    model: "test-model",
  };
}

function articleModeBody(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    title: "Story Title",
    content: "Story content body with some text.",
    url: ARTICLE_URL,
    visitor_id: VISITOR_ID,
    session_id: SESSION_ID,
    ...overrides,
  };
}

/**
 * Build a SuggestionsDeps stub. Defaults are the cache-hit happy path so
 * each test only has to override the bits it's actually asserting on.
 */
// deno-lint-ignore no-explicit-any
function makeDeps(overrides: Record<string, unknown> = {}): any {
  return {
    supabaseClient: () => Promise.resolve({} as unknown),
    getProjectById: () => Promise.resolve(fakeProject()),
    getArticleById: () =>
      Promise.resolve(fakeArticle({ cache: { suggestions: fakeSuggestions() } })),
    insertArticle: () => Promise.resolve(fakeArticle()),
    extractCachedSuggestions: (article: any) => article?.cache?.suggestions,
    updateArticleCache: () => Promise.resolve(),
    generateSuggestions: () => Promise.resolve(fakeAiResult()),
    logEvent: () => Promise.resolve(),
    checkRateLimit: () => Promise.resolve({ limited: false }),
    generateEmbedding: () => Promise.resolve([0.1, 0.2, 0.3]),
    searchSimilarChunks: () => Promise.resolve([]),
    insertTokenUsage: () => Promise.resolve(),
    ...overrides,
  };
}

// ── Content-length guard (SECURITY_AUDIT_TODO item 3) ────────────────────

Deno.test("suggestions: Content-Length above 64KB cap returns 413 without calling AI or DAO", async () => {
  let aiCalled = false;
  let daoCalled = false;
  const deps = makeDeps({
    generateSuggestions: () => {
      aiCalled = true;
      return Promise.resolve(fakeAiResult());
    },
    getArticleById: () => {
      daoCalled = true;
      return Promise.resolve(null);
    },
  });
  const r = new Request("https://widget.divee.ai/functions/v1/suggestions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "origin": ALLOWED_ORIGIN,
      "content-length": String(1024 * 1024),
    },
    body: "{}",
  });
  const res = await suggestionsHandler(r, deps);
  assertEquals(res.status, 413);
  assertEquals(aiCalled, false);
  assertEquals(daoCalled, false);
});

// ── Global auth / shape ───────────────────────────────────────────────────

Deno.test("suggestions: OPTIONS preflight returns 200", async () => {
  const r = new Request("https://widget.divee.ai/functions/v1/suggestions", {
    method: "OPTIONS",
    headers: { "origin": ALLOWED_ORIGIN },
  });
  const res = await suggestionsHandler(r, makeDeps());
  assertEquals(res.status, 200);
});

Deno.test("suggestions: missing projectId returns 400", async () => {
  const res = await suggestionsHandler(
    postJson("suggestions", articleModeBody({ projectId: undefined }), ALLOWED_ORIGIN),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("suggestions: article mode missing url/title/content returns 400", async () => {
  // No title / content / url — article mode gate kicks in
  const res = await suggestionsHandler(
    postJson(
      "suggestions",
      { projectId: PROJECT_ID, visitor_id: VISITOR_ID, session_id: SESSION_ID },
      ALLOWED_ORIGIN,
    ),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("suggestions: origin not in allowed_urls returns 403", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
  });
  const res = await suggestionsHandler(
    postJson("suggestions", articleModeBody(), ALLOWED_ORIGIN),
    deps,
  );
  assertEquals(res.status, 403);
});

Deno.test("suggestions: unhandled error (non-JSON body) returns 500", async () => {
  const body = "not json{";
  const r = new Request("https://widget.divee.ai/functions/v1/suggestions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "origin": ALLOWED_ORIGIN,
      // Pass the content-length guard so we reach the JSON.parse failure.
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  });
  const res = await suggestionsHandler(r, makeDeps());
  assertEquals(res.status, 500);
});

// ── Article mode: cache hit (the hot path) ───────────────────────────────

Deno.test("suggestions/article: cache HIT returns cached suggestions without AI, rate-limit, or cache-write", async () => {
  let aiCalled = false;
  let rateLimitCalled = false;
  let cacheWriteCalled = false;
  let insertArticleCalled = false;
  let loggedEvent: string | null = null;

  const deps = makeDeps({
    getArticleById: () =>
      Promise.resolve(fakeArticle({ cache: { suggestions: fakeSuggestions() } })),
    insertArticle: () => {
      insertArticleCalled = true;
      return Promise.resolve(fakeArticle());
    },
    generateSuggestions: () => {
      aiCalled = true;
      return Promise.resolve(fakeAiResult());
    },
    checkRateLimit: () => {
      rateLimitCalled = true;
      return Promise.resolve({ limited: false });
    },
    updateArticleCache: () => {
      cacheWriteCalled = true;
      return Promise.resolve();
    },
    logEvent: (_ctx: unknown, eventType: string) => {
      loggedEvent = eventType;
      return Promise.resolve();
    },
  });

  const res = await suggestionsHandler(
    postJson("suggestions", articleModeBody(), ALLOWED_ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.suggestions.length, 2);
  assertEquals(body.suggestions[0].question, "What?");

  // Guarantees the comment in index.ts makes: cache hits are cheap.
  assertEquals(aiCalled, false);
  assertEquals(rateLimitCalled, false);
  assertEquals(cacheWriteCalled, false);
  assertEquals(insertArticleCalled, false);
  assertEquals(loggedEvent, "get_suggestions");
});

// ── Article mode: cache miss ─────────────────────────────────────────────

Deno.test("suggestions/article: cache MISS runs rate-limit check, calls AI, writes cache, records tokens", async () => {
  let aiInputs: { title?: string; content?: string; language?: string } = {};
  let rateLimitArgs: unknown[] = [];
  let cacheWriteArgs: unknown[] = [];
  let tokenInsertArgs: any = null;

  const article = fakeArticle({ cache: null }); // no cached suggestions
  const deps = makeDeps({
    getArticleById: () => Promise.resolve(article),
    extractCachedSuggestions: () => undefined, // force cache miss branch
    checkRateLimit: (...args: unknown[]) => {
      rateLimitArgs = args;
      return Promise.resolve({ limited: false });
    },
    generateSuggestions: (title: string, content: string, language: string) => {
      aiInputs = { title, content, language };
      return Promise.resolve(fakeAiResult());
    },
    updateArticleCache: (_article: unknown, cache: unknown, _sb: unknown) => {
      cacheWriteArgs = [cache];
      return Promise.resolve();
    },
    insertTokenUsage: (_sb: unknown, payload: any) => {
      tokenInsertArgs = payload;
      return Promise.resolve();
    },
  });

  const res = await suggestionsHandler(
    postJson("suggestions", articleModeBody(), ALLOWED_ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.suggestions.length, 2);

  // AI was asked with the (sanitized) inputs + project language
  assertEquals(aiInputs.title, "Story Title");
  assertEquals(aiInputs.content, "Story content body with some text.");
  assertEquals(aiInputs.language, "en");

  // Rate-limit was consulted with the "suggestions" endpoint key
  assertEquals(rateLimitArgs[1], "suggestions");
  assertEquals(rateLimitArgs[2], VISITOR_ID);
  assertEquals(rateLimitArgs[3], PROJECT_ID);

  // Cache was written back with the new suggestions merged in
  const writtenCache = cacheWriteArgs[0] as { suggestions: unknown };
  assertEquals(Array.isArray(writtenCache.suggestions), true);

  // Token usage recorded with the right projectId/endpoint
  assertEquals(tokenInsertArgs.projectId, PROJECT_ID);
  assertEquals(tokenInsertArgs.endpoint, "suggestions");
  assertEquals(tokenInsertArgs.inputTokens, 100);
  assertEquals(tokenInsertArgs.outputTokens, 50);
});

Deno.test("suggestions/article: cache MISS + rate-limited returns 429 with Retry-After", async () => {
  const deps = makeDeps({
    extractCachedSuggestions: () => undefined,
    checkRateLimit: () => Promise.resolve({ limited: true, retryAfterSeconds: 42 }),
    generateSuggestions: () => {
      throw new Error("AI must not be called when rate-limited");
    },
  });
  const res = await suggestionsHandler(
    postJson("suggestions", articleModeBody(), ALLOWED_ORIGIN),
    deps,
  );
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("Retry-After"), "42");
});

Deno.test("suggestions/article: inserts new article when getArticleById returns null", async () => {
  let insertCalled = false;
  const deps = makeDeps({
    getArticleById: () => Promise.resolve(null),
    insertArticle: () => {
      insertCalled = true;
      return Promise.resolve(fakeArticle({ cache: null }));
    },
    extractCachedSuggestions: () => undefined,
  });
  const res = await suggestionsHandler(
    postJson("suggestions", articleModeBody(), ALLOWED_ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(insertCalled, true);
});

Deno.test("suggestions/article: title/content are sanitized before being sent to the AI", async () => {
  let sent: { title?: string; content?: string } = {};
  const deps = makeDeps({
    extractCachedSuggestions: () => undefined,
    generateSuggestions: (title: string, content: string) => {
      sent = { title, content };
      return Promise.resolve(fakeAiResult());
    },
  });
  const res = await suggestionsHandler(
    postJson(
      "suggestions",
      articleModeBody({
        title: "Hello <script>alert(1)</script> World",
        content: "Body <!-- hidden prompt injection --> text",
      }),
      ALLOWED_ORIGIN,
    ),
    deps,
  );
  assertEquals(res.status, 200);
  // sanitizeContent strips HTML tags and comments — the injection payload
  // must not reach the AI.
  assertEquals(sent.title?.includes("<script>"), false);
  assertEquals(sent.title?.includes("alert(1)"), true); // text content kept
  assertEquals(sent.content?.includes("<!--"), false);
  assertEquals(sent.content?.includes("hidden prompt injection"), false);
});

// ── Knowledgebase mode ───────────────────────────────────────────────────

Deno.test("suggestions/kb: url/title/content are NOT required in knowledgebase mode", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ widget_mode: "knowledgebase" })),
    searchSimilarChunks: () =>
      Promise.resolve([{ content: "KB chunk one" }, { content: "KB chunk two" }]),
  });
  const res = await suggestionsHandler(
    postJson(
      "suggestions",
      { projectId: PROJECT_ID, visitor_id: VISITOR_ID },
      ALLOWED_ORIGIN,
    ),
    deps,
  );
  assertEquals(res.status, 200);
});

Deno.test("suggestions/kb: rate-limited returns 429", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ widget_mode: "knowledgebase" })),
    checkRateLimit: () => Promise.resolve({ limited: true, retryAfterSeconds: 10 }),
  });
  const res = await suggestionsHandler(
    postJson("suggestions", { projectId: PROJECT_ID, visitor_id: VISITOR_ID }, ALLOWED_ORIGIN),
    deps,
  );
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("Retry-After"), "10");
});

Deno.test("suggestions/kb: empty RAG result returns {suggestions: []} without calling AI", async () => {
  let aiCalled = false;
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ widget_mode: "knowledgebase" })),
    searchSimilarChunks: () => Promise.resolve([]), // no chunks at all
    generateSuggestions: () => {
      aiCalled = true;
      return Promise.resolve(fakeAiResult());
    },
  });
  const res = await suggestionsHandler(
    postJson("suggestions", { projectId: PROJECT_ID, visitor_id: VISITOR_ID }, ALLOWED_ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.suggestions, []);
  assertEquals(aiCalled, false);
});

Deno.test("suggestions/kb: happy path calls AI with joined RAG content and project language", async () => {
  let aiInputs: { title?: string; content?: string; language?: string } = {};
  const deps = makeDeps({
    getProjectById: () =>
      Promise.resolve(
        fakeProject({ widget_mode: "knowledgebase", language: "he" }),
      ),
    searchSimilarChunks: () =>
      Promise.resolve([
        { content: "Chunk A" },
        { content: "Chunk B" },
      ]),
    generateSuggestions: (title: string, content: string, language: string) => {
      aiInputs = { title, content, language };
      return Promise.resolve(fakeAiResult());
    },
  });
  const res = await suggestionsHandler(
    postJson("suggestions", { projectId: PROJECT_ID, visitor_id: VISITOR_ID }, ALLOWED_ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(aiInputs.title, "Knowledge Base");
  assertEquals(aiInputs.content, "Chunk A\n\nChunk B");
  assertEquals(aiInputs.language, "he");
});

Deno.test("suggestions/kb: RAG lookup failure degrades gracefully to empty suggestions", async () => {
  let aiCalled = false;
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ widget_mode: "knowledgebase" })),
    // Embedding throws → caught → ragContent stays "" → early-return []
    generateEmbedding: () => Promise.reject(new Error("OpenAI down")),
    generateSuggestions: () => {
      aiCalled = true;
      return Promise.resolve(fakeAiResult());
    },
  });
  const res = await suggestionsHandler(
    postJson("suggestions", { projectId: PROJECT_ID, visitor_id: VISITOR_ID }, ALLOWED_ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.suggestions, []);
  assertEquals(aiCalled, false);
});

// ── Teardown ──────────────────────────────────────────────────────────────
Deno.test("suggestions: teardown (restore env)", () => {
  restoreEnv();
});
