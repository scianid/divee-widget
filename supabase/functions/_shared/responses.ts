import { corsHeaders, corsHeadersForCache } from "./cors.ts";

export function errorResp(message: string, status = 400, body: object = {}) {
  console.error(message);
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Connection": "keep-alive",
      },
    },
  );
}

export function successResp(
  body: object = {},
  status = 200,
  additionalHeaders: Record<string, string> = {},
) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Connection": "keep-alive",
        ...additionalHeaders,
      },
    },
  );
}

/**
 * 429 Too Many Requests with a Retry-After header. Used by every
 * rate-limited edge function so the shape is consistent across endpoints.
 * Body is `{error, retryAfter}` — the `retryAfter` field mirrors the
 * header so clients that don't read headers (analytics beacons, for one)
 * can still back off.
 */
export function tooManyRequestsResp(retryAfterSeconds: number) {
  return new Response(
    JSON.stringify({ error: "Too many requests", retryAfter: retryAfterSeconds }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

export function successRespWithCache(
  body: object = {},
  maxAge = 300,
  sMaxAge = 3600,
  surrogateKey = "config",
) {
  return new Response(
    JSON.stringify(body),
    {
      status: 200,
      headers: {
        ...corsHeadersForCache,
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${maxAge}, s-maxage=${sMaxAge}`,
        "Surrogate-Control": `max-age=${sMaxAge}`,
        "Surrogate-Key": surrogateKey,
      },
    },
  );
}
