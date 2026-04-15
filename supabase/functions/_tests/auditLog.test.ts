/**
 * Tests for supabase/functions/_shared/auditLog.ts.
 *
 * SECURITY_AUDIT_TODO item 8 / SOC2 CC7.3. The helper is intentionally
 * unable to throw — callers invoke it after a destructive DAO has
 * already succeeded, and a crash here must not cause a retry loop or
 * return 500 to the user. These tests pin that contract:
 *
 *   - Happy path: insert row and return true.
 *   - Supabase returns `{error}` → logs and returns false.
 *   - Supabase throws synchronously or rejects → logs and returns false.
 *   - `extractAuditContext` reads cf-connecting-ip and user-agent,
 *     returns nulls when they're absent.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { extractAuditContext, recordAuditEvent } from "../_shared/auditLog.ts";

/**
 * Build a minimal Supabase client stub shaped like `from(t).insert(row)`.
 * The chain must be terminated by the insert call — that's where the
 * test asserts on the row payload.
 */
// deno-lint-ignore no-explicit-any
function makeSupabase(onInsert: (row: any) => { error: unknown } | Promise<{ error: unknown }>) {
  return {
    from: (_table: string) => ({
      // deno-lint-ignore no-explicit-any
      insert: (row: any) => Promise.resolve(onInsert(row)),
    }),
  };
}

// Suppress console noise from the helper's defensive logging.
function withSilentConsole<T>(fn: () => Promise<T>): Promise<T> {
  const origErr = console.error;
  console.error = () => {};
  return fn().finally(() => {
    console.error = origErr;
  });
}

Deno.test("recordAuditEvent: happy path inserts row and returns true", async () => {
  // deno-lint-ignore no-explicit-any
  let captured: any = null;
  const sb = makeSupabase((row) => {
    captured = row;
    return { error: null };
  });
  const ok = await recordAuditEvent(sb, {
    visitorId: "v1",
    projectId: "p1",
    action: "conversation.delete",
    target: "conv-abc",
    sourceIp: "203.0.113.1",
    userAgent: "ua/1.0",
    metadata: { x: 1 },
  });
  assertEquals(ok, true);
  assertEquals(captured.visitor_id, "v1");
  assertEquals(captured.project_id, "p1");
  assertEquals(captured.action, "conversation.delete");
  assertEquals(captured.target, "conv-abc");
  assertEquals(captured.source_ip, "203.0.113.1");
  assertEquals(captured.user_agent, "ua/1.0");
  assertEquals(captured.metadata, { x: 1 });
});

Deno.test("recordAuditEvent: metadata defaults to empty object when omitted", async () => {
  // deno-lint-ignore no-explicit-any
  let captured: any = null;
  const sb = makeSupabase((row) => {
    captured = row;
    return { error: null };
  });
  await recordAuditEvent(sb, {
    visitorId: null,
    projectId: "p1",
    action: "conversation.reset",
    target: null,
    sourceIp: null,
    userAgent: null,
  });
  assertEquals(captured.metadata, {});
});

Deno.test("recordAuditEvent: supabase {error} return → logs and returns false", async () => {
  const sb = makeSupabase(() => ({ error: { message: "permission denied" } }));
  const ok = await withSilentConsole(() =>
    recordAuditEvent(sb, {
      visitorId: "v1",
      projectId: "p1",
      action: "conversation.delete",
      target: "conv-abc",
      sourceIp: null,
      userAgent: null,
    })
  );
  assertEquals(ok, false);
});

Deno.test("recordAuditEvent: supabase throws → logs and returns false (never propagates)", async () => {
  // The whole point of the swallow-and-return-false contract is that a
  // DB outage at audit time cannot surface as a user-visible error.
  const sb = {
    from: () => {
      throw new Error("connection lost");
    },
  };
  const ok = await withSilentConsole(() =>
    recordAuditEvent(sb, {
      visitorId: "v1",
      projectId: "p1",
      action: "conversation.reset",
      target: "conv-xyz",
      sourceIp: null,
      userAgent: null,
    })
  );
  assertEquals(ok, false);
});

Deno.test("extractAuditContext: reads cf-connecting-ip and user-agent headers", () => {
  const r = new Request("https://widget.divee.ai/x", {
    headers: {
      "cf-connecting-ip": "198.51.100.7",
      "user-agent": "Mozilla/5.0 test",
    },
  });
  assertEquals(extractAuditContext(r), {
    sourceIp: "198.51.100.7",
    userAgent: "Mozilla/5.0 test",
  });
});

Deno.test("extractAuditContext: returns nulls when headers are absent", () => {
  const r = new Request("https://widget.divee.ai/x");
  assertEquals(extractAuditContext(r), { sourceIp: null, userAgent: null });
});
