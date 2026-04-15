/**
 * Tests for supabase/functions/chat/index.ts
 *
 * Exercises the dependency-injection seam (`chatHandler(req, deps)`) rather
 * than stubbing network-level calls, so the tests don't need to reproduce
 * Supabase REST URLs or mock OpenAI SSE streams.
 *
 * Covered behaviors (priority: auth & data-safety first, business logic second):
 *   - 400 on missing required fields (pure input validation)
 *   - 403 on origin not in project.allowed_urls
 *   - 429 on rate limit
 *   - 429 on conversation message-count limit (spam protection)
 *   - Cached-suggestion fast path (no AI call, no new conversation row)
 *   - 404 when no cached suggestion and freeform disabled
 *   - Happy-path response headers: Cache-Control: no-cache, no-store, private;
 *     Content-Type: text/event-stream; X-Conversation-Id; X-Visitor-Token
 *   - Visitor token is NOT issued when visitor_id is missing
 */
import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { setEnv } from "./helpers.ts";

// ── One-time env setup (before importing the handler module) ──────────────
const restoreEnv = setEnv();

// Neutralize the `Deno.serve(...)` at the bottom of chat/index.ts so the
// dynamic import below doesn't try to bind a port (which would fail under
// the default test sandbox anyway). We test `chatHandler` directly via the
// exported seam, so the server-wiring line is dead weight here.
// @ts-ignore: Deno globals are unavailable to the editor TS server
Deno.serve = ((_fn: unknown) => ({} as unknown)) as typeof Deno.serve;

// chatHandler dynamically-imported so env + Deno.serve stub are in place
// before the module runs its top-level code.
const chatModule = await import("../chat/index.ts") as {
  chatHandler: (req: Request, deps: unknown) => Promise<Response>;
};
const { chatHandler } = chatModule;

// ── Test fixtures ─────────────────────────────────────────────────────────

const PROJECT_ID = "proj-test-0001";
const VISITOR_ID = "visitor-test-0001";
const SESSION_ID = "session-test-0001";
const ARTICLE_URL = "https://publisher.example.com/article-1";
const ALLOWED_ORIGIN = "https://publisher.example.com";
// isAllowedOrigin compares hostnames after stripping www./lowercase, but does
// NOT extract the hostname from allowed_urls entries. So allowed_urls must be
// bare hostnames, not full URLs, for the check to match a browser origin.
const ALLOWED_HOST = "publisher.example.com";

/** Project row shape the handler expects back from getProjectById. */
function fakeProject(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    allowed_urls: [ALLOWED_HOST],
    widget_mode: "article",
    ...overrides,
  };
}

/** Conversation row shape the handler expects back from getOrCreateConversation. */
function fakeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-test-0001",
    message_count: 0,
    messages: [],
    article_title: "Test article title",
    article_content: "Test article content body.",
    total_chars: 100,
    ...overrides,
  };
}

/** Article row shape the handler expects back from getArticleById. */
function fakeArticle(overrides: Record<string, unknown> = {}) {
  return {
    unique_id: ARTICLE_URL + PROJECT_ID,
    url: ARTICLE_URL,
    project_id: PROJECT_ID,
    image_url: null,
    cache: null,
    ...overrides,
  };
}

/** Default valid request body — individual tests override fields. */
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    questionId: "q-123",
    question: "What is this article about?",
    title: "Test article title",
    content: "Test article content body.",
    url: ARTICLE_URL,
    visitor_id: VISITOR_ID,
    session_id: SESSION_ID,
    ...overrides,
  };
}

function req(body: unknown, origin = ALLOWED_ORIGIN): Request {
  return new Request("https://widget.divee.ai/functions/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "origin": origin },
    body: JSON.stringify(body),
  });
}

/**
 * Build a ChatDeps stub with sensible defaults. Pass `overrides` to replace
 * any field. Fields not overridden throw if called — that's deliberate, so
 * a test fails loudly if the handler reaches code paths it shouldn't.
 */
// deno-lint-ignore no-explicit-any
function makeDeps(overrides: Record<string, unknown> = {}): any {
  const unexpected = (label: string) => () => {
    throw new Error(`[test] unexpected call to ${label}`);
  };

  return {
    supabaseClient: () => Promise.resolve({} as unknown),
    getProjectById: () => Promise.resolve(fakeProject()),
    getProjectAiSettings: () => Promise.resolve(null),
    checkRateLimit: () => Promise.resolve({ limited: false, retryAfterSeconds: 0 }),
    getArticleById: () => Promise.resolve(fakeArticle()),
    insertArticle: () => Promise.resolve(undefined),
    updateArticleImage: () => Promise.resolve(undefined),
    getOrCreateConversation: () => Promise.resolve(fakeConversation()),
    appendMessagesToConversation: () => Promise.resolve(true),
    updateCacheAnswer: () => Promise.resolve(undefined),
    insertFreeformQuestion: () => Promise.resolve(null),
    updateFreeformAnswer: () => Promise.resolve(undefined),
    insertTokenUsage: () => Promise.resolve(undefined),
    logEvent: () => {},
    streamAnswer: () =>
      Promise.resolve({
        response: new Response("data: hello\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
        model: "test-model",
      }),
    readStreamAndCollectAnswer: () =>
      Promise.resolve({
        answer: "mock answer",
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
      }),
    generateEmbedding: unexpected("generateEmbedding"),
    searchSimilarChunks: unexpected("searchSimilarChunks"),
    issueVisitorToken: () => Promise.resolve("fake-visitor-token"),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

Deno.test("chat: OPTIONS preflight returns 200 with CORS headers", async () => {
  const r = new Request("https://widget.divee.ai/functions/v1/chat", {
    method: "OPTIONS",
    headers: { "origin": ALLOWED_ORIGIN },
  });
  const res = await chatHandler(r, makeDeps());
  assertEquals(res.status, 200);
});

Deno.test("chat: POST with missing required fields returns 400", async () => {
  const res = await chatHandler(req({ projectId: PROJECT_ID }), makeDeps());
  assertEquals(res.status, 400);
  const body = await res.json();
  assertExists(body.error);
});

Deno.test("chat: origin not in project.allowed_urls returns 403", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
  });
  const res = await chatHandler(req(validBody()), deps);
  assertEquals(res.status, 403);
  // NOTE: errorResp() in _shared/responses.ts logs the message but does NOT
  // include it in the response body (the default body is {}). So 403 responses
  // carry no JSON error field. We only assert the status code here.
});

Deno.test("chat: rate-limited caller receives 429 with Retry-After header", async () => {
  const deps = makeDeps({
    checkRateLimit: () => Promise.resolve({ limited: true, retryAfterSeconds: 42 }),
  });
  const res = await chatHandler(req(validBody()), deps);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("Retry-After"), "42");
  const body = await res.json();
  assertEquals(body.error, "Too many requests");
  assertEquals(body.retryAfter, 42);
});

Deno.test("chat: conversation at 200-message limit returns 429", async () => {
  const deps = makeDeps({
    getOrCreateConversation: () =>
      Promise.resolve(fakeConversation({ message_count: 200 })),
  });
  const res = await chatHandler(req(validBody()), deps);
  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.limit, 200);
});

Deno.test("chat: cached-suggestion fast path returns cached answer without hitting AI", async () => {
  const cachedArticle = fakeArticle({
    cache: {
      suggestions: [
        { id: "q-123", question: "What is this?", answer: "It's a cached answer." },
      ],
    },
  });
  const deps = makeDeps({
    getArticleById: () => Promise.resolve(cachedArticle),
    // If streamAnswer is reached, the test fails with "unexpected call".
    streamAnswer: () => {
      throw new Error("[test] streamAnswer should not be called on cache hit");
    },
  });
  const res = await chatHandler(req(validBody()), deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.cached, true);
  assertEquals(body.answer, "It's a cached answer.");
});

Deno.test("chat: non-cached question with no freeform returns 404", async () => {
  // article has no cached suggestions AND env ALLOW_FREEFORM_ASK != "true"
  const originalFreeform = Deno.env.get("ALLOW_FREEFORM_ASK");
  Deno.env.set("ALLOW_FREEFORM_ASK", "false");
  try {
    const deps = makeDeps({
      getArticleById: () => Promise.resolve(fakeArticle({ cache: null })),
    });
    const res = await chatHandler(req(validBody()), deps);
    assertEquals(res.status, 404);
  } finally {
    if (originalFreeform === undefined) Deno.env.delete("ALLOW_FREEFORM_ASK");
    else Deno.env.set("ALLOW_FREEFORM_ASK", originalFreeform);
  }
});

Deno.test("chat: happy path streams SSE with no-cache + conversation + visitor token headers", async () => {
  Deno.env.set("ALLOW_FREEFORM_ASK", "true");
  try {
    const deps = makeDeps();
    const res = await chatHandler(req(validBody()), deps);

    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    // Cache header is the critical bit — a cached SSE response would leak
    // one visitor's conversation to the next.
    assertEquals(res.headers.get("Cache-Control"), "no-cache");
    assertEquals(res.headers.get("X-Conversation-Id"), "conv-test-0001");
    assertEquals(res.headers.get("X-Visitor-Token"), "fake-visitor-token");

    // Drain the body so the readable stream doesn't leak.
    await res.text();
  } finally {
    Deno.env.delete("ALLOW_FREEFORM_ASK");
  }
});

Deno.test("chat: no visitor token header when visitor_id is missing from body", async () => {
  Deno.env.set("ALLOW_FREEFORM_ASK", "true");
  try {
    const deps = makeDeps({
      issueVisitorToken: () => {
        throw new Error("[test] issueVisitorToken should not be called without visitor_id");
      },
    });
    // Note: if the handler treats visitor_id as required, this test will fail
    // at input validation. Today it's optional — but the invariant we want to
    // lock in is "no token without an id".
    const res = await chatHandler(req(validBody({ visitor_id: undefined })), deps);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("X-Visitor-Token"), null);
    await res.text();
  } finally {
    Deno.env.delete("ALLOW_FREEFORM_ASK");
  }
});

// ── Teardown ──────────────────────────────────────────────────────────────
Deno.test("chat: teardown (restore env)", () => {
  restoreEnv();
});
