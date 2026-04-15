// Test helpers for divee-widget edge functions.
//
// The widget functions take an injected `Deps` object (see e.g.
// chat/index.ts → `ChatDeps` + `chatHandler`). Tests construct a
// partial-but-typed stub, merge it with `stub()` defaults for anything
// they don't care about, and call the handler directly. No fetch mocking,
// no network, no module-level state between tests.

/** Minimal POST request builder. Sets `content-length` so handlers that
 *  use `enforceContentLength` (SECURITY_AUDIT_TODO item 3) see a real
 *  value — Deno's in-memory `new Request()` does NOT populate it the way
 *  a browser does over the wire, so we have to do it manually. */
export function postJson(path: string, body: unknown, origin = "https://test.divee.ai"): Request {
  const serialized = JSON.stringify(body);
  return new Request(`https://widget.divee.ai/functions/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "origin": origin,
      "content-length": String(new TextEncoder().encode(serialized).byteLength),
    },
    body: serialized,
  });
}

/** Builds a stub function that throws if called, to catch accidentally-
 *  reached code paths in a test. Name lets the failure pinpoint which. */
export function unexpected<Args extends unknown[], Ret>(
  label: string,
): (...args: Args) => Ret {
  return (..._args: Args): Ret => {
    throw new Error(`[test] unexpected call to ${label}`);
  };
}

/** Build a StreamResult-shaped object around a string body. Used by tests
 *  that exercise the happy path and want to assert response headers. */
export function fakeStreamAnswer(bodyText = "data: hello\n\n") {
  return () =>
    Promise.resolve({
      response: new Response(bodyText, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      model: "test-model",
    });
}

/** No-op async function returning a constant. */
export function constResolve<T>(value: T): (...args: unknown[]) => Promise<T> {
  return () => Promise.resolve(value);
}

/** Read the body of a Response as text (consumes the stream). */
export async function readText(res: Response): Promise<string> {
  if (!res.body) return "";
  return await res.text();
}

/** Set env vars before importing a function module. Returns a restore()
 *  that clears everything we set, for test cleanup / isolation. */
export function setEnv(
  extra: Record<string, string> = {},
): () => void {
  const base: Record<string, string> = {
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    VISITOR_TOKEN_SECRET: "test-visitor-token-secret-not-real",
    OPENAI_API_KEY: "sk-test-not-real",
  };
  const merged = { ...base, ...extra };
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(merged)) {
    previous[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  return () => {
    for (const [k, prev] of Object.entries(previous)) {
      if (prev === undefined) Deno.env.delete(k);
      else Deno.env.set(k, prev);
    }
  };
}
