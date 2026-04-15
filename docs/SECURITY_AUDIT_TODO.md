# Edge Functions — Security Audit Action Items

Findings from the 2026-04-15 review of `supabase/functions/`. Companion
docs: [SECURITY_REVIEW.md](SECURITY_REVIEW.md),
[SECURITY_REVIEW_2.md](SECURITY_REVIEW_2.md),
[RATE_LIMITING.md](RATE_LIMITING.md).

Items are grouped by severity. Each item has: what, why, where, how to
verify. SOC2 mapping column lines up with Trust Services Criteria for the
auditor's benefit.

## Legend

- **Severity**: 🔴 High — exploitable today · 🟠 Medium — hardening ·
  🟡 Low — audit polish.
- **SOC2**: Applicable Trust Services Criterion (CC = Common Criteria,
  A1 = Availability).
- **Status**: `[ ]` open · `[x]` done · `[-]` won't fix (with reason).

---

## 🔴 High

### [x] 1. Close the `/suggested-articles` auth hole

- **What**: `suggested-articles` is on the `PUBLIC_ALLOWLIST` in
  `scripts/check-edge-auth.ts` with the note "KNOWN GAP — no auth/origin
  gate. Tracked for follow-up; do not add new callers." It's openly
  callable with any `projectId`, which ships public in every widget
  snippet.
- **Why**: An attacker who scrapes a single widget-enabled page learns
  a valid `projectId` and can then enumerate every article in that
  project's corpus. Content exfiltration at scale.
- **Where**: `supabase/functions/suggested-articles/index.ts`,
  `scripts/check-edge-auth.ts` (`PUBLIC_ALLOWLIST`).
- **How**: Add the same `getProjectForArticlesAuth` + `isAllowedOrigin`
  check we added to `articles/`. The DI seam is already in place —
  inject a `getProjectForArticlesAuth` dep and reuse the articleDao
  helper. Then remove `suggested-articles` from `PUBLIC_ALLOWLIST`.
- **Verify**: The existing `auth-bypass guard` CI step must pass without
  the allowlist entry. Add a test that a request with a mismatched
  `Origin` returns 403.
- **SOC2**: CC6.1
- **Effort**: ~30 min. The refactor is mechanical.

### [x] 2. Rate-limit `/config`, `/analytics`, `/articles`

- **What**: `_shared/rateLimit.ts` only gates `chat` (20/visitor,
  500/project) and `suggestions` (5/200). The other public endpoints
  have no limits at all.
- **Why**:
  - `/config` — a scraper can enumerate every projectId at arbitrary
    rate, harvesting `allowed_urls`, ad tags, and other config.
  - `/analytics` — an attacker can flood the upstream proxy and burn
    the secondary project's budget; metrics can be poisoned.
  - `/articles` — same corpus-exfil concern as `/suggested-articles`
    above, just with an origin gate as a weak backstop.
- **Where**: `_shared/rateLimit.ts` (`LIMITS` map), plus call sites in
  each handler.
- **How**: Add `config`, `analytics`, `articles` keys to the `LIMITS`
  map. Suggested budgets: 30/min per visitor, 300/min per project for
  config/articles; 60/min per visitor, 1000/min per project for
  analytics (higher because it's the hot path). Call `checkRateLimit`
  right after the origin check in each handler, before the DB work.
- **Verify**: Unit test the 429 path using the DI seam (the rate-limit
  fn is already injectable in chat and suggestions — extend the other
  deps interfaces).
- **SOC2**: CC6.1, A1.2
- **Effort**: ~2 hours.

### [ ] 3. Size-cap every handler that reads a request body

- **What**: `analytics/index.ts` does `await req.text()` and then
  forwards the result. `chat/index.ts` and `suggestions/index.ts` do
  `await req.json()` and then truncate *after* parsing. Both patterns
  load an arbitrarily large body into memory before checking.
- **Why**: DoS. A 50 MB POST gets parsed before the truncate step ever
  runs. Memory pressure + slow-loris style abuse.
- **Where**: All handlers that accept a body —
  `chat`, `suggestions`, `analytics`, `suggested-articles`,
  `conversations` (POST reset).
- **How**: Helper `enforceContentLength(req, maxBytes)` in
  `_shared/responses.ts` that (a) reads `content-length`, (b) returns a
  413 response if missing or over the cap. Call it at the top of every
  POST-accepting handler. Caps:
  - `chat`, `suggestions`: 64 KB (sanitizeContent already truncates to
    20 KB content + 1 KB title — 64 KB gives overhead).
  - `analytics`: 32 KB (events should be tiny).
  - `conversations/reset`: 4 KB (three IDs only).
- **Verify**: Test a request with `content-length: 999999` returns 413
  without the DAO stubs being called.
- **SOC2**: CC7.1, A1.2
- **Effort**: ~1 hour.

### [ ] 4. Stop logging `visitor_id` in plaintext

- **What**: `chat/index.ts` logs `visitor_id` at several points (rate
  limit, token usage, cache writes).
- **Why**: SOC2 CC7.2 treats persistent identifiers as sensitive if
  they can be linked to individuals via other data. Cloud log retention
  is typically 30+ days — that's a lot of PII if a breach happens.
  Conversations/chat logs also need a look.
- **Where**: `chat/index.ts`, `conversations/index.ts`.
- **How**: Either (a) hash with a stable per-project salt before
  logging (`sha256(visitor_id + projectSalt).slice(0, 12)`), or (b)
  drop these logs to debug-only behind a `DEBUG_LOG_VISITOR_ID` env
  flag. Option (a) is better — it keeps logs useful for correlation
  while breaking the link to the visitor cookie.
- **Verify**: `grep -r "visitor_id" supabase/functions --include='*.ts'`
  in a log-pattern context should show zero plaintext hits.
- **SOC2**: CC7.2
- **Effort**: ~1 hour (helper + call-site sweep).

---

## 🟠 Medium

### [ ] 5. Document the RAG trust boundary

- **What**: `chat/index.ts` concatenates RAG chunks from
  `searchSimilarChunks` into the prompt with no post-retrieval
  sanitization. Sanitization runs only at *ingest*
  (`sanitizeContent` in constants.ts).
- **Why**: Confused-deputy risk. If a customer can upload arbitrary
  RAG documents, one tenant's stored payload can alter another
  visitor's AI output. Today the mitigation is "RAG uploads are
  admin-only." That assumption needs to be written down.
- **Where**: `docs/SECURITY_REVIEW.md` (extend) or a new
  `docs/RAG_TRUST_BOUNDARY.md`.
- **How**: One-page doc answering: who can write to `rag_documents`,
  what reviews are required, what happens if the ingest path is
  compromised, what the blast radius is.
- **SOC2**: CC6.1, CC8.1
- **Effort**: ~30 min.

### [ ] 6. Fill the `sanitizeContent` gaps

- **What**: The current sanitizer strips HTML tags, comments, and
  entities. It does NOT handle: zero-width/BiDi Unicode (U+200B,
  U+202E, variation selectors), NFKC normalization, or `<svg>` event
  handlers as a distinct class.
- **Why**: Low exploitability today, but a diligent auditor will ask.
  Zero-width injection can be used to smuggle instructions past human
  review of stored prompts.
- **Where**: `_shared/constants.ts` → `sanitizeContent`.
- **How**:
  - `text = text.normalize("NFKC")` at the top.
  - Strip Unicode categories Cf (format) and Cc (control) except for
    `\t\n\r`: `.replace(/[\p{Cf}\p{Cc}]/gu, "")` — but allow tabs and
    newlines back.
  - Add a specific `<svg>` strip before the generic tag strip (some
    SVG attributes can survive other encoding).
- **Verify**: Property test with fuzzed inputs including zero-width
  sequences and mixed-direction text.
- **SOC2**: CC6.7
- **Effort**: ~1 hour.

### [ ] 7. Rotate or replace `CONFIG_BYPASS_KEY`

- **What**: `config/index.ts` accepts a static `?bypass_key=...` that
  bypasses origin validation. Shared secret, env-configured, no TTL,
  no rotation mechanism, no usage audit.
- **Why**: SOC2 CC6.1 dislikes long-lived credentials without rotation
  or audit trail. If it ever leaks (screenshots, internal tickets, a
  curl dump) there's no way to know who used it or when.
- **Where**: `config/index.ts` lines 56–74.
- **How**: Two options:
  1. **Rotate + audit**: Add a rotation reminder, write a row to an
     `audit_log` table on every successful bypass with actor,
     timestamp, and source IP. Schedule quarterly rotation.
  2. **Replace**: Switch to a short-lived HMAC-signed token the same
     way visitor tokens work. Admin tooling mints a 15-minute token
     when it needs to debug a config.
- **SOC2**: CC6.1, CC7.3
- **Effort**: ~2 hours for (1), ~4 hours for (2).

### [ ] 8. Add an `audit_log` table for destructive actions

- **What**: `DELETE /conversations/:id` and `POST /conversations/reset`
  have no durable record of who did what. Chat token usage is tracked
  but not security-relevant actions.
- **Why**: SOC2 CC7.3 wants an audit trail for security events. An
  incident responder needs to answer "was this conversation deleted
  by the owner or by an attacker?"
- **Where**: New migration + writes in `conversations/index.ts`.
- **How**:
  - Migration: `audit_log (id, project_id, visitor_id, action, target,
    source_ip, user_agent, created_at)`.
  - Helper `recordAuditEvent()` in `_shared/`.
  - Call it from DELETE and reset handlers *after* the DAO mutation
    succeeds.
- **SOC2**: CC7.3
- **Effort**: ~2 hours.

### [ ] 9. Enable RLS on sensitive tables even though service-role
  bypasses it

- **What**: All edge functions use `SUPABASE_SERVICE_ROLE_KEY` which
  bypasses RLS. RLS is therefore dead code as a defense — every access
  control decision is in the edge-function layer.
- **Why**: Belt-and-braces. If a future code path accidentally uses
  the anon key, or if service-role is ever scoped down, RLS becomes
  the fallback. SOC2 auditors specifically ask about RLS.
- **Where**: `supabase/migrations/` (new migration).
- **How**: `ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;`
  and similar for `ai_rate_limits`, `rag_documents`, `article_tag`,
  `audit_log`. Add one policy per table that denies anon access
  (`USING (false)`), so service-role still works but anon fails
  closed.
- **Verify**: An integration test using the anon key must fail; the
  same test with service-role must pass.
- **SOC2**: CC6.1
- **Effort**: ~2 hours.

### [ ] 10. Narrow the gitleaks test-fixture allowlist

- **What**: `.gitleaks.toml` at the repo root allowlists
  `supabase/functions/_tests/fixtures/`. Today we don't have a
  `fixtures/` subdirectory, but tests embed stub tokens like
  `"super-secret-bypass"` and `"opaque-good-token"` in the test files
  themselves.
- **Why**: Two problems:
  1. The allowlist path doesn't cover where our tests actually live
     (we put stubs in `_tests/*.test.ts`, not
     `_tests/fixtures/`). If gitleaks ever flags a stub, the allowlist
     won't help.
  2. If someone *does* create a `fixtures/` subdir later and drops a
     real secret there by mistake, the scanner will miss it.
- **Where**: `.gitleaks.toml` at widget repo root.
- **How**: Replace the directory allowlist with a regex match on
  specific stub strings used in tests
  (`super-secret-bypass`, `opaque-good-token`, etc.). Narrower surface.
- **SOC2**: CC8.1
- **Effort**: ~30 min.

---

## 🟡 Low / polish

### [ ] 11. Flip CodeQL from `continue-on-error: true` to `false`

- **Where**: `.github/workflows/edge-functions-ci.yml` line 110.
  Comment says "flip to false once we've cleaned up findings."
- **How**: Triage the current CodeQL findings. Fix or suppress with
  justification. Flip the flag. Add a task to `SECURITY_REVIEW.md`
  noting the target date.
- **SOC2**: CC8.1
- **Effort**: Depends on findings.

### [ ] 12. Document the `verify_jwt = false` design decision

- **Where**: `docs/SECURITY_REVIEW.md`.
- **How**: One paragraph: "JWT verification is disabled on every edge
  function because the widget is unauthenticated by design. Access
  control is enforced by (a) origin allowlist via `isAllowedOrigin`,
  (b) visitor HMAC token via `verifyVisitorToken` for
  conversation-scoped routes, (c) rate limiting via `checkRateLimit`.
  `scripts/check-edge-auth.ts` statically verifies every function
  enforces at least one of these and fails CI otherwise."
- **Why**: SOC2 auditors reflexively ask why JWT is off. Pre-empt the
  question.
- **SOC2**: CC6.1, CC8.1
- **Effort**: 15 min.

### [ ] 13. Add a smoke test for `scripts/check-edge-auth.ts`

- **Where**: `scripts/check-edge-auth.ts` or a new test beside it.
- **How**: Add a test case that creates a dummy edge function without
  any of the required imports and asserts the script exits non-zero.
  The guard itself is untested today.
- **SOC2**: CC8.1
- **Effort**: ~30 min.

---

## SOC2 mapping summary

| Criterion | Open items |
| --- | --- |
| CC6.1 (logical access) | 1, 2, 5, 7, 9, 12 |
| CC6.7 (transmission integrity) | 6 |
| CC7.1 (system operations / capacity) | 3 |
| CC7.2 (monitoring / PII in logs) | 4 |
| CC7.3 (security incident response) | 7, 8 |
| CC8.1 (change management) | 5, 10, 11, 12, 13 |
| A1.2 (availability) | 2, 3 |

## Recommended order

1. Item 1 (unguarded `suggested-articles`)
2. Item 2 (rate-limit the other public endpoints)
3. Item 3 (size caps on request bodies)
4. Item 4 (stop logging `visitor_id`)
5. Item 8 (audit log for destructive actions)
6. Item 7 (rotate or replace `CONFIG_BYPASS_KEY`)
7. Item 9 (RLS as belt-and-braces)

Items 1–4 are exploitable today and should land before the next audit
window. Items 5–9 are SOC2 prep. Items 10–13 are hygiene.
