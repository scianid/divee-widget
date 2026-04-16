export function getBaseHost(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

// Prefer Origin header, fall back to Referer. The CDN (Fastly/Cloudflare)
// strips the Origin header when forwarding to the edge function, so browser
// requests arrive without it. Referer is reliably present on GET requests
// and is sufficient for hostname-based allowlisting on read-only endpoints.
export function getRequestOriginUrl(req: Request): string | null {
  return req.headers.get("origin") || req.headers.get("referer") || null;
}

// Extract a bare hostname from a project.allowed_urls entry. Tolerates both
// full URLs (`https://foo.com`, `https://foo.com/path`) and bare hostnames
// (`foo.com`, `www.foo.com`).
function extractHostFromEntry(entry: string): string {
  try {
    return new URL(entry).hostname.toLowerCase();
  } catch { /* not a full URL — retry with a synthetic scheme */ }
  try {
    return new URL(`https://${entry}`).hostname.toLowerCase();
  } catch {
    return entry.toLowerCase();
  }
}

export function isAllowedOrigin(
  rawUrl: string | null | undefined,
  allowedUrls: string[] | null | undefined,
): boolean {
  // No Origin and no Referer — CDN cache-warming or infra request.
  // Real browsers always send at least one of these headers.
  if (!rawUrl) return true;

  const requestHost = normalizeHost(getBaseHost(rawUrl) || "");
  const allowedHosts = Array.isArray(allowedUrls)
    ? allowedUrls.map((entry) => normalizeHost(extractHostFromEntry(entry)))
    : [];

  return !!requestHost && allowedHosts.length > 0 &&
    allowedHosts.includes(requestHost);
}
