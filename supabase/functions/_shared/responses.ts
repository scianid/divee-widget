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
 * Reject requests whose Content-Length header is missing, unparseable, or
 * exceeds `maxBytes`. Returns a 413 `Response` (or 411 for missing header)
 * that the caller should return immediately; returns `null` to indicate
 * the request is within bounds and handling should continue.
 *
 * SECURITY_AUDIT_TODO item 3: without this check, every body-accepting
 * handler did `await req.text()` / `await req.json()` on arbitrarily large
 * payloads, loading the whole body into memory before the handler's own
 * truncate logic ran. Now size is gated BEFORE any read.
 *
 * Content-Length is trusted because (a) the widget is called directly from
 * browsers via fetch which always sets it on a finite body, (b) Supabase
 * edge runtime reads the request through the HTTP stack that validates it,
 * (c) an attacker lying about Content-Length would get their request
 * rejected at a lower layer anyway. A missing header implies chunked
 * transfer encoding — uncommon for widget traffic — so we reject it
 * explicitly rather than fall back to reading.
 */
export function enforceContentLength(req: Request, maxBytes: number): Response | null {
  const raw = req.headers.get("content-length");
  if (raw === null) {
    return new Response(
      JSON.stringify({ error: "Content-Length required" }),
      {
        status: 411,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return new Response(
      JSON.stringify({ error: "Invalid Content-Length" }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
  if (n > maxBytes) {
    return new Response(
      JSON.stringify({ error: "Payload too large", maxBytes }),
      {
        status: 413,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
  return null;
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
