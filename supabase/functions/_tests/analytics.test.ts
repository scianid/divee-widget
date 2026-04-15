/**
 * Tests for supabase/functions/analytics/index.ts
 *
 * Exercises the dependency-injection seam (`analyticsHandler(req, deps)`).
 *
 * analytics is a reverse proxy: it validates the caller's project and
 * origin, then forwards the raw request body to a secondary project's
 * analytics endpoint (ANALYTICS_PROXY_URL). The tests care about two
 * things:
 *   1. The auth gate — an attacker can't burn the secondary's rate budget
 *      or inject events for a project they don't own.
 *   2. The forwarding contract — rawBody is passed through untouched and
 *      the right headers (cf-connecting-ip for geo, referer, origin) are
 *      copied onto the outbound request.
 *
 * Covered behaviors:
 *   - OPTIONS preflight returns 200
 *   - Invalid / empty body → 400
 *   - Missing project_id (single event) → 400
 *   - Missing project_id (empty batch) → 400
 *   - project_id resolved from batch[0].project_id when top-level missing
 *   - getProjectById throws → 404 "Invalid project_id"
 *   - Origin not in allowed_urls → 403
 *   - ANALYTICS_PROXY_URL unset → 503
 *   - Happy path forwards raw body verbatim, returns proxy status + body
 *   - cf-connecting-ip / referer / origin headers forwarded when present
 *   - Those headers are NOT set on the outbound when absent from the request
 *   - Upstream error status (e.g. 502) is propagated back to the caller
 *   - fetch throw → 500 (top-level catch)
 */
import { assertEquals } from "jsr:@std/assert@1";
import { setEnv } from "./helpers.ts";

// ── One-time env setup (before importing the handler module) ──────────────
const restoreEnv = setEnv({
  ANALYTICS_PROXY_URL: "https://secondary.example.com/analytics",
});

// Neutralize the module-level `Deno.serve(...)` so the dynamic import below
// doesn't try to bind a port. We test `analyticsHandler` directly.
// @ts-ignore: Deno globals are unavailable to the editor TS server
Deno.serve = ((_fn: unknown) => ({} as unknown)) as typeof Deno.serve;

const analyticsModule = await import("../analytics/index.ts") as {
  analyticsHandler: (req: Request, deps: unknown) => Promise<Response>;
};
const { analyticsHandler } = analyticsModule;

// ── Fixtures ──────────────────────────────────────────────────────────────

const PROJECT_ID = "proj-test-analytics-0001";
const ALLOWED_HOST = "publisher.example.com";
const ALLOWED_ORIGIN = "https://publisher.example.com";
const PROXY_URL = "https://secondary.example.com/analytics";

function fakeProject(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    allowed_urls: [ALLOWED_HOST],
    ...overrides,
  };
}

/** Build a POST /analytics request with configurable body and headers. */
function postEvent(
  body: unknown,
  opts: { origin?: string | null; cfIp?: string; referer?: string; raw?: string } = {},
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.origin !== null) headers["origin"] = opts.origin ?? ALLOWED_ORIGIN;
  if (opts.cfIp) headers["cf-connecting-ip"] = opts.cfIp;
  if (opts.referer) headers["referer"] = opts.referer;
  return new Request("https://widget.divee.ai/functions/v1/analytics", {
    method: "POST",
    headers,
    body: opts.raw !== undefined ? opts.raw : JSON.stringify(body),
  });
}

/** Build a fetch stub that records calls and returns a canned Response. */
function makeFetchStub(response: Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(response);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

// deno-lint-ignore no-explicit-any
function makeDeps(overrides: Record<string, unknown> = {}): any {
  return {
    supabaseClient: () => Promise.resolve({} as unknown),
    getProjectById: () => Promise.resolve(fakeProject()),
    fetchFn: () => Promise.resolve(new Response("{}", { status: 200 })),
    ...overrides,
  };
}

// ── Preflight & body validation ───────────────────────────────────────────

Deno.test("analytics: OPTIONS preflight returns 200", async () => {
  const r = new Request("https://widget.divee.ai/functions/v1/analytics", {
    method: "OPTIONS",
    headers: { "origin": ALLOWED_ORIGIN },
  });
  const res = await analyticsHandler(r, makeDeps());
  assertEquals(res.status, 200);
});

Deno.test("analytics: non-JSON body returns 400", async () => {
  const res = await analyticsHandler(
    postEvent(undefined, { raw: "not json{" }),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("analytics: empty body returns 400", async () => {
  const res = await analyticsHandler(
    postEvent(undefined, { raw: "" }),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("analytics: missing project_id (single event) returns 400", async () => {
  const res = await analyticsHandler(
    postEvent({ event_type: "page_view" }),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("analytics: empty batch without top-level project_id returns 400", async () => {
  const res = await analyticsHandler(
    postEvent({ batch: [] }),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("analytics: project_id resolved from batch[0] when top-level missing", async () => {
  let capturedProjectId: string | null = null;
  const fetchStub = makeFetchStub(new Response('{"ok":true}', { status: 200 }));
  const deps = makeDeps({
    getProjectById: (projectId: string) => {
      capturedProjectId = projectId;
      return Promise.resolve(fakeProject());
    },
    fetchFn: fetchStub.fn,
  });
  const res = await analyticsHandler(
    postEvent({ batch: [{ project_id: PROJECT_ID, event_type: "page_view" }] }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(capturedProjectId, PROJECT_ID);
});

// ── Auth gate ────────────────────────────────────────────────────────────

Deno.test("analytics: getProjectById throws → 404", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.reject(new Error("project not found")),
  });
  const res = await analyticsHandler(
    postEvent({ project_id: PROJECT_ID }),
    deps,
  );
  assertEquals(res.status, 404);
});

Deno.test("analytics: origin not in allowed_urls returns 403", async () => {
  const deps = makeDeps({
    getProjectById: () => Promise.resolve(fakeProject({ allowed_urls: ["other.example.com"] })),
  });
  const res = await analyticsHandler(
    postEvent({ project_id: PROJECT_ID }),
    deps,
  );
  assertEquals(res.status, 403);
});

// ── Proxy configuration ──────────────────────────────────────────────────

Deno.test("analytics: ANALYTICS_PROXY_URL unset returns 503", async () => {
  const prev = Deno.env.get("ANALYTICS_PROXY_URL");
  Deno.env.delete("ANALYTICS_PROXY_URL");
  try {
    const res = await analyticsHandler(
      postEvent({ project_id: PROJECT_ID }),
      makeDeps(),
    );
    assertEquals(res.status, 503);
  } finally {
    if (prev !== undefined) Deno.env.set("ANALYTICS_PROXY_URL", prev);
  }
});

// ── Forwarding contract ──────────────────────────────────────────────────

Deno.test("analytics: happy path forwards raw body verbatim and returns proxy status + body", async () => {
  const proxyBody = '{"accepted":1}';
  const fetchStub = makeFetchStub(new Response(proxyBody, { status: 202 }));
  const deps = makeDeps({ fetchFn: fetchStub.fn });

  // Use a specific raw body string and assert the proxy sees EXACTLY that.
  // Key thing: the raw body bypasses JSON round-tripping so custom fields
  // and key order are preserved for downstream analytics.
  const raw = '{"project_id":"' + PROJECT_ID +
    '","event_type":"page_view","meta":{"custom":true}}';
  const res = await analyticsHandler(
    postEvent(undefined, { raw }),
    deps,
  );

  assertEquals(res.status, 202);
  const text = await res.text();
  assertEquals(text, proxyBody);

  // Proxy was called exactly once, at the configured URL, with the raw body
  assertEquals(fetchStub.calls.length, 1);
  assertEquals(fetchStub.calls[0].url, PROXY_URL);
  assertEquals(fetchStub.calls[0].init?.method, "POST");
  assertEquals(fetchStub.calls[0].init?.body, raw);
});

Deno.test("analytics: cf-connecting-ip, referer, origin headers forwarded when present", async () => {
  const fetchStub = makeFetchStub(new Response("{}", { status: 200 }));
  const deps = makeDeps({ fetchFn: fetchStub.fn });

  const res = await analyticsHandler(
    postEvent(
      { project_id: PROJECT_ID },
      {
        cfIp: "203.0.113.42",
        referer: "https://publisher.example.com/article/1",
      },
    ),
    deps,
  );
  assertEquals(res.status, 200);

  const hdrs = fetchStub.calls[0].init?.headers as Record<string, string>;
  // H-1: forwarding the authoritative CF IP is the reason the origin check
  // runs BEFORE the forward. Regressing this would let attackers spoof
  // geo-enrichment by faking x-forwarded-for.
  assertEquals(hdrs["cf-connecting-ip"], "203.0.113.42");
  assertEquals(hdrs["referer"], "https://publisher.example.com/article/1");
  assertEquals(hdrs["origin"], ALLOWED_ORIGIN);
  assertEquals(hdrs["Content-Type"], "application/json");
});

Deno.test("analytics: cf-connecting-ip / referer are NOT added when absent from the request", async () => {
  const fetchStub = makeFetchStub(new Response("{}", { status: 200 }));
  const deps = makeDeps({ fetchFn: fetchStub.fn });

  const res = await analyticsHandler(
    postEvent({ project_id: PROJECT_ID }), // no cf-ip, no referer
    deps,
  );
  assertEquals(res.status, 200);

  const hdrs = fetchStub.calls[0].init?.headers as Record<string, string>;
  assertEquals("cf-connecting-ip" in hdrs, false);
  assertEquals("referer" in hdrs, false);
  // origin WAS on the inbound (postEvent default) so it is forwarded
  assertEquals(hdrs["origin"], ALLOWED_ORIGIN);
});

Deno.test("analytics: upstream error status is propagated back to the caller", async () => {
  const fetchStub = makeFetchStub(
    new Response('{"error":"upstream boom"}', { status: 502 }),
  );
  const deps = makeDeps({ fetchFn: fetchStub.fn });
  const res = await analyticsHandler(
    postEvent({ project_id: PROJECT_ID }),
    deps,
  );
  assertEquals(res.status, 502);
  const text = await res.text();
  assertEquals(text, '{"error":"upstream boom"}');
});

Deno.test("analytics: fetch throw → 500 (top-level catch)", async () => {
  const deps = makeDeps({
    fetchFn: () => Promise.reject(new Error("network unreachable")),
  });
  const res = await analyticsHandler(
    postEvent({ project_id: PROJECT_ID }),
    deps,
  );
  assertEquals(res.status, 500);
});

// ── Teardown ──────────────────────────────────────────────────────────────
Deno.test("analytics: teardown (restore env)", () => {
  restoreEnv();
});
