-- Audit log for security-relevant actions on conversations (and future
-- destructive routes). SECURITY_AUDIT_TODO item 8 / SOC2 CC7.3.
--
-- Writes are append-only: the edge functions insert a row AFTER a
-- destructive DAO call succeeds. Reads are not gated here — ops and
-- compliance queries run with service-role, same as every other edge
-- function call.
--
-- Keep columns flat and normalized-ish so jsonb filters stay fast. The
-- `metadata` column is an escape hatch for action-specific context that
-- doesn't deserve its own column (e.g. which conversation was reset,
-- what the prior message count was).

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Actor identity. `visitor_id` is the raw id from the verified
    -- visitor token — it is the ONLY identity edge functions have for
    -- widget callers, so audit by visitor is the audit that's possible.
    -- For admin-initiated actions in the future, store the admin id in
    -- metadata and leave visitor_id null.
    visitor_id TEXT,
    project_id TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,
    -- Action is a stable string taken from a small enum maintained in
    -- _shared/auditLog.ts. Not a Postgres enum type because the edge
    -- functions need to add new actions without a migration round-trip.
    action TEXT NOT NULL,
    -- Target is the primary key of the row that was acted on (e.g. the
    -- conversation id). Kept as TEXT so it can hold UUIDs or composite
    -- article unique ids without schema churn.
    target TEXT,
    -- cf-connecting-ip, captured verbatim from the inbound request. Null
    -- if Cloudflare didn't populate it (direct calls, local testing).
    source_ip TEXT,
    user_agent TEXT,
    metadata JSONB DEFAULT '{}' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Index on (project_id, created_at DESC) — the usual incident-response
-- query is "show me everything for project X in the last N hours."
CREATE INDEX IF NOT EXISTS audit_log_project_created_idx
    ON audit_log (project_id, created_at DESC);

-- Index on (visitor_id, created_at DESC) for per-visitor timelines.
-- Sparse index: skip rows without a visitor_id to keep it small.
CREATE INDEX IF NOT EXISTS audit_log_visitor_created_idx
    ON audit_log (visitor_id, created_at DESC)
    WHERE visitor_id IS NOT NULL;

-- Index on action for "how many of X happened recently."
CREATE INDEX IF NOT EXISTS audit_log_action_created_idx
    ON audit_log (action, created_at DESC);

-- RLS on. Service-role bypasses; nothing else should touch it.
-- (See SECURITY_AUDIT_TODO item 9 for the broader RLS hardening work.)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
