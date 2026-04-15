/**
 * Tests for supabase/functions/conversations/index.ts
 *
 * Exercises the dependency-injection seam (`conversationsHandler(req, deps)`).
 *
 * This function is ENTIRELY about authorization — there is no public cache,
 * no AI, no fan-out. Every test below is really asking the same question:
 * "can a caller read or mutate a conversation they don't own?" The answer
 * must always be no. The C-2 incident that drove the visitor-token check
 * is documented in index.ts; these tests exist so a future refactor can't
 * silently re-open that hole.
 *
 * Covered behaviors:
 *   - OPTIONS preflight returns 200 without requiring a token
 *   - Every non-OPTIONS request without a valid token returns 401
 *   - Token accepted from X-Visitor-Token header OR visitor_token query param
 *   - GET /conversations:
 *       · 400 when visitor_id/project_id missing
 *       · 403 when token's visitor_id or project_id doesn't match the query
 *       · happy path returns the simplified list shape
 *   - GET /conversations/:id/messages:
 *       · 404 when conversation doesn't exist
 *       · 403 when conversation.visitor_id !== token.visitorId
 *       · happy path returns messages array
 *   - POST /conversations/reset:
 *       · 400 when visitor_id/article_unique_id/project_id missing
 *       · 403 when token visitor/project doesn't match body
 *       · 500 when DAO returns falsy conversationId
 *       · happy path returns {conversation_id}
 *   - DELETE /conversations/:id:
 *       · 404 when not found
 *       · 403 when token visitor doesn't own it
 *       · 500 when DAO returns falsy
 *       · happy path returns {success: true}
 *   - Unknown route → 404
 *   - DAO throw → 500
 */
import { assertEquals } from "jsr:@std/assert@1";
import { setEnv } from "./helpers.ts";

// ── One-time env setup ────────────────────────────────────────────────────
const restoreEnv = setEnv();

// Neutralize the module-level `Deno.serve(...)` so the dynamic import below
// doesn't try to bind a port. We test `conversationsHandler` directly.
// @ts-ignore: Deno globals are unavailable to the editor TS server
Deno.serve = ((_fn: unknown) => ({} as unknown)) as typeof Deno.serve;

const conversationsModule = await import("../conversations/index.ts") as {
  conversationsHandler: (req: Request, deps: unknown) => Promise<Response>;
};
const { conversationsHandler } = conversationsModule;

// ── Fixtures ──────────────────────────────────────────────────────────────

const PROJECT_ID = "proj-test-conversations-0001";
const VISITOR_ID = "visitor-owner";
const OTHER_VISITOR_ID = "visitor-attacker";
const CONVERSATION_ID = "conv-123";
const ARTICLE_UNIQUE_ID = "https://publisher.example.com/a" + PROJECT_ID;
const GOOD_TOKEN = "opaque-good-token"; // stub — real verifier is mocked

function fakeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    visitor_id: VISITOR_ID,
    project_id: PROJECT_ID,
    article_unique_id: "https://publisher.example.com/a-xyz",
    article_title: "Some Article",
    last_message_at: "2026-04-15T12:00:00Z",
    message_count: 3,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    ...overrides,
  };
}

/**
 * Build a ConversationsDeps stub. Defaults accept `GOOD_TOKEN` as belonging
 * to (VISITOR_ID, PROJECT_ID). Any other token returns null (unauth).
 * Tests override only the bits they're asserting on.
 */
// deno-lint-ignore no-explicit-any
function makeDeps(overrides: Record<string, unknown> = {}): any {
  return {
    supabaseClient: () => Promise.resolve({} as unknown),
    verifyVisitorToken: (token: string | null | undefined) => {
      if (token === GOOD_TOKEN) {
        return Promise.resolve({ visitorId: VISITOR_ID, projectId: PROJECT_ID });
      }
      return Promise.resolve(null);
    },
    listConversationsByVisitor: () => Promise.resolve([]),
    getConversationById: () => Promise.resolve(fakeConversation()),
    resetConversation: () => Promise.resolve("conv-new"),
    deleteConversation: () => Promise.resolve(true),
    // SECURITY_AUDIT_TODO item 8: audit is best-effort; default stub
    // reports success and records nothing. Per-test overrides record
    // the args for assertion.
    recordAuditEvent: () => Promise.resolve(true),
    ...overrides,
  };
}

function buildReq(
  method: string,
  path: string,
  opts: {
    token?: string | null;
    tokenInQuery?: boolean;
    query?: Record<string, string>;
    body?: unknown;
  } = {},
): Request {
  // NOTE: no `/functions/v1/` prefix. The real Supabase edge runtime strips
  // the function-name prefix before the handler's URL parser sees it, so
  // `pathParts[0]` is "conversations" and the positional matching (length 1
  // for list, length 3 for messages, etc.) lines up correctly.
  const u = new URL(`https://widget.divee.ai/${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) u.searchParams.set(k, v);
  }
  if (opts.tokenInQuery && opts.token) {
    u.searchParams.set("visitor_token", opts.token);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token && !opts.tokenInQuery) headers["x-visitor-token"] = opts.token;
  const serialized = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  if (serialized !== undefined) {
    // Set content-length so enforceContentLength in the reset handler
    // (SECURITY_AUDIT_TODO item 3) sees a real value.
    headers["content-length"] = String(new TextEncoder().encode(serialized).byteLength);
  }
  return new Request(u.toString(), {
    method,
    headers,
    body: serialized,
  });
}

// ── Preflight & auth gate ─────────────────────────────────────────────────

Deno.test("conversations: OPTIONS preflight returns 200 without a token", async () => {
  const r = new Request("https://widget.divee.ai/functions/v1/conversations", {
    method: "OPTIONS",
  });
  const res = await conversationsHandler(r, makeDeps());
  assertEquals(res.status, 200);
});

Deno.test("conversations: missing token returns 401 (GET list)", async () => {
  const res = await conversationsHandler(
    buildReq("GET", "conversations", {
      query: { visitor_id: VISITOR_ID, project_id: PROJECT_ID },
    }),
    makeDeps(),
  );
  assertEquals(res.status, 401);
});

Deno.test("conversations: invalid token returns 401", async () => {
  const res = await conversationsHandler(
    buildReq("GET", "conversations", {
      token: "forged",
      query: { visitor_id: VISITOR_ID, project_id: PROJECT_ID },
    }),
    makeDeps(),
  );
  assertEquals(res.status, 401);
});

Deno.test("conversations: token accepted from visitor_token query param", async () => {
  const res = await conversationsHandler(
    buildReq("GET", "conversations", {
      token: GOOD_TOKEN,
      tokenInQuery: true,
      query: { visitor_id: VISITOR_ID, project_id: PROJECT_ID },
    }),
    makeDeps(),
  );
  assertEquals(res.status, 200);
});

// ── GET /conversations (list) ─────────────────────────────────────────────

Deno.test("conversations GET list: missing visitor_id returns 400", async () => {
  const res = await conversationsHandler(
    buildReq("GET", "conversations", {
      token: GOOD_TOKEN,
      query: { project_id: PROJECT_ID },
    }),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("conversations GET list: token visitor_id mismatch returns 403", async () => {
  const res = await conversationsHandler(
    buildReq("GET", "conversations", {
      token: GOOD_TOKEN,
      query: { visitor_id: OTHER_VISITOR_ID, project_id: PROJECT_ID },
    }),
    makeDeps(),
  );
  assertEquals(res.status, 403);
});

Deno.test("conversations GET list: token project_id mismatch returns 403", async () => {
  const res = await conversationsHandler(
    buildReq("GET", "conversations", {
      token: GOOD_TOKEN,
      query: { visitor_id: VISITOR_ID, project_id: "other-project" },
    }),
    makeDeps(),
  );
  assertEquals(res.status, 403);
});

Deno.test("conversations GET list: happy path returns simplified list shape", async () => {
  const deps = makeDeps({
    listConversationsByVisitor: () =>
      Promise.resolve([
        {
          id: "c1",
          article_title: "Title One",
          article_unique_id: "https://example.com/one-xyz",
          last_message_at: "2026-04-15T10:00:00Z",
          message_count: 5,
        },
      ]),
  });
  const res = await conversationsHandler(
    buildReq("GET", "conversations", {
      token: GOOD_TOKEN,
      query: { visitor_id: VISITOR_ID, project_id: PROJECT_ID },
    }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.conversations.length, 1);
  assertEquals(body.conversations[0].id, "c1");
  assertEquals(body.conversations[0].article_title, "Title One");
  assertEquals(body.conversations[0].message_count, 5);
  // article_url is split on "-" — per the inline comment in index.ts the
  // first segment is the URL. This test pins that contract.
  assertEquals(body.conversations[0].article_url, "https://example.com/one");
});

// ── GET /conversations/:id/messages ──────────────────────────────────────

Deno.test("conversations GET messages: 404 when conversation not found", async () => {
  const deps = makeDeps({
    getConversationById: () => Promise.resolve(null),
  });
  const res = await conversationsHandler(
    buildReq("GET", `conversations/${CONVERSATION_ID}/messages`, { token: GOOD_TOKEN }),
    deps,
  );
  assertEquals(res.status, 404);
});

Deno.test("conversations GET messages: 403 when conversation owned by another visitor", async () => {
  const deps = makeDeps({
    getConversationById: () => Promise.resolve(fakeConversation({ visitor_id: OTHER_VISITOR_ID })),
  });
  const res = await conversationsHandler(
    buildReq("GET", `conversations/${CONVERSATION_ID}/messages`, { token: GOOD_TOKEN }),
    deps,
  );
  assertEquals(res.status, 403);
});

Deno.test("conversations GET messages: happy path returns messages array", async () => {
  const res = await conversationsHandler(
    buildReq("GET", `conversations/${CONVERSATION_ID}/messages`, { token: GOOD_TOKEN }),
    makeDeps(),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.messages.length, 2);
  assertEquals(body.messages[0].role, "user");
});

Deno.test("conversations GET messages: missing messages field defaults to empty array", async () => {
  const deps = makeDeps({
    getConversationById: () => Promise.resolve(fakeConversation({ messages: null })),
  });
  const res = await conversationsHandler(
    buildReq("GET", `conversations/${CONVERSATION_ID}/messages`, { token: GOOD_TOKEN }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.messages, []);
});

// ── Content-length guard on reset (SECURITY_AUDIT_TODO item 3) ──────────

Deno.test("conversations POST reset: Content-Length above 4KB cap returns 413", async () => {
  // Direct Request build to override content-length (buildReq would
  // otherwise set it from the actual body length).
  const r = new Request("https://widget.divee.ai/conversations/reset", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-visitor-token": GOOD_TOKEN,
      "content-length": String(10_000),
    },
    body: "{}",
  });
  const res = await conversationsHandler(r, makeDeps());
  assertEquals(res.status, 413);
});

Deno.test("conversations GET list: no Content-Length is fine (no body)", async () => {
  // Regression guard: the content-length check is scoped to the reset
  // branch only. GET routes must still work without Content-Length.
  const res = await conversationsHandler(
    buildReq("GET", "conversations", {
      token: GOOD_TOKEN,
      query: { visitor_id: VISITOR_ID, project_id: PROJECT_ID },
    }),
    makeDeps(),
  );
  assertEquals(res.status, 200);
});

// ── POST /conversations/reset ────────────────────────────────────────────

Deno.test("conversations POST reset: missing fields returns 400", async () => {
  const res = await conversationsHandler(
    buildReq("POST", "conversations/reset", {
      token: GOOD_TOKEN,
      body: { visitor_id: VISITOR_ID, project_id: PROJECT_ID }, // missing article_unique_id
    }),
    makeDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("conversations POST reset: token visitor mismatch returns 403", async () => {
  const res = await conversationsHandler(
    buildReq("POST", "conversations/reset", {
      token: GOOD_TOKEN,
      body: {
        visitor_id: OTHER_VISITOR_ID,
        article_unique_id: ARTICLE_UNIQUE_ID,
        project_id: PROJECT_ID,
      },
    }),
    makeDeps(),
  );
  assertEquals(res.status, 403);
});

Deno.test("conversations POST reset: DAO returns null → 500", async () => {
  const deps = makeDeps({
    resetConversation: () => Promise.resolve(null),
  });
  const res = await conversationsHandler(
    buildReq("POST", "conversations/reset", {
      token: GOOD_TOKEN,
      body: {
        visitor_id: VISITOR_ID,
        article_unique_id: ARTICLE_UNIQUE_ID,
        project_id: PROJECT_ID,
      },
    }),
    deps,
  );
  assertEquals(res.status, 500);
});

Deno.test("conversations POST reset: happy path returns new conversation_id", async () => {
  const deps = makeDeps({
    resetConversation: () => Promise.resolve("conv-reset-999"),
  });
  const res = await conversationsHandler(
    buildReq("POST", "conversations/reset", {
      token: GOOD_TOKEN,
      body: {
        visitor_id: VISITOR_ID,
        article_unique_id: ARTICLE_UNIQUE_ID,
        project_id: PROJECT_ID,
      },
    }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.conversation_id, "conv-reset-999");
});

// ── DELETE /conversations/:id ────────────────────────────────────────────

Deno.test("conversations DELETE: 404 when conversation not found", async () => {
  const deps = makeDeps({
    getConversationById: () => Promise.resolve(null),
  });
  const res = await conversationsHandler(
    buildReq("DELETE", `conversations/${CONVERSATION_ID}`, { token: GOOD_TOKEN }),
    deps,
  );
  assertEquals(res.status, 404);
});

Deno.test("conversations DELETE: 403 when conversation owned by another visitor", async () => {
  let deleteCalled = false;
  const deps = makeDeps({
    getConversationById: () => Promise.resolve(fakeConversation({ visitor_id: OTHER_VISITOR_ID })),
    deleteConversation: () => {
      deleteCalled = true;
      return Promise.resolve(true);
    },
  });
  const res = await conversationsHandler(
    buildReq("DELETE", `conversations/${CONVERSATION_ID}`, { token: GOOD_TOKEN }),
    deps,
  );
  assertEquals(res.status, 403);
  // The DELETE DAO must NEVER run when ownership fails. This is the whole
  // point of the pre-fetch-then-check flow — regression would silently let
  // one visitor wipe another's conversations.
  assertEquals(deleteCalled, false);
});

Deno.test("conversations DELETE: DAO returns false → 500", async () => {
  const deps = makeDeps({
    deleteConversation: () => Promise.resolve(false),
  });
  const res = await conversationsHandler(
    buildReq("DELETE", `conversations/${CONVERSATION_ID}`, { token: GOOD_TOKEN }),
    deps,
  );
  assertEquals(res.status, 500);
});

Deno.test("conversations DELETE: happy path returns {success: true}", async () => {
  const res = await conversationsHandler(
    buildReq("DELETE", `conversations/${CONVERSATION_ID}`, { token: GOOD_TOKEN }),
    makeDeps(),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
});

// ── Fallthroughs ─────────────────────────────────────────────────────────

Deno.test("conversations: unknown route returns 404", async () => {
  const res = await conversationsHandler(
    buildReq("GET", "conversations/nonsense/path/extra", { token: GOOD_TOKEN }),
    makeDeps(),
  );
  assertEquals(res.status, 404);
});

Deno.test("conversations: DAO throw returns 500", async () => {
  const deps = makeDeps({
    listConversationsByVisitor: () => Promise.reject(new Error("db down")),
  });
  const res = await conversationsHandler(
    buildReq("GET", "conversations", {
      token: GOOD_TOKEN,
      query: { visitor_id: VISITOR_ID, project_id: PROJECT_ID },
    }),
    deps,
  );
  assertEquals(res.status, 500);
});

// ── Audit trail (SECURITY_AUDIT_TODO item 8) ────────────────────────────
// These pin the SOC2 CC7.3 requirement: every destructive action must
// leave a durable record with actor, target, source IP, and enough
// metadata for an incident responder to reason about what happened.

Deno.test("conversations POST reset: emits audit event on success", async () => {
  // deno-lint-ignore no-explicit-any
  let audit: any = null;
  const deps = makeDeps({
    resetConversation: () => Promise.resolve("conv-reset-42"),
    // deno-lint-ignore no-explicit-any
    recordAuditEvent: (_sb: unknown, event: any) => {
      audit = event;
      return Promise.resolve(true);
    },
  });

  // Build a request with cf-connecting-ip + user-agent so the audit
  // row captures them. The standard buildReq helper doesn't set these,
  // so build directly.
  const r = new Request("https://widget.divee.ai/conversations/reset", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-visitor-token": GOOD_TOKEN,
      "cf-connecting-ip": "203.0.113.42",
      "user-agent": "test-ua/1.0",
      "content-length": String(
        new TextEncoder().encode(
          JSON.stringify({
            visitor_id: VISITOR_ID,
            article_unique_id: ARTICLE_UNIQUE_ID,
            project_id: PROJECT_ID,
          }),
        ).byteLength,
      ),
    },
    body: JSON.stringify({
      visitor_id: VISITOR_ID,
      article_unique_id: ARTICLE_UNIQUE_ID,
      project_id: PROJECT_ID,
    }),
  });

  const res = await conversationsHandler(r, deps);
  assertEquals(res.status, 200);
  assertEquals(audit.action, "conversation.reset");
  assertEquals(audit.visitorId, VISITOR_ID);
  assertEquals(audit.projectId, PROJECT_ID);
  assertEquals(audit.target, "conv-reset-42");
  assertEquals(audit.sourceIp, "203.0.113.42");
  assertEquals(audit.userAgent, "test-ua/1.0");
  assertEquals(audit.metadata?.article_unique_id, ARTICLE_UNIQUE_ID);
});

Deno.test("conversations POST reset: audit write failure does NOT fail the request", async () => {
  // Audit is best-effort. A DB hiccup on audit_log must not surface as
  // a 500 after we already reset the conversation — that would leave
  // the client retrying a destructive action.
  const deps = makeDeps({
    resetConversation: () => Promise.resolve("conv-reset-99"),
    recordAuditEvent: () => Promise.resolve(false), // audit DB rejected
  });
  const res = await conversationsHandler(
    buildReq("POST", "conversations/reset", {
      token: GOOD_TOKEN,
      body: {
        visitor_id: VISITOR_ID,
        article_unique_id: ARTICLE_UNIQUE_ID,
        project_id: PROJECT_ID,
      },
    }),
    deps,
  );
  assertEquals(res.status, 200);
});

Deno.test("conversations DELETE: emits audit event with pre-delete metadata", async () => {
  // deno-lint-ignore no-explicit-any
  let audit: any = null;
  const preDelete = fakeConversation({
    message_count: 17, // arbitrary pre-state we can assert on
  });
  const deps = makeDeps({
    getConversationById: () => Promise.resolve(preDelete),
    deleteConversation: () => Promise.resolve(true),
    // deno-lint-ignore no-explicit-any
    recordAuditEvent: (_sb: unknown, event: any) => {
      audit = event;
      return Promise.resolve(true);
    },
  });

  const r = new Request(`https://widget.divee.ai/conversations/${CONVERSATION_ID}`, {
    method: "DELETE",
    headers: {
      "x-visitor-token": GOOD_TOKEN,
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "delete-ua/2.0",
    },
  });
  const res = await conversationsHandler(r, deps);
  assertEquals(res.status, 200);
  assertEquals(audit.action, "conversation.delete");
  assertEquals(audit.visitorId, VISITOR_ID);
  // projectId comes from the pre-fetched conversation, not the request
  assertEquals(audit.projectId, PROJECT_ID);
  assertEquals(audit.target, CONVERSATION_ID);
  assertEquals(audit.sourceIp, "203.0.113.7");
  assertEquals(audit.userAgent, "delete-ua/2.0");
  // Before-state captured for incident response
  assertEquals(audit.metadata?.message_count_before, 17);
});

Deno.test("conversations DELETE: audit runs AFTER the DAO call (not before)", async () => {
  // Regression guard: if someone reorders the handler to call
  // recordAuditEvent first, a failed deleteConversation would leave an
  // audit row saying "deleted" for a conversation that still exists.
  // We assert the sequence by tracking call order.
  const calls: string[] = [];
  const deps = makeDeps({
    deleteConversation: () => {
      calls.push("delete");
      return Promise.resolve(true);
    },
    recordAuditEvent: () => {
      calls.push("audit");
      return Promise.resolve(true);
    },
  });
  await conversationsHandler(
    buildReq("DELETE", `conversations/${CONVERSATION_ID}`, { token: GOOD_TOKEN }),
    deps,
  );
  assertEquals(calls, ["delete", "audit"]);
});

Deno.test("conversations DELETE: failed DAO means NO audit row", async () => {
  // The audit row represents a successful destructive action. If the
  // DAO returns false we return 500 and must NOT have written an audit
  // row.
  let auditCalled = false;
  const deps = makeDeps({
    deleteConversation: () => Promise.resolve(false),
    recordAuditEvent: () => {
      auditCalled = true;
      return Promise.resolve(true);
    },
  });
  const res = await conversationsHandler(
    buildReq("DELETE", `conversations/${CONVERSATION_ID}`, { token: GOOD_TOKEN }),
    deps,
  );
  assertEquals(res.status, 500);
  assertEquals(auditCalled, false);
});

// ── Teardown ──────────────────────────────────────────────────────────────
Deno.test("conversations: teardown (restore env)", () => {
  restoreEnv();
});
