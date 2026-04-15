/**
 * Tests for supabase/functions/_shared/origin.ts
 *
 * Pure unit tests — no env, no Deno.serve stub, no fetch mock. The only
 * thing worth locking in hard is the truth table for `isAllowedOrigin`,
 * since a regression there silently locks real visitors out of the widget
 * or (worse) lets unauthorized origins through.
 *
 * The extractHostFromEntry tolerance fix means allowed_urls entries can be
 * any of: bare hostnames, full URLs with protocol, URLs with paths, www.X,
 * uppercase, or mixed — all are normalized to the same bare hostname before
 * comparison. This test file is the regression net for that.
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  getBaseHost,
  getRequestOriginUrl,
  isAllowedOrigin,
  normalizeHost,
} from "../_shared/origin.ts";

// ── isAllowedOrigin: the behavior that actually matters ──────────────────

const REQUEST_ORIGIN = "https://publisher.example.com";

Deno.test("isAllowedOrigin: accepts bare hostname in allowed_urls", () => {
  assertEquals(
    isAllowedOrigin(REQUEST_ORIGIN, ["publisher.example.com"]),
    true,
  );
});

Deno.test("isAllowedOrigin: accepts full URL in allowed_urls (the fix)", () => {
  // Before the extractHostFromEntry fix this returned false — if someone
  // typed "https://…" into the widget admin UI, their domain was silently
  // locked out. Keep this test green.
  assertEquals(
    isAllowedOrigin(REQUEST_ORIGIN, ["https://publisher.example.com"]),
    true,
  );
});

Deno.test("isAllowedOrigin: accepts URL with path in allowed_urls", () => {
  assertEquals(
    isAllowedOrigin(REQUEST_ORIGIN, ["https://publisher.example.com/foo/bar"]),
    true,
  );
});

Deno.test("isAllowedOrigin: accepts www.-prefixed entry", () => {
  assertEquals(
    isAllowedOrigin(REQUEST_ORIGIN, ["www.publisher.example.com"]),
    true,
  );
});

Deno.test("isAllowedOrigin: www.-prefixed REQUEST also matches bare entry", () => {
  assertEquals(
    isAllowedOrigin("https://www.publisher.example.com", ["publisher.example.com"]),
    true,
  );
});

Deno.test("isAllowedOrigin: case-insensitive hostname comparison", () => {
  assertEquals(
    isAllowedOrigin(REQUEST_ORIGIN, ["PUBLISHER.EXAMPLE.COM"]),
    true,
  );
});

Deno.test("isAllowedOrigin: mixed list — allows when any one entry matches", () => {
  assertEquals(
    isAllowedOrigin(REQUEST_ORIGIN, [
      "https://other.com",
      "unrelated.net",
      "publisher.example.com",
    ]),
    true,
  );
});

Deno.test("isAllowedOrigin: rejects unrelated host", () => {
  assertEquals(
    isAllowedOrigin(REQUEST_ORIGIN, ["other.example.com"]),
    false,
  );
});

Deno.test("isAllowedOrigin: rejects when subdomain differs", () => {
  // The widget intentionally does NOT support subdomain wildcarding.
  // api.publisher.example.com is NOT the same as publisher.example.com.
  assertEquals(
    isAllowedOrigin("https://api.publisher.example.com", ["publisher.example.com"]),
    false,
  );
});

Deno.test("isAllowedOrigin: rejects empty allowlist", () => {
  assertEquals(isAllowedOrigin(REQUEST_ORIGIN, []), false);
});

Deno.test("isAllowedOrigin: rejects null/undefined allowlist", () => {
  assertEquals(isAllowedOrigin(REQUEST_ORIGIN, null), false);
  assertEquals(isAllowedOrigin(REQUEST_ORIGIN, undefined), false);
});

Deno.test("isAllowedOrigin: rejects null/undefined request origin", () => {
  assertEquals(isAllowedOrigin(null, ["publisher.example.com"]), false);
  assertEquals(isAllowedOrigin(undefined, ["publisher.example.com"]), false);
  assertEquals(isAllowedOrigin("", ["publisher.example.com"]), false);
});

Deno.test("isAllowedOrigin: rejects malformed request origin", () => {
  assertEquals(isAllowedOrigin("not a url at all", ["publisher.example.com"]), false);
});

Deno.test("isAllowedOrigin: junk entries in allowlist are harmless", () => {
  // A junk entry like "not a url" gets normalized to the raw lowercase string
  // and won't match any real hostname extracted from a browser origin.
  assertEquals(
    isAllowedOrigin(REQUEST_ORIGIN, ["not a url", "publisher.example.com"]),
    true,
  );
  assertEquals(
    isAllowedOrigin(REQUEST_ORIGIN, ["not a url"]),
    false,
  );
});

// ── getBaseHost: small sanity suite ──────────────────────────────────────

Deno.test("getBaseHost: extracts lowercased hostname from a URL", () => {
  assertEquals(getBaseHost("https://Foo.example.com/bar"), "foo.example.com");
});

Deno.test("getBaseHost: returns null for null/undefined/malformed", () => {
  assertEquals(getBaseHost(null), null);
  assertEquals(getBaseHost(undefined), null);
  assertEquals(getBaseHost("not a url"), null);
});

// ── normalizeHost: small sanity suite ────────────────────────────────────

Deno.test("normalizeHost: strips leading www. and lowercases", () => {
  assertEquals(normalizeHost("www.Foo.COM"), "foo.com");
  assertEquals(normalizeHost("foo.com"), "foo.com");
  assertEquals(normalizeHost("WWW.foo.com"), "foo.com");
});

Deno.test("normalizeHost: does NOT strip non-leading www.", () => {
  // Only the `^www\.` prefix is stripped — an embedded "www." elsewhere
  // in the hostname is left alone.
  assertEquals(normalizeHost("api.www.foo.com"), "api.www.foo.com");
});

// ── getRequestOriginUrl: trust boundary ──────────────────────────────────

Deno.test("getRequestOriginUrl: reads the Origin header only", () => {
  const r = new Request("https://widget.divee.ai/functions/v1/chat", {
    headers: {
      "origin": "https://publisher.example.com",
      "referer": "https://other.com/spoofed",
    },
  });
  assertEquals(getRequestOriginUrl(r), "https://publisher.example.com");
});

Deno.test("getRequestOriginUrl: returns null when Origin header is absent", () => {
  // H-4 fix: Referer is client-controlled and must never be trusted as a
  // fallback. Requests without an Origin header are rejected downstream.
  const r = new Request("https://widget.divee.ai/functions/v1/chat", {
    headers: { "referer": "https://publisher.example.com/article" },
  });
  assertEquals(getRequestOriginUrl(r), null);
});
