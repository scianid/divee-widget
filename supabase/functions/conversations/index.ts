import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { supabaseClient } from "../_shared/supabaseClient.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { enforceContentLength, errorResp, successResp } from "../_shared/responses.ts";
import { extractAuditContext, recordAuditEvent } from "../_shared/auditLog.ts";
import {
  deleteConversation,
  getConversationById,
  listConversationsByVisitor,
  resetConversation,
} from "../_shared/dao/conversationDao.ts";
import { verifyVisitorToken } from "../_shared/visitorAuth.ts";

// ─── Dependency injection seam ────────────────────────────────────────────
// `conversationsHandler` accepts a `ConversationsDeps` object so unit tests
// can stub the Supabase DAOs and visitor-token verifier without touching
// the network or needing a real HMAC secret. Production wires the real
// implementations via `realConversationsDeps`. Same pattern as chat/config.
export interface ConversationsDeps {
  supabaseClient: typeof supabaseClient;
  verifyVisitorToken: typeof verifyVisitorToken;
  listConversationsByVisitor: typeof listConversationsByVisitor;
  getConversationById: typeof getConversationById;
  resetConversation: typeof resetConversation;
  deleteConversation: typeof deleteConversation;
  recordAuditEvent: typeof recordAuditEvent;
}

export const realConversationsDeps: ConversationsDeps = {
  supabaseClient,
  verifyVisitorToken,
  listConversationsByVisitor,
  getConversationById,
  resetConversation,
  deleteConversation,
  recordAuditEvent,
};

export async function conversationsHandler(
  req: Request,
  deps: ConversationsDeps = realConversationsDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);

  // --- C-2 fix: require a valid visitor ownership token on every request ---
  // The token is obtained from the X-Visitor-Token header returned by /chat.
  // Clients may also pass it as the `visitor_token` query parameter.
  const rawToken = req.headers.get("x-visitor-token") ??
    url.searchParams.get("visitor_token");

  const tokenData = await deps.verifyVisitorToken(rawToken);
  if (!tokenData) {
    return errorResp("Unauthorized - missing or invalid visitor token", 401);
  }

  try {
    const supabase = await deps.supabaseClient();

    // GET /conversations - List conversations for a visitor
    if (req.method === "GET" && pathParts.length === 1) {
      const visitorId = url.searchParams.get("visitor_id");
      const projectId = url.searchParams.get("project_id");

      if (!visitorId || !projectId) {
        return errorResp("Missing visitor_id or project_id", 400);
      }

      // Ownership check: token must belong to the exact visitor + project requested
      if (
        tokenData.visitorId !== visitorId || tokenData.projectId !== projectId
      ) {
        return errorResp("Forbidden", 403);
      }

      const conversations = await deps.listConversationsByVisitor(
        supabase,
        visitorId,
        projectId,
      );

      // Return simplified list
      const simplified = conversations.map((conv: any) => ({
        id: conv.id,
        article_title: conv.article_title,
        article_url: conv.article_unique_id.split("-")[0], // Extract URL from unique_id
        last_message_at: conv.last_message_at,
        message_count: conv.message_count,
      }));

      return successResp({ conversations: simplified });
    }

    // GET /conversations/:id/messages - Get messages for a conversation
    if (
      req.method === "GET" && pathParts.length === 3 &&
      pathParts[2] === "messages"
    ) {
      const conversationId = pathParts[1];

      const conversation = await deps.getConversationById(supabase, conversationId);

      if (!conversation) {
        return errorResp("Conversation not found", 404);
      }

      // Ownership check: conversation must belong to the token's visitor
      if (conversation.visitor_id !== tokenData.visitorId) {
        return errorResp("Forbidden", 403);
      }

      return successResp({ messages: conversation.messages || [] });
    }

    // POST /conversations/reset - Reset conversation (clear messages)
    if (
      req.method === "POST" && pathParts.length === 2 &&
      pathParts[1] === "reset"
    ) {
      // SECURITY_AUDIT_TODO item 3: cap body size BEFORE parsing. Reset
      // payload is three IDs — 4KB is plenty. Applied only in this branch
      // because the other conversations routes don't read a body.
      const oversize = enforceContentLength(req, 4096);
      if (oversize) return oversize;

      const { visitor_id, article_unique_id, project_id } = await req.json();

      if (!visitor_id || !article_unique_id || !project_id) {
        return errorResp("Missing required fields", 400);
      }

      // Ownership check: token must match body's visitor + project
      if (
        tokenData.visitorId !== visitor_id || tokenData.projectId !== project_id
      ) {
        return errorResp("Forbidden", 403);
      }

      const conversationId = await deps.resetConversation(
        supabase,
        visitor_id,
        article_unique_id,
        project_id,
      );

      if (!conversationId) {
        return errorResp("Failed to reset conversation", 500);
      }

      // SECURITY_AUDIT_TODO item 8: audit AFTER the DAO mutation has
      // succeeded. A failure here must not surface as a user-visible
      // error — compliance logging is best-effort, not a blocking gate.
      const auditCtx = extractAuditContext(req);
      await deps.recordAuditEvent(supabase, {
        visitorId: visitor_id,
        projectId: project_id,
        action: "conversation.reset",
        target: conversationId,
        sourceIp: auditCtx.sourceIp,
        userAgent: auditCtx.userAgent,
        metadata: { article_unique_id },
      });

      return successResp({ conversation_id: conversationId });
    }

    // DELETE /conversations/:id - Delete conversation
    if (req.method === "DELETE" && pathParts.length === 2) {
      const conversationId = pathParts[1];

      // Fetch first to verify ownership before destructive action
      const conversation = await deps.getConversationById(supabase, conversationId);
      if (!conversation) {
        return errorResp("Conversation not found", 404);
      }

      // Ownership check: conversation must belong to the token's visitor
      if (conversation.visitor_id !== tokenData.visitorId) {
        return errorResp("Forbidden", 403);
      }

      const success = await deps.deleteConversation(supabase, conversationId);

      if (!success) {
        return errorResp("Failed to delete conversation", 500);
      }

      // SECURITY_AUDIT_TODO item 8: audit AFTER the DAO mutation has
      // succeeded. We record the pre-fetched conversation's project_id
      // (not from query params — the conversation is the authoritative
      // source) and enough metadata to reconstruct the before-state.
      const auditCtx = extractAuditContext(req);
      await deps.recordAuditEvent(supabase, {
        visitorId: tokenData.visitorId,
        projectId: conversation.project_id,
        action: "conversation.delete",
        target: conversationId,
        sourceIp: auditCtx.sourceIp,
        userAgent: auditCtx.userAgent,
        metadata: {
          article_unique_id: conversation.article_unique_id,
          message_count_before: conversation.message_count,
        },
      });

      return successResp({ success: true });
    }

    return errorResp("Not found", 404);
  } catch (error) {
    console.error("conversations: unhandled error", error);
    return errorResp("Internal server error", 500);
  }
}

// @ts-ignore: Deno globals and JSR imports are unavailable to the editor TS server
Deno.serve((req: Request) => conversationsHandler(req));
