/**
 * Tests for supabase/functions/articles/index.ts
 *
 * Exercises the dependency-injection seam (`articlesHandler(req, deps)`).
 *
 * Covered behaviors (priority: auth first, routing second, scoring third):
 *   - OPTIONS preflight returns 200
 *   - Non-GET methods return 405
 *   - 400 on missing projectId
 *   - 400 on invalid projectId (project row not found)
 *   - 403 when origin is not in project.allowed_urls
 *   - 404 for unknown routes
 *   - /tags: 400 on missing articleId, 404 on empty result, happy path shape,
 *     ordering preserved from DAO
 *   - /by-tag: 400 on missing tag, tagType/excludeId forwarded, limit clamped
 *     to 50 max, offset+limit range math, orphaned rows filtered, 404 on empty
 *   - /related: 400 on missing articleId, 404 when source article has no tags,
 *     empty articles array when no matches, weighted scoring (person=2.0,
 *     place=1.5, category=1.0) respected, limit clamped to 20 max, ordering
 *     by score descending, results filtered by present article details
 *   - Happy-path responses carry public CDN cache headers with the per-project
 *     surrogate key so Fastly invalidation can target a single publisher.
 *   - DAO throws bubble up to a 500 via the top-level try/catch
 */
import { assertEquals } from "jsr:@std/assert@1";
import { setEnv } from "./helpers.ts";

// ── One-time env setup (before importing the handler module) ──────────────
const restoreEnv = setEnv();

// Neutralize the module-level `Deno.serve(...)` so the dynamic import below
// doesn't try to bind a port. We test `articlesHandler` directly.
// @ts-ignore: Deno globals are unavailable to the editor TS server
Deno.serve = ((_fn: unknown) => ({} as unknown)) as typeof Deno.serve;

const articlesModule = await import("../articles/index.ts") as {
  articlesHandler: (req: Request, deps: unknown) => Promise<Response>;
};
const { articlesHandler } = articlesModule;

// ── Fixtures ──────────────────────────────────────────────────────────────

const PROJECT_ID = "proj-test-articles-0001";
const ALLOWED_HOST = "publisher.example.com";
const ALLOWED_ORIGIN = "https://publisher.example.com";
const ARTICLE_ID = "https://publisher.example.com/articles/foo" + PROJECT_ID;

function fakeProject(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    allowed_urls: [ALLOWED_HOST],
    ...overrides,
  };
}

/** Build a GET request hitting /articles/<route>?... with an Origin header. */
function req(
  route: string,
  params: Record<string, string | undefined> = {},
  opts: { origin?: string; method?: string } = {},
): Request {
  const u = new URL(`https://widget.divee.ai/functions/v1/articles/${route}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v);
  }
  return new Request(u.toString(), {
    method: opts.method ?? "GET",
    headers: { "origin": opts.origin ?? ALLOWED_ORIGIN },
  });
}

/**
 * Build an ArticlesDeps stub. Any field not overridden returns an empty/
 * default response; tests override only what they care about.
 */
// deno-lint-ignore no-explicit-any
function makeDeps(overrides: Record<string, unknown> = {}): any {
  return {
    supabaseClient: () => Promise.resolve({} as unknown),
    getProjectForArticlesAuth: () => Promise.resolve(fakeProject()),
    getArticleTagsByArticleId: () => Promise.resolve([]),
    getArticlesByTag: () => Promise.resolve([]),
    getSourceArticleTags: () => Promise.resolve([]),
    getArticleTagsByTagValues: () => Promise.resolve([]),
    getArticlesByIds: () => Promise.resolve([]),
    ...overrides,
  };
}

// ── Global auth / routing ────────────────────────────────────────────────

Deno.test("articles: OPTIONS preflight returns 200", async () => {
  const r = new Request("https://widget.divee.ai/functions/v1/articles/tags", {
    method: "OPTIONS",
    headers: { "origin": ALLOWED_ORIGIN },
  });
  const res = await articlesHandler(r, makeDeps());
  assertEquals(res.status, 200);
});

Deno.test("articles: non-GET method returns 405", async () => {
  const res = await articlesHandler(
    req("tags", { projectId: PROJECT_ID, articleId: ARTICLE_ID }, { method: "POST" }),
    makeDeps(),
  );
  assertEquals(res.status, 405);
});

Deno.test("articles: missing projectId returns 400", async () => {
  const res = await articlesHandler(req("tags", {}), makeDeps());
  assertEquals(res.status, 400);
});

Deno.test("articles: invalid projectId (project row not found) returns 400", async () => {
  const deps = makeDeps({
    getProjectForArticlesAuth: () => Promise.resolve(null),
  });
  const res = await articlesHandler(
    req("tags", { projectId: PROJECT_ID, articleId: ARTICLE_ID }),
    deps,
  );
  assertEquals(res.status, 400);
});

Deno.test("articles: origin not in allowed_urls returns 403", async () => {
  const deps = makeDeps({
    getProjectForArticlesAuth: () =>
      Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
  });
  const res = await articlesHandler(
    req("tags", { projectId: PROJECT_ID, articleId: ARTICLE_ID }),
    deps,
  );
  assertEquals(res.status, 403);
});

Deno.test("articles: unknown route returns 404", async () => {
  const res = await articlesHandler(
    req("nonsense", { projectId: PROJECT_ID }),
    makeDeps(),
  );
  assertEquals(res.status, 404);
});

Deno.test("articles: DAO throw bubbles up to 500", async () => {
  const deps = makeDeps({
    getArticleTagsByArticleId: () => Promise.reject(new Error("db blew up")),
  });
  const res = await articlesHandler(
    req("tags", { projectId: PROJECT_ID, articleId: ARTICLE_ID }),
    deps,
  );
  assertEquals(res.status, 500);
});

// ── /articles/tags ───────────────────────────────────────────────────────

Deno.test("articles/tags: missing articleId returns 400", async () => {
  const res = await articlesHandler(
    req("tags", { projectId: PROJECT_ID }),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("articles/tags: empty tag result returns 404 (not cached)", async () => {
  const res = await articlesHandler(
    req("tags", { projectId: PROJECT_ID, articleId: ARTICLE_ID }),
    makeDeps(),
  );
  assertEquals(res.status, 404);
  // 404 must not carry the CDN cache headers — not-yet-indexed articles
  // need to re-hit the origin once they're indexed.
  assertEquals(res.headers.get("Cache-Control"), null);
});

Deno.test("articles/tags: happy path returns tags with per-project surrogate key and order preserved", async () => {
  const deps = makeDeps({
    getArticleTagsByArticleId: () =>
      Promise.resolve([
        { tag: "Elon Musk", tag_type: "person", confidence: 0.95 },
        { tag: "Austin", tag_type: "place", confidence: 0.80 },
        { tag: "Tech", tag_type: "category", confidence: 0.60 },
      ]),
  });
  const res = await articlesHandler(
    req("tags", { projectId: PROJECT_ID, articleId: ARTICLE_ID }),
    deps,
  );

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300");
  assertEquals(res.headers.get("Surrogate-Key"), `articles-${PROJECT_ID}`);
  assertEquals(res.headers.get("Content-Type"), "application/json");

  const body = await res.json();
  assertEquals(body.tags.length, 3);
  // DAO returns rows already ordered by confidence DESC; handler must not
  // re-sort or drop rows.
  assertEquals(body.tags[0].value, "Elon Musk");
  assertEquals(body.tags[0].type, "person");
  assertEquals(body.tags[0].confidence, 0.95);
  assertEquals(body.tags[2].value, "Tech");
});

// ── /articles/by-tag ─────────────────────────────────────────────────────

Deno.test("articles/by-tag: missing tag returns 400", async () => {
  const res = await articlesHandler(
    req("by-tag", { projectId: PROJECT_ID }),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("articles/by-tag: empty result returns 404", async () => {
  const res = await articlesHandler(
    req("by-tag", { projectId: PROJECT_ID, tag: "Elon Musk" }),
    makeDeps(),
  );
  assertEquals(res.status, 404);
});

Deno.test("articles/by-tag: happy path maps nested article fields and keeps confidence", async () => {
  const deps = makeDeps({
    getArticlesByTag: () =>
      Promise.resolve([
        {
          confidence: 0.9,
          article: {
            unique_id: "a1",
            title: "Story One",
            url: "https://publisher.example.com/one",
            image_url: "https://cdn.example.com/one.jpg",
            created_at: "2026-04-01T00:00:00Z",
          },
        },
        // orphaned row — article FK resolved to null; handler must drop it
        { confidence: 0.5, article: null },
        {
          confidence: 0.7,
          article: {
            unique_id: "a2",
            title: "Story Two",
            url: "https://publisher.example.com/two",
            image_url: null,
            created_at: "2026-04-02T00:00:00Z",
          },
        },
      ]),
  });
  const res = await articlesHandler(
    req("by-tag", { projectId: PROJECT_ID, tag: "Elon Musk" }),
    deps,
  );

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.articles.length, 2);
  assertEquals(body.articles[0].unique_id, "a1");
  assertEquals(body.articles[0].confidence, 0.9);
  assertEquals(body.articles[1].unique_id, "a2");
});

Deno.test("articles/by-tag: tagType, excludeId, limit clamp, and offset are forwarded to DAO", async () => {
  let captured: any = null;
  const deps = makeDeps({
    getArticlesByTag: (
      projectId: string,
      tag: string,
      tagType: string | null,
      excludeId: string | null,
      limit: number,
      offset: number,
    ) => {
      captured = { projectId, tag, tagType, excludeId, limit, offset };
      return Promise.resolve([
        {
          confidence: 1,
          article: {
            unique_id: "x",
            title: "x",
            url: "u",
            image_url: null,
            created_at: "t",
          },
        },
      ]);
    },
  });
  const res = await articlesHandler(
    req("by-tag", {
      projectId: PROJECT_ID,
      tag: "Elon Musk",
      tagType: "person",
      excludeId: "exclude-me",
      limit: "999", // above the 50 ceiling → must be clamped
      offset: "20",
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(captured.projectId, PROJECT_ID);
  assertEquals(captured.tag, "Elon Musk");
  assertEquals(captured.tagType, "person");
  assertEquals(captured.excludeId, "exclude-me");
  assertEquals(captured.limit, 50);
  assertEquals(captured.offset, 20);
});

// ── /articles/related ────────────────────────────────────────────────────

Deno.test("articles/related: missing articleId returns 400", async () => {
  const res = await articlesHandler(
    req("related", { projectId: PROJECT_ID }),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("articles/related: source article with no tags returns 404", async () => {
  const res = await articlesHandler(
    req("related", { projectId: PROJECT_ID, articleId: ARTICLE_ID }),
    makeDeps(), // default getSourceArticleTags → []
  );
  assertEquals(res.status, 404);
});

Deno.test("articles/related: no matching tags returns 200 with empty list (cached)", async () => {
  const deps = makeDeps({
    getSourceArticleTags: () => Promise.resolve([{ tag: "Elon Musk", tag_type: "person" }]),
    getArticleTagsByTagValues: () => Promise.resolve([]),
  });
  const res = await articlesHandler(
    req("related", { projectId: PROJECT_ID, articleId: ARTICLE_ID }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Surrogate-Key"), `articles-${PROJECT_ID}`);
  const body = await res.json();
  assertEquals(body.articles, []);
});

Deno.test("articles/related: weighted scoring ranks higher-weight tag_type first", async () => {
  // Source article shares 1 `person` tag with a-high, and 1 `category` tag
  // with a-low. Since person=2.0 > category=1.0, a-high must come first.
  const deps = makeDeps({
    getSourceArticleTags: () =>
      Promise.resolve([
        { tag: "Elon Musk", tag_type: "person" },
        { tag: "Tech", tag_type: "category" },
      ]),
    getArticleTagsByTagValues: () =>
      Promise.resolve([
        {
          article_unique_id: "a-high",
          tag: "Elon Musk",
          tag_type: "person",
          confidence: 1.0,
        },
        {
          article_unique_id: "a-low",
          tag: "Tech",
          tag_type: "category",
          confidence: 1.0,
        },
      ]),
    getArticlesByIds: (ids: string[]) =>
      Promise.resolve(
        ids.map((id) => ({
          unique_id: id,
          title: id,
          url: `https://publisher.example.com/${id}`,
          image_url: null,
          created_at: "2026-04-01T00:00:00Z",
        })),
      ),
  });
  const res = await articlesHandler(
    req("related", { projectId: PROJECT_ID, articleId: ARTICLE_ID }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.articles.length, 2);
  assertEquals(body.articles[0].unique_id, "a-high");
  assertEquals(body.articles[0].tag_score, 2.0);
  assertEquals(body.articles[0].shared_tag_count, 1);
  assertEquals(body.articles[1].unique_id, "a-low");
  assertEquals(body.articles[1].tag_score, 1.0);
});

Deno.test("articles/related: limit is clamped to 20 max", async () => {
  let capturedIds: string[] = [];
  const matching = Array.from({ length: 30 }, (_, i) => ({
    article_unique_id: `a${i}`,
    tag: "Elon Musk",
    tag_type: "person",
    confidence: 1.0 - i * 0.01, // strictly descending so ordering is stable
  }));
  const deps = makeDeps({
    getSourceArticleTags: () => Promise.resolve([{ tag: "Elon Musk", tag_type: "person" }]),
    getArticleTagsByTagValues: () => Promise.resolve(matching),
    getArticlesByIds: (ids: string[]) => {
      capturedIds = ids;
      return Promise.resolve(
        ids.map((id) => ({
          unique_id: id,
          title: id,
          url: "u",
          image_url: null,
          created_at: "t",
        })),
      );
    },
  });
  const res = await articlesHandler(
    req("related", {
      projectId: PROJECT_ID,
      articleId: ARTICLE_ID,
      limit: "100", // above the 20 ceiling
    }),
    deps,
  );
  assertEquals(res.status, 200);
  // Ranked, sliced to 20 BEFORE the article-details fetch — so only 20 IDs
  // hit the DB. This is both correctness and a perf guarantee.
  assertEquals(capturedIds.length, 20);
  const body = await res.json();
  assertEquals(body.articles.length, 20);
});

Deno.test("articles/related: articles missing from details map are dropped from response", async () => {
  const deps = makeDeps({
    getSourceArticleTags: () => Promise.resolve([{ tag: "Elon Musk", tag_type: "person" }]),
    getArticleTagsByTagValues: () =>
      Promise.resolve([
        {
          article_unique_id: "present",
          tag: "Elon Musk",
          tag_type: "person",
          confidence: 1.0,
        },
        {
          article_unique_id: "missing",
          tag: "Elon Musk",
          tag_type: "person",
          confidence: 1.0,
        },
      ]),
    getArticlesByIds: () =>
      Promise.resolve([
        {
          unique_id: "present",
          title: "Present",
          url: "u",
          image_url: null,
          created_at: "t",
        },
        // "missing" intentionally absent
      ]),
  });
  const res = await articlesHandler(
    req("related", { projectId: PROJECT_ID, articleId: ARTICLE_ID }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.articles.length, 1);
  assertEquals(body.articles[0].unique_id, "present");
});

// ── Teardown ──────────────────────────────────────────────────────────────
Deno.test("articles: teardown (restore env)", () => {
  restoreEnv();
});
