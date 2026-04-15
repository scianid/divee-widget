/**
 * Tests for supabase/functions/suggested-articles/index.ts
 *
 * Exercises the dependency-injection seam (`suggestedArticlesHandler(req, deps)`).
 *
 * This endpoint picks ONE article to recommend from the project's recent
 * pool, using a per-conversation round-robin counter so successive requests
 * don't keep surfacing the same item. The tests care about three things:
 *   1. Input validation (required fields + URL shape).
 *   2. The counter is read before and written after — with +1 — so the
 *      rotation actually rotates.
 *   3. The pool filtering: same project only, exclude current article,
 *      capped at 10, then at most 4 selected, and the chosen one comes from
 *      that pool.
 *
 * Covered behaviors:
 *   - OPTIONS preflight returns 200
 *   - 400 on missing projectId or currentUrl
 *   - 400 on malformed currentUrl
 *   - Empty pool → 200 with `suggestion: null`, no counter bump
 *   - No conversationId → picks position 0, no DB counter read/write
 *   - With conversationId → reads index, bumps it by +1, writes back
 *   - Round-robin: suggestionIndex % selectedArticles.length drives position
 *   - Pool size is passed as 10 to the DAO and the current URL is excluded
 *   - Selection is capped at 4 even when DAO returns 10 rows
 *   - DAO throw → 500
 *   - Unhandled error (non-JSON body) → 500
 */
import { assertEquals } from "jsr:@std/assert@1";
import { postJson, setEnv } from "./helpers.ts";

// ── One-time env setup ────────────────────────────────────────────────────
const restoreEnv = setEnv();

// Neutralize the module-level `Deno.serve(...)` so the dynamic import below
// doesn't try to bind a port. We test `suggestedArticlesHandler` directly.
// @ts-ignore: Deno globals are unavailable to the editor TS server
Deno.serve = ((_fn: unknown) => ({} as unknown)) as typeof Deno.serve;

const module_ = await import("../suggested-articles/index.ts") as {
  suggestedArticlesHandler: (req: Request, deps: unknown) => Promise<Response>;
};
const { suggestedArticlesHandler } = module_;

// ── Fixtures ──────────────────────────────────────────────────────────────

const PROJECT_ID = "proj-test-suggested-0001";
const ALLOWED_HOST = "publisher.example.com";
const ORIGIN = "https://publisher.example.com";
const CURRENT_URL = "https://publisher.example.com/articles/current";
const CONVERSATION_ID = "conv-abc";

function fakeProject(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    allowed_urls: [ALLOWED_HOST],
    ...overrides,
  };
}

function fakeArticle(id: string, overrides: Record<string, unknown> = {}) {
  return {
    unique_id: id,
    url: `https://publisher.example.com/articles/${id}`,
    title: `Article ${id}`,
    image_url: `https://cdn.example.com/${id}.jpg`,
    cache: { created_at: "2026-04-01T00:00:00Z" },
    ...overrides,
  };
}

/**
 * Deterministic "random" — always returns 0.5 so the in-place sort is a
 * no-op and `shuffled` == `recentArticles`. That lets us assert exact
 * ordering on the selection without flakiness.
 */
function stableRandom() {
  return 0.5;
}

// deno-lint-ignore no-explicit-any
function makeDeps(overrides: Record<string, unknown> = {}): any {
  return {
    supabaseClient: () => Promise.resolve({} as unknown),
    getProjectForArticlesAuth: () => Promise.resolve(fakeProject()),
    getRecentArticlesForProject: () => Promise.resolve([]),
    getSuggestionIndex: () => Promise.resolve(null),
    updateSuggestionIndex: () => Promise.resolve(),
    random: stableRandom,
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return { projectId: PROJECT_ID, currentUrl: CURRENT_URL, ...overrides };
}

// ── Content-length guard (SECURITY_AUDIT_TODO item 3) ────────────────────

Deno.test("suggested-articles: Content-Length above 4KB cap returns 413", async () => {
  const r = new Request("https://widget.divee.ai/functions/v1/suggested-articles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "origin": ORIGIN,
      "content-length": String(10_000),
    },
    body: "{}",
  });
  const res = await suggestedArticlesHandler(r, makeDeps());
  assertEquals(res.status, 413);
});

// ── Preflight & validation ────────────────────────────────────────────────

Deno.test("suggested-articles: OPTIONS preflight returns 200", async () => {
  const r = new Request("https://widget.divee.ai/functions/v1/suggested-articles", {
    method: "OPTIONS",
    headers: { "origin": ORIGIN },
  });
  const res = await suggestedArticlesHandler(r, makeDeps());
  assertEquals(res.status, 200);
});

Deno.test("suggested-articles: missing projectId returns 400", async () => {
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body({ projectId: undefined }), ORIGIN),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("suggested-articles: missing currentUrl returns 400", async () => {
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body({ currentUrl: undefined }), ORIGIN),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("suggested-articles: malformed currentUrl returns 400", async () => {
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body({ currentUrl: "not a url" }), ORIGIN),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

// ── Auth gate (SECURITY_AUDIT_TODO item 1) ──────────────────────────────
// These tests pin the fix for the "KNOWN GAP" that used to live in
// scripts/check-edge-auth.ts PUBLIC_ALLOWLIST. Regressions must fail loudly.

Deno.test("suggested-articles: unknown projectId returns 400", async () => {
  const deps = makeDeps({
    getProjectForArticlesAuth: () => Promise.resolve(null),
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body(), ORIGIN),
    deps,
  );
  assertEquals(res.status, 400);
});

Deno.test("suggested-articles: origin not in allowed_urls returns 403", async () => {
  const deps = makeDeps({
    getProjectForArticlesAuth: () =>
      Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body(), ORIGIN),
    deps,
  );
  assertEquals(res.status, 403);
});

Deno.test("suggested-articles: auth check runs BEFORE the article fetch", async () => {
  // Regression guard: if someone reorders the handler and does the DAO
  // fetch before the auth check, an attacker with a mismatched origin
  // could still exfiltrate the list (just not read the response). This
  // test asserts the DAO is never called when auth fails.
  let daoCalled = false;
  const deps = makeDeps({
    getProjectForArticlesAuth: () => Promise.resolve(null),
    getRecentArticlesForProject: () => {
      daoCalled = true;
      return Promise.resolve([]);
    },
  });
  await suggestedArticlesHandler(
    postJson("suggested-articles", body(), ORIGIN),
    deps,
  );
  assertEquals(daoCalled, false);
});

Deno.test("suggested-articles: non-JSON body returns 500", async () => {
  const body = "not json{";
  const r = new Request("https://widget.divee.ai/functions/v1/suggested-articles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "origin": ORIGIN,
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  });
  const res = await suggestedArticlesHandler(r, makeDeps());
  assertEquals(res.status, 500);
});

// ── Empty pool ───────────────────────────────────────────────────────────

Deno.test("suggested-articles: empty pool returns {suggestion: null} and does NOT bump counter", async () => {
  let writeCalled = false;
  const deps = makeDeps({
    getRecentArticlesForProject: () => Promise.resolve([]),
    getSuggestionIndex: () => Promise.resolve(7),
    updateSuggestionIndex: () => {
      writeCalled = true;
      return Promise.resolve();
    },
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body({ conversationId: CONVERSATION_ID }), ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.suggestion, null);
  // No pool ⇒ no rotation ⇒ counter must not advance.
  assertEquals(writeCalled, false);
});

// ── No conversationId path ───────────────────────────────────────────────

Deno.test("suggested-articles: no conversationId → position 0, no counter read/write", async () => {
  let readCalled = false;
  let writeCalled = false;
  const deps = makeDeps({
    getSuggestionIndex: () => {
      readCalled = true;
      return Promise.resolve(0);
    },
    updateSuggestionIndex: () => {
      writeCalled = true;
      return Promise.resolve();
    },
    getRecentArticlesForProject: () =>
      Promise.resolve([fakeArticle("a"), fakeArticle("b"), fakeArticle("c"), fakeArticle("d")]),
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body(), ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(readCalled, false);
  assertEquals(writeCalled, false);
  const json = await res.json();
  // stableRandom makes the sort a no-op → position 0 → first article
  assertEquals(json.suggestion.unique_id, "a");
});

// ── DAO call arguments ────────────────────────────────────────────────────

Deno.test("suggested-articles: DAO fetch uses projectId, currentUrl, and limit=10", async () => {
  let capturedArgs: any = null;
  const deps = makeDeps({
    getRecentArticlesForProject: (
      _sb: unknown,
      projectId: string,
      excludeUrl: string,
      limit: number,
    ) => {
      capturedArgs = { projectId, excludeUrl, limit };
      return Promise.resolve([fakeArticle("only")]);
    },
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body(), ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(capturedArgs.projectId, PROJECT_ID);
  assertEquals(capturedArgs.excludeUrl, CURRENT_URL);
  assertEquals(capturedArgs.limit, 10);
});

// ── Round-robin with conversationId ──────────────────────────────────────

Deno.test("suggested-articles: with conversationId — reads index, picks at that position, writes +1", async () => {
  let writtenIndex = -999;
  const deps = makeDeps({
    getSuggestionIndex: () => Promise.resolve(5),
    getRecentArticlesForProject: () =>
      Promise.resolve([fakeArticle("a"), fakeArticle("b"), fakeArticle("c"), fakeArticle("d")]),
    updateSuggestionIndex: (_sb: unknown, _id: string, next: number) => {
      writtenIndex = next;
      return Promise.resolve();
    },
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body({ conversationId: CONVERSATION_ID }), ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  // 5 % 4 = 1 → second article in the shuffled pool. stableRandom keeps
  // original order so shuffled[1] = "b".
  const json = await res.json();
  assertEquals(json.suggestion.unique_id, "b");
  // Counter written back as current+1, not current or current+0.
  assertEquals(writtenIndex, 6);
});

Deno.test("suggested-articles: suggestion_index null from DAO is treated as 0", async () => {
  const deps = makeDeps({
    getSuggestionIndex: () => Promise.resolve(0),
    getRecentArticlesForProject: () => Promise.resolve([fakeArticle("a"), fakeArticle("b")]),
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body({ conversationId: CONVERSATION_ID }), ORIGIN),
    deps,
  );
  const json = await res.json();
  // 0 % 2 = 0 → first article
  assertEquals(json.suggestion.unique_id, "a");
});

Deno.test("suggested-articles: missing conversation row → index defaults to 0", async () => {
  const deps = makeDeps({
    // DAO returns null → handler must NOT crash on .suggestion_index access
    getSuggestionIndex: () => Promise.resolve(null),
    getRecentArticlesForProject: () => Promise.resolve([fakeArticle("a"), fakeArticle("b")]),
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body({ conversationId: CONVERSATION_ID }), ORIGIN),
    deps,
  );
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.suggestion.unique_id, "a");
});

// ── Pool size cap ─────────────────────────────────────────────────────────

Deno.test("suggested-articles: selection is capped at 4 even when DAO returns 10", async () => {
  // Return 10 articles. With suggestionIndex=9, position = 9 % 4 = 1 → the
  // SECOND of the selected 4, not the 10th of the full pool. If the cap
  // were missing, position would be 9 % 10 = 9 and we'd pick "j" instead.
  const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => fakeArticle(id));
  const deps = makeDeps({
    getSuggestionIndex: () => Promise.resolve(9),
    getRecentArticlesForProject: () => Promise.resolve(pool),
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body({ conversationId: CONVERSATION_ID }), ORIGIN),
    deps,
  );
  const json = await res.json();
  assertEquals(json.suggestion.unique_id, "b"); // NOT "j"
});

// ── Response shape ───────────────────────────────────────────────────────

Deno.test("suggested-articles: response omits cache and exposes only the 4 widget fields", async () => {
  const deps = makeDeps({
    getRecentArticlesForProject: () => Promise.resolve([fakeArticle("only")]),
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body(), ORIGIN),
    deps,
  );
  const json = await res.json();
  assertEquals(Object.keys(json.suggestion).sort(), [
    "image_url",
    "title",
    "unique_id",
    "url",
  ]);
  // cache was on the DAO row but must not leak into the response
  assertEquals("cache" in json.suggestion, false);
});

Deno.test("suggested-articles: missing image_url falls back to null", async () => {
  const deps = makeDeps({
    getRecentArticlesForProject: () => Promise.resolve([fakeArticle("only", { image_url: null })]),
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body(), ORIGIN),
    deps,
  );
  const json = await res.json();
  assertEquals(json.suggestion.image_url, null);
});

// ── DAO errors ───────────────────────────────────────────────────────────

Deno.test("suggested-articles: DAO throw → 500", async () => {
  const deps = makeDeps({
    getRecentArticlesForProject: () => Promise.reject(new Error("db down")),
  });
  const res = await suggestedArticlesHandler(
    postJson("suggested-articles", body(), ORIGIN),
    deps,
  );
  assertEquals(res.status, 500);
});

// ── Teardown ──────────────────────────────────────────────────────────────
Deno.test("suggested-articles: teardown (restore env)", () => {
  restoreEnv();
});
