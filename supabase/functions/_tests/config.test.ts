/**
 * Tests for supabase/functions/config/index.ts
 *
 * Exercises the dependency-injection seam (`configHandler(req, deps)`).
 *
 * Covered behaviors (priority: auth & cache-safety first, shape second):
 *   - 400 on missing projectId
 *   - `client_id` query param is an accepted alias for `projectId`
 *   - 403 when origin is not in project.allowed_urls
 *   - Bypass via `?bypass_key=...` when CONFIG_BYPASS_KEY env is set
 *   - Bypass is rejected when env var is unset (fail-closed)
 *   - Bypass is rejected when the provided key doesn't match
 *   - Happy-path response: status 200, widget config body, and — the reason
 *     this file exists at all — the public CDN cache headers so the config
 *     response can be served from Fastly to anonymous visitors safely.
 *   - display_position sanitization (unknown value → `bottom-right`)
 *   - Missing project_config row → response omits ad fields instead of
 *     crashing
 */
import { assertEquals } from "jsr:@std/assert@1";
import { setEnv } from "./helpers.ts";

// ── One-time env setup (before importing the handler module) ──────────────
const restoreEnv = setEnv({ CONFIG_BYPASS_KEY: "super-secret-bypass" });

// Neutralize the module-level `Deno.serve(...)` so the dynamic import below
// doesn't try to bind a port. We test `configHandler` directly.
// @ts-ignore: Deno globals are unavailable to the editor TS server
Deno.serve = ((_fn: unknown) => ({} as unknown)) as typeof Deno.serve;

const configModule = await import("../config/index.ts") as {
  configHandler: (req: Request, deps: unknown) => Promise<Response>;
};
const { configHandler } = configModule;

// ── Fixtures ──────────────────────────────────────────────────────────────

const PROJECT_ID = "proj-test-config-0001";
const ALLOWED_HOST = "publisher.example.com";
const ALLOWED_ORIGIN = "https://publisher.example.com";

/** Minimal project row matching the columns config/index.ts reads. */
function fakeProject(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    allowed_urls: [ALLOWED_HOST],
    direction: "ltr",
    language: "en",
    icon_url: "https://cdn.example.com/icon.png",
    client_name: "Publisher Inc",
    client_description: "An example publisher",
    highlight_color: ["#123456", "#654321"],
    show_ad: true,
    input_text_placeholders: ["Ask me anything…"],
    display_mode: "anchored",
    display_position: "bottom-right",
    article_class: null,
    widget_container_class: null,
    override_mobile_container_selector: null,
    disclaimer_text: null,
    widget_mode: "article",
    ask_concent: false,
    ...overrides,
  };
}

/** Minimal project_config row matching the columns config/index.ts reads. */
function fakeProjectConfig(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    ad_tag_id: "/1234/divee/test",
    override_mobile_ad_size: null,
    override_desktop_ad_size: null,
    white_label: false,
    ...overrides,
  };
}

/** Build a GET request hitting /config?projectId=… with an Origin header. */
function req(
  opts: { projectId?: string; clientId?: string; bypassKey?: string; origin?: string } = {},
): Request {
  const u = new URL("https://widget.divee.ai/functions/v1/config");
  if (opts.projectId !== undefined) u.searchParams.set("projectId", opts.projectId);
  if (opts.clientId !== undefined) u.searchParams.set("client_id", opts.clientId);
  if (opts.bypassKey !== undefined) u.searchParams.set("bypass_key", opts.bypassKey);
  return new Request(u.toString(), {
    method: "GET",
    headers: { "origin": opts.origin ?? ALLOWED_ORIGIN },
  });
}

/**
 * Build a ConfigDeps stub. Any field not overridden returns the default fake
 * (project row + config row). Pass an override returning null for the missing-
 * config-row scenario, etc.
 */
// deno-lint-ignore no-explicit-any
function makeDeps(overrides: Record<string, unknown> = {}): any {
  return {
    supabaseClient: () => Promise.resolve({} as unknown),
    getProjectById: () => Promise.resolve(fakeProject()),
    getProjectConfigById: () => Promise.resolve(fakeProjectConfig()),
    checkRateLimit: () => Promise.resolve({ limited: false }),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

Deno.test("config: OPTIONS preflight returns 200", async () => {
  const r = new Request("https://widget.divee.ai/functions/v1/config", {
    method: "OPTIONS",
    headers: { "origin": ALLOWED_ORIGIN },
  });
  const res = await configHandler(r, makeDeps());
  assertEquals(res.status, 200);
});

Deno.test("config: missing projectId returns 400", async () => {
  const res = await configHandler(req({}), makeDeps());
  assertEquals(res.status, 400);
});

Deno.test("config: `client_id` query param is accepted as an alias for projectId", async () => {
  const res = await configHandler(req({ clientId: PROJECT_ID }), makeDeps());
  assertEquals(res.status, 200);
});

Deno.test("config: origin not in allowed_urls returns 403", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
  });
  const res = await configHandler(req({ projectId: PROJECT_ID }), deps);
  assertEquals(res.status, 403);
});

Deno.test("config: valid bypass_key skips the origin check", async () => {
  const deps = makeDeps({
    // project.allowed_urls does NOT include the caller's origin, so without
    // the bypass this would be a 403.
    getProjectById: () => Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
  });
  const res = await configHandler(
    req({ projectId: PROJECT_ID, bypassKey: "super-secret-bypass" }),
    deps,
  );
  assertEquals(res.status, 200);
});

Deno.test("config: bypass_key rejected when CONFIG_BYPASS_KEY env is unset", async () => {
  const prev = Deno.env.get("CONFIG_BYPASS_KEY");
  Deno.env.delete("CONFIG_BYPASS_KEY");
  try {
    const deps = makeDeps({
      getProjectById: () => Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
    });
    const res = await configHandler(
      req({ projectId: PROJECT_ID, bypassKey: "super-secret-bypass" }),
      deps,
    );
    // Env var missing → bypass impossible → origin check runs → 403.
    assertEquals(res.status, 403);
  } finally {
    if (prev !== undefined) Deno.env.set("CONFIG_BYPASS_KEY", prev);
  }
});

Deno.test("config: wrong bypass_key is rejected", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
  });
  const res = await configHandler(
    req({ projectId: PROJECT_ID, bypassKey: "wrong-key" }),
    deps,
  );
  assertEquals(res.status, 403);
});

Deno.test("config: happy path returns 200 with public CDN cache headers", async () => {
  const res = await configHandler(req({ projectId: PROJECT_ID }), makeDeps());

  assertEquals(res.status, 200);

  // The whole point of this function being cacheable at Fastly.
  // successRespWithCache defaults: max-age=300, s-maxage=3600, key="config"
  assertEquals(
    res.headers.get("Cache-Control"),
    "public, max-age=300, s-maxage=3600",
  );
  assertEquals(res.headers.get("Surrogate-Control"), "max-age=3600");
  assertEquals(res.headers.get("Surrogate-Key"), "config");
  assertEquals(res.headers.get("Content-Type"), "application/json");

  const body = await res.json();
  // Spot-check the shape — we don't need to assert every field, but a few
  // representative ones lock in the contract the widget client depends on.
  assertEquals(body.language, "en");
  assertEquals(body.direction, "ltr");
  assertEquals(body.client_name, "Publisher Inc");
  assertEquals(body.widget_mode, "article");
  assertEquals(body.display_position, "bottom-right");
  assertEquals(body.ad_tag_id, "/1234/divee/test");
  // Origin check passed, but allowed_urls is included in the response so
  // the widget can apply the same check client-side for defense-in-depth.
  assertEquals(body.allowed_urls, [ALLOWED_HOST]);
});

Deno.test("config: display_position falls back to 'bottom-right' for unknown values", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ display_position: "somewhere-random" })),
  });
  const res = await configHandler(req({ projectId: PROJECT_ID }), deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.display_position, "bottom-right");
});

Deno.test("config: missing project_config row returns widget config without ad fields", async () => {
  const deps = makeDeps({
    getProjectConfigById: () => Promise.resolve(null),
  });
  const res = await configHandler(req({ projectId: PROJECT_ID }), deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  // Project-level fields still present…
  assertEquals(body.client_name, "Publisher Inc");
  // …but the ad fields are NOT merged in (they would have come from the
  // project_config row which is null).
  assertEquals(body.ad_tag_id, undefined);
  assertEquals(body.override_mobile_ad_size, undefined);
  assertEquals(body.white_label, undefined);
});

// ── Rate limiting (SECURITY_AUDIT_TODO item 2) ───────────────────────────

Deno.test("config: rate-limit 429 has Retry-After header and JSON body", async () => {
  const deps = makeDeps({
    checkRateLimit: () => Promise.resolve({ limited: true, retryAfterSeconds: 42 }),
  });
  const res = await configHandler(req({ projectId: PROJECT_ID }), deps);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("Retry-After"), "42");
  const body = await res.json();
  assertEquals(body.error, "Too many requests");
  assertEquals(body.retryAfter, 42);
});

Deno.test("config: rate-limit runs AFTER origin check (unauthorized traffic must not consume quota)", async () => {
  // Regression guard. If someone reorders the handler and rate-limits
  // before origin-checks, an attacker can DoS a project's config budget
  // from a foreign origin without ever producing a real response.
  let rateLimitCalled = false;
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
    checkRateLimit: () => {
      rateLimitCalled = true;
      return Promise.resolve({ limited: false });
    },
  });
  const res = await configHandler(req({ projectId: PROJECT_ID }), deps);
  assertEquals(res.status, 403);
  assertEquals(rateLimitCalled, false);
});

Deno.test("config: rate-limit called with (endpoint='config', visitorId=null, projectId)", async () => {
  let capturedArgs: unknown[] = [];
  const deps = makeDeps({
    checkRateLimit: (...args: unknown[]) => {
      capturedArgs = args;
      return Promise.resolve({ limited: false });
    },
  });
  await configHandler(req({ projectId: PROJECT_ID }), deps);
  // [supabase, endpoint, visitorId, projectId]
  assertEquals(capturedArgs[1], "config");
  assertEquals(capturedArgs[2], null);
  assertEquals(capturedArgs[3], PROJECT_ID);
});

Deno.test("config: show_ad=false from the DB is respected (not defaulted back to true)", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ show_ad: false })),
  });
  const res = await configHandler(req({ projectId: PROJECT_ID }), deps);
  const body = await res.json();
  assertEquals(body.show_ad, false);
});

// ── Teardown ──────────────────────────────────────────────────────────────
Deno.test("config: teardown (restore env)", () => {
  restoreEnv();
});
