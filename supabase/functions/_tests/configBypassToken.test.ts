/**
 * Tests for supabase/functions/_shared/configBypassToken.ts.
 *
 * SECURITY_AUDIT_TODO item 7 / SOC2 CC6.1: the /config origin bypass is
 * now a short-lived HMAC-signed token, not a static shared secret.
 * These tests pin:
 *
 *   - Round-trip works with a valid operator + TTL.
 *   - Expired tokens are rejected.
 *   - Tampered tokens are rejected (signature mismatch).
 *   - Tokens signed with a different secret are rejected.
 *   - Malformed tokens (wrong part count, wrong version) are rejected.
 *   - Operator regex is enforced on issue.
 *   - TTL ceiling is enforced on issue.
 *   - Missing secret → issue throws, verify returns null.
 *
 * A real `CONFIG_BYPASS_SECRET` is set at module load — the tests import
 * the helper directly rather than going through the config handler, so
 * we don't need to neutralize Deno.serve.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { setEnv } from "./helpers.ts";

const restoreEnv = setEnv({
  CONFIG_BYPASS_SECRET: "test-secret-for-configBypassToken-unit-test",
});

const {
  issueConfigBypassToken,
  verifyConfigBypassToken,
  MAX_BYPASS_TOKEN_TTL_MS,
} = await import("../_shared/configBypassToken.ts");

// ── Happy path ────────────────────────────────────────────────────────────

Deno.test("configBypassToken: round-trip with valid operator + short TTL", async () => {
  const token = await issueConfigBypassToken("moshe", 60_000);
  const verified = await verifyConfigBypassToken(token);
  assertEquals(verified?.operator, "moshe");
  // expiresMs should be within the TTL window.
  const now = Date.now();
  const exp = verified?.expiresMs ?? 0;
  assertEquals(exp > now, true);
  assertEquals(exp <= now + 60_000 + 100, true); // 100ms clock slack
});

Deno.test("configBypassToken: token format is v1|operator|expiresMs|hex", async () => {
  const token = await issueConfigBypassToken("ci", 30_000);
  const parts = token.split("|");
  assertEquals(parts.length, 4);
  assertEquals(parts[0], "v1");
  assertEquals(parts[1], "ci");
  assertEquals(/^[0-9a-f]{64}$/.test(parts[3]), true); // SHA-256 hex
});

// ── Rejection paths ───────────────────────────────────────────────────────

Deno.test("configBypassToken: expired token is rejected", async () => {
  // Mint with negative "past" expiry by bypassing the ttlMs check:
  // we can't call the public issuer with a past expiry, so construct
  // the token manually using the same algorithm. Or — easier — wait
  // past expiry on a very short token. Deno's test harness can handle
  // a 50ms sleep.
  const token = await issueConfigBypassToken("short-ttl", 50);
  await new Promise((r) => setTimeout(r, 100));
  const verified = await verifyConfigBypassToken(token);
  assertEquals(verified, null);
});

Deno.test("configBypassToken: tampered signature is rejected", async () => {
  const token = await issueConfigBypassToken("moshe", 60_000);
  // Flip the last hex character of the signature — any change breaks
  // the HMAC and the constant-time compare returns false.
  const flipped = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
  const verified = await verifyConfigBypassToken(flipped);
  assertEquals(verified, null);
});

Deno.test("configBypassToken: tampered payload (different operator) is rejected", async () => {
  const token = await issueConfigBypassToken("alice", 60_000);
  // Replace the operator with a different one — signature no longer
  // matches the message.
  const parts = token.split("|");
  const forged = `v1|bob|${parts[2]}|${parts[3]}`;
  const verified = await verifyConfigBypassToken(forged);
  assertEquals(verified, null);
});

Deno.test("configBypassToken: malformed token (wrong part count) is rejected", async () => {
  assertEquals(await verifyConfigBypassToken("not-a-token"), null);
  assertEquals(await verifyConfigBypassToken("v1|op|123"), null); // 3 parts
  assertEquals(await verifyConfigBypassToken("v1|op|123|abc|extra"), null); // 5 parts
});

Deno.test("configBypassToken: unknown version prefix is rejected", async () => {
  // Guard against future algo rotation: anything other than v1 must
  // bounce even if the rest of the structure looks right.
  const valid = await issueConfigBypassToken("moshe", 60_000);
  const parts = valid.split("|");
  const forged = `v2|${parts[1]}|${parts[2]}|${parts[3]}`;
  assertEquals(await verifyConfigBypassToken(forged), null);
});

Deno.test("configBypassToken: null / undefined / empty token → null", async () => {
  assertEquals(await verifyConfigBypassToken(null), null);
  assertEquals(await verifyConfigBypassToken(undefined), null);
  assertEquals(await verifyConfigBypassToken(""), null);
});

// ── Issuer validation ────────────────────────────────────────────────────

Deno.test("configBypassToken: operator must match OPERATOR_PATTERN", async () => {
  await assertRejects(
    () => issueConfigBypassToken("", 60_000),
    Error,
    "operator must match",
  );
  await assertRejects(
    () => issueConfigBypassToken("has space", 60_000),
    Error,
    "operator must match",
  );
  await assertRejects(
    () => issueConfigBypassToken("has|pipe", 60_000),
    Error,
    "operator must match",
  );
  // 33-char operator exceeds the 32-char cap.
  await assertRejects(
    () => issueConfigBypassToken("a".repeat(33), 60_000),
    Error,
    "operator must match",
  );
});

Deno.test("configBypassToken: TTL must be positive and under MAX", async () => {
  await assertRejects(() => issueConfigBypassToken("moshe", 0), Error, "ttlMs must be");
  await assertRejects(() => issueConfigBypassToken("moshe", -1), Error, "ttlMs must be");
  await assertRejects(
    () => issueConfigBypassToken("moshe", MAX_BYPASS_TOKEN_TTL_MS + 1),
    Error,
    "MAX_BYPASS_TOKEN_TTL_MS",
  );
});

// ── Secret handling ──────────────────────────────────────────────────────

Deno.test("configBypassToken: missing CONFIG_BYPASS_SECRET — issue throws, verify returns null", async () => {
  const prev = Deno.env.get("CONFIG_BYPASS_SECRET");
  Deno.env.delete("CONFIG_BYPASS_SECRET");
  try {
    await assertRejects(
      () => issueConfigBypassToken("moshe", 60_000),
      Error,
      "CONFIG_BYPASS_SECRET is not configured",
    );
    // Verify with any token also fails silently.
    assertEquals(await verifyConfigBypassToken("v1|moshe|9999999999999|abc"), null);
  } finally {
    if (prev !== undefined) Deno.env.set("CONFIG_BYPASS_SECRET", prev);
  }
});

Deno.test("configBypassToken: tokens are not portable across secrets", async () => {
  // Mint with secret A, swap to secret B, verify fails.
  const token = await issueConfigBypassToken("moshe", 60_000);
  const prev = Deno.env.get("CONFIG_BYPASS_SECRET");
  Deno.env.set("CONFIG_BYPASS_SECRET", "a-completely-different-secret");
  try {
    assertEquals(await verifyConfigBypassToken(token), null);
  } finally {
    if (prev !== undefined) Deno.env.set("CONFIG_BYPASS_SECRET", prev);
  }
});

// ── Teardown ──────────────────────────────────────────────────────────────
Deno.test("configBypassToken: teardown (restore env)", () => {
  restoreEnv();
});
