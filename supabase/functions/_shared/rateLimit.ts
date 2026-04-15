/**
 * Edge function rate limiter.
 *
 * Uses a 1-minute tumbling window backed by the `ai_rate_limits` Postgres table.
 * The `increment_rate_limit` DB function performs an atomic INSERT … ON CONFLICT
 * DO UPDATE, so there is no read-then-write race condition.
 *
 * Limits are per-endpoint, per-key-type. See the `LIMITS` map below for
 * current values. SECURITY_AUDIT_TODO.md item 2 tracks the rationale for
 * the expansion beyond the original /chat + /suggestions coverage.
 */

type SupabaseClient = any;

export type RateLimitResult =
  | { limited: false }
  | { limited: true; retryAfterSeconds: number };

export type RateLimitEndpoint =
  | "chat"
  | "suggestions"
  | "config"
  | "articles"
  | "analytics";

/**
 * Limits by endpoint and key type. Visitor limits apply only when a
 * visitor_id is known (chat, suggestions, analytics event bodies). The
 * project limit is ALWAYS checked — it's the ceiling that protects an
 * individual publisher against bulk enumeration even when the attacker
 * rotates fake visitor IDs.
 *
 * Budgets set per SECURITY_AUDIT_TODO.md:
 *   /chat        — 20 visitor / 500 project  (original, AI path is expensive)
 *   /suggestions — 5 visitor  / 200 project  (original, AI path is expensive)
 *   /config      — visitor unused / 300 project (1 call per page load)
 *   /articles    — visitor unused / 300 project (discovery, not hot)
 *   /analytics   — 60 visitor / 1000 project (hottest, but cheap)
 */
const LIMITS: Record<RateLimitEndpoint, Record<"visitor" | "project", number>> = {
  chat: { visitor: 20, project: 500 },
  suggestions: { visitor: 5, project: 200 },
  config: { visitor: 0, project: 300 },
  articles: { visitor: 0, project: 300 },
  analytics: { visitor: 60, project: 1000 },
};

/**
 * Check and increment both the visitor-level and project-level rate limit
 * counters for the given endpoint in a single 1-minute window.
 *
 * Returns `{ limited: true, retryAfterSeconds }` if either limit is exceeded,
 * or `{ limited: false }` to allow the request through.
 *
 * Errors from the DB are logged and silently ignored (fail-open) to avoid
 * blocking legitimate traffic due to a transient DB issue.
 */
export async function checkRateLimit(
  supabase: SupabaseClient,
  endpoint: RateLimitEndpoint,
  visitorId: string | null | undefined,
  projectId: string,
): Promise<RateLimitResult> {
  const limits = LIMITS[endpoint];
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000)
    .toISOString();
  const retryAfterSeconds = Math.ceil(
    (Math.floor(Date.now() / 60_000) * 60_000 + 60_000 - Date.now()) / 1000,
  );

  // Keys to check: always check project; check visitor only if known AND
  // the endpoint defines a visitor limit. A `visitor: 0` in LIMITS means
  // "no visitor-level limit for this endpoint" (e.g. config/articles
  // don't know who the visitor is).
  const checks: Array<{ key: string; limit: number }> = [
    { key: `${endpoint}:project:${projectId}`, limit: limits.project },
  ];
  if (visitorId && limits.visitor > 0) {
    checks.push({
      key: `${endpoint}:visitor:${visitorId}`,
      limit: limits.visitor,
    });
  }

  for (const { key, limit } of checks) {
    try {
      const { data, error } = await supabase.rpc("increment_rate_limit", {
        p_key: key,
        p_window_start: windowStart,
      });

      if (error) {
        console.error(`rateLimit: db error for key=${key}`, error);
        continue; // fail-open on DB errors
      }

      const count: number = data ?? 0;

      if (count > limit) {
        console.warn(
          `rateLimit: limit exceeded key=${key} count=${count} limit=${limit}`,
        );
        return { limited: true, retryAfterSeconds };
      }
    } catch (err) {
      console.error(`rateLimit: unexpected error for key=${key}`, err);
      // fail-open
    }
  }

  return { limited: false };
}
