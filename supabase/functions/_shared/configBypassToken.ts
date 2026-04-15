/**
 * Short-lived HMAC-signed tokens for the /config origin-check bypass.
 *
 * SECURITY_AUDIT_TODO item 7 / SOC2 CC6.1 + CC7.3: the previous bypass
 * mechanism was a single static `CONFIG_BYPASS_KEY` env var compared as
 * a string. That had three problems:
 *
 *   1. Long-lived credential — no TTL, no forced rotation. If it leaked
 *      in a screenshot, ticket, or curl dump, there was no way to know
 *      and no way to expire it without a deploy.
 *   2. No attribution — a log line saying "bypass succeeded" couldn't
 *      tell you who was bypassing. The key was shared across every
 *      operator and every use case.
 *   3. Overloaded — the same env var was being reused as the `x-api-key`
 *      on outbound analytics proxy calls, so rotating one would silently
 *      break the other. That coupling is fixed separately in
 *      `_shared/analytics.ts` (new `ANALYTICS_PROXY_API_KEY`).
 *
 * Replacement: a signed, time-boxed token with an operator field for
 * attribution. Same HMAC-SHA256 primitive as
 * `_shared/visitorAuth.ts` — the two modules duplicate `hmacHex` and
 * `safeEqual` today; consolidate into `_shared/hmac.ts` if a third
 * consumer ever shows up.
 *
 * Token format (pipe-separated, only ASCII alphanumerics + hyphen in
 * the operator field so the separators are unambiguous):
 *
 *   v1|{operator}|{expiresMs}|{hmac-sha256-hex}
 *
 * Where the signed message is `v1|{operator}|{expiresMs}`. The `v1`
 * prefix lets us rotate the algorithm later without ambiguity.
 *
 * Environment:
 *   CONFIG_BYPASS_SECRET — HMAC key. REQUIRED for issue/verify. Distinct
 *                          from the old `CONFIG_BYPASS_KEY` so there's
 *                          no accidental reuse of the stale value.
 *
 * Operators should be short, human-readable identifiers that are useful
 * in logs: `moshe`, `oncall`, `ci`, `dev-shell`. Do NOT put secrets here
 * — it is echoed back in successful-bypass log lines.
 */

// Max allowed TTL for an issued token. The bypass is an operator tool;
// anything longer is a sign you actually want a durable auth mechanism.
export const MAX_BYPASS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const OPERATOR_PATTERN = /^[a-zA-Z0-9-]{1,32}$/;

function getSecret(): string {
  // @ts-ignore: Deno.env is available in the Edge Runtime
  return Deno.env.get("CONFIG_BYPASS_SECRET") ?? "";
}

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time comparison. Same primitive as visitorAuth.safeEqual. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a signed bypass token for `operator` that expires `ttlMs` from
 * now. Throws if the secret is not configured, the operator doesn't
 * match OPERATOR_PATTERN, or the TTL is non-positive / exceeds
 * MAX_BYPASS_TOKEN_TTL_MS. The hard ceiling on TTL is deliberate: if
 * you need a longer-lived credential, you need a different mechanism.
 */
export async function issueConfigBypassToken(
  operator: string,
  ttlMs: number,
): Promise<string> {
  const secret = getSecret();
  if (!secret) throw new Error("CONFIG_BYPASS_SECRET is not configured");
  if (!OPERATOR_PATTERN.test(operator)) {
    throw new Error(
      `operator must match ${OPERATOR_PATTERN} (1-32 alphanumerics or hyphens)`,
    );
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("ttlMs must be a positive number");
  }
  if (ttlMs > MAX_BYPASS_TOKEN_TTL_MS) {
    throw new Error(`ttlMs exceeds MAX_BYPASS_TOKEN_TTL_MS (${MAX_BYPASS_TOKEN_TTL_MS})`);
  }
  const expires = Date.now() + ttlMs;
  const message = `v1|${operator}|${expires}`;
  const hex = await hmacHex(message, secret);
  return `${message}|${hex}`;
}

/**
 * Verify a bypass token. Returns `{operator, expiresMs}` on success, or
 * `null` on any failure: missing secret, malformed token, invalid
 * signature, expired, or unknown version. Never throws — a verification
 * failure must not leak information about which check failed, so the
 * caller gets a boolean-shaped answer only.
 */
export async function verifyConfigBypassToken(
  token: string | null | undefined,
): Promise<{ operator: string; expiresMs: number } | null> {
  if (!token) return null;
  const secret = getSecret();
  if (!secret) return null;

  const parts = token.split("|");
  if (parts.length !== 4) return null;
  const [version, operator, expiresStr, receivedHex] = parts;
  if (version !== "v1") return null;
  if (!OPERATOR_PATTERN.test(operator)) return null;
  if (!expiresStr || !receivedHex) return null;

  const expires = parseInt(expiresStr, 10);
  if (!Number.isFinite(expires) || Date.now() > expires) return null;

  const message = `v1|${operator}|${expires}`;
  const expectedHex = await hmacHex(message, secret);
  if (!safeEqual(expectedHex, receivedHex)) return null;

  return { operator, expiresMs: expires };
}
