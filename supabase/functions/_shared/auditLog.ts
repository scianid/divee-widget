/**
 * Audit log writes for security-relevant actions.
 *
 * SECURITY_AUDIT_TODO item 8 / SOC2 CC7.3: edge functions that mutate
 * or delete user data must leave a durable trail so an incident
 * responder can answer "was this deleted by the owner or by an
 * attacker?" The companion table is defined in
 * supabase/migrations/20260415_audit_log.sql.
 *
 * Usage: call `recordAuditEvent(supabase, {...})` AFTER the destructive
 * DAO call has returned success. Failures are logged and swallowed —
 * audit is a compliance control, not a blocking dependency. If the
 * audit write fails, the user's DELETE still succeeds and the handler
 * returns 200, but the failure is surfaced in logs for ops to catch.
 */

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

/**
 * Stable, small set of action strings. Anything new should be added
 * here with a comment explaining what the row type means — drift-free
 * action names are what make the `action` column useful for filtering.
 */
export type AuditAction =
  // Soft/hard-delete of a single conversation row (DELETE /conversations/:id).
  | "conversation.delete"
  // Full reset of messages on a conversation (POST /conversations/reset).
  // Target is the conversation id returned by resetConversation.
  | "conversation.reset";

export interface AuditEvent {
  visitorId: string | null;
  projectId: string;
  action: AuditAction;
  target: string | null;
  sourceIp: string | null;
  userAgent: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Insert one row into `audit_log`. Never throws. Returns `true` on
 * successful insert, `false` if the DB rejected it — callers can log
 * the boolean but must not gate user-visible behavior on it.
 */
export async function recordAuditEvent(
  supabase: SupabaseClient,
  event: AuditEvent,
): Promise<boolean> {
  try {
    const { error } = await supabase.from("audit_log").insert({
      visitor_id: event.visitorId,
      project_id: event.projectId,
      action: event.action,
      target: event.target,
      source_ip: event.sourceIp,
      user_agent: event.userAgent,
      metadata: event.metadata ?? {},
    });
    if (error) {
      console.error("auditLog: insert failed", {
        action: event.action,
        projectId: event.projectId,
        error: error.message ?? error,
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error("auditLog: unexpected error", {
      action: event.action,
      projectId: event.projectId,
      err,
    });
    return false;
  }
}

/**
 * Extract audit-relevant metadata from an inbound Request. Pulls
 * `cf-connecting-ip` (the authoritative client IP on Cloudflare) and
 * `user-agent`. Both can be null in non-edge contexts.
 */
export function extractAuditContext(
  req: Request,
): { sourceIp: string | null; userAgent: string | null } {
  return {
    sourceIp: req.headers.get("cf-connecting-ip"),
    userAgent: req.headers.get("user-agent"),
  };
}
