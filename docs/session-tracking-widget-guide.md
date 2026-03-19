# Session Tracking — Widget Implementation Guide

This document describes how to implement session tracking in the Divee React widget.
It covers the API contract, the mapping from widget events to session fields, and a
reference implementation of the `useSessionTracker` hook.

---

## API Contract

**Endpoint:** `POST https://cdn.divee.ai/functions/v1/analytics`

**Heartbeat body:**
```json
{
  "session": {
    "project_id":             "<project_id>",
    "session_id":             "<uuid>",
    "visitor_id":             "<uuid | null>",
    "active_seconds":         90,
    "elapsed_seconds":        150,
    "interaction_with_divee": true,
    "interaction_type":       "question_asked"
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `project_id` | string | ✅ | Same project ID used for all other events |
| `session_id` | string (UUID) | ✅ | Stable for the lifetime of the browser tab session |
| `visitor_id` | string (UUID) | — | Same visitor ID used for all other events |
| `active_seconds` | integer ≥ 0 | ✅ | Seconds the tab was **visible** (Page Visibility) |
| `elapsed_seconds` | integer ≥ 0 | ✅ | Seconds since the widget was first loaded on this tab |
| `interaction_with_divee` | boolean | ✅ | `true` if any interaction event has fired this session |
| `interaction_type` | `"divee_opened"` \| `"suggestions_received"` \| `"question_asked"` \| omitted | — | Deepest interaction tier reached this session |

**Rules enforced server-side:**
- `session_id` is the upsert key — the same session can be reported many times (heartbeats).
- `active_seconds` and `elapsed_seconds` are updated to the **max** of the stored and incoming values (safe against out-of-order delivery).
- `interaction_type` only ever **advances** toward `question_asked`; the server ignores attempts to regress it.
- `interaction_with_divee` is **OR'd** — once `true`, it stays `true`.

**Final flush (tab close/hide):** use `navigator.sendBeacon` so the request survives tab unload:
```ts
const body = JSON.stringify({ session: payload });
navigator.sendBeacon(ANALYTICS_URL, new Blob([body], { type: 'application/json' }));
```

---

## Interaction Type Mapping

Track the *deepest* interaction tier the user reached. The depth order is:

```
(none) → divee_opened → suggestions_received → question_asked
```

Map widget events to tiers as follows:

| Widget event fired | `interaction_type` to report |
|---|---|
| `widget_expanded`, `open_chat` | `"divee_opened"` |
| `suggestions_fetched`, `get_suggestions` | `"suggestions_received"` |
| `question_asked`, `ask_question`, `suggestion_question_asked`, `custom_question_asked` | `"question_asked"` |

Any of the above also sets `interaction_with_divee = true`.

Events **not** listed above (e.g. `widget_visible`, `ad_impression`) do not affect either field.

Track the deepest tier locally in the hook. Only the client's *current best* value needs to be sent — the server enforces non-regression on its end.

---

## Reference Implementation: `useSessionTracker`

Place this hook in your widget project. Call it once near the root of the widget component tree.

```tsx
// hooks/useSessionTracker.ts
import { useEffect, useRef, useCallback } from 'react';

const ANALYTICS_URL = 'https://cdn.divee.ai/functions/v1/analytics';
const HEARTBEAT_SCHEDULE_MS = [5_000, 10_000, 20_000]; // early beacons
const HEARTBEAT_INTERVAL_MS  = 30_000;                  // recurring after that

type InteractionType = 'divee_opened' | 'suggestions_received' | 'question_asked';

const INTERACTION_DEPTH: Record<InteractionType, number> = {
  divee_opened:        1,
  suggestions_received: 2,
  question_asked:       3,
};

// Map widget event types → interaction tier (undefined = not an interaction event)
const EVENT_TO_INTERACTION: Partial<Record<string, InteractionType>> = {
  widget_expanded:          'divee_opened',
  open_chat:                'divee_opened',
  suggestions_fetched:      'suggestions_received',
  get_suggestions:          'suggestions_received',
  question_asked:           'question_asked',
  ask_question:             'question_asked',
  suggestion_question_asked: 'question_asked',
  custom_question_asked:     'question_asked',
};

interface SessionTrackerOptions {
  projectId: string;
  sessionId: string;   // stable UUID for this tab session
  visitorId?: string;
}

export function useSessionTracker({ projectId, sessionId, visitorId }: SessionTrackerOptions) {
  const startedAt        = useRef<number>(Date.now());
  const activeStart      = useRef<number | null>(Date.now()); // null when tab is hidden
  const accumulatedActiveMs = useRef<number>(0);
  const hasInteracted    = useRef<boolean>(false);
  const interactionType  = useRef<InteractionType | undefined>(undefined);

  // ---------------------------------------------------------------------------
  // Compute current totals
  // ---------------------------------------------------------------------------
  const computeTotals = useCallback(() => {
    const now = Date.now();
    const activeMs =
      accumulatedActiveMs.current +
      (activeStart.current !== null ? now - activeStart.current : 0);
    return {
      active_seconds:  Math.round(activeMs / 1000),
      elapsed_seconds: Math.round((now - startedAt.current) / 1000),
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Build the payload to POST
  // ---------------------------------------------------------------------------
  const buildPayload = useCallback(() => {
    const { active_seconds, elapsed_seconds } = computeTotals();
    return {
      project_id:             projectId,
      session_id:             sessionId,
      visitor_id:             visitorId,
      active_seconds,
      elapsed_seconds,
      interaction_with_divee: hasInteracted.current,
      interaction_type:       interactionType.current,
    };
  }, [projectId, sessionId, visitorId, computeTotals]);

  // ---------------------------------------------------------------------------
  // Send via fetch (heartbeats while tab is open)
  // ---------------------------------------------------------------------------
  const sendHeartbeat = useCallback(() => {
    const payload = buildPayload();
    fetch(ANALYTICS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: payload }),
      // keepalive allows the request to outlive the page in some browsers
      keepalive: true,
    }).catch(() => {/* silently ignore — best-effort telemetry */});
  }, [buildPayload]);

  // ---------------------------------------------------------------------------
  // Send via sendBeacon (tab hide / before unload — guaranteed delivery)
  // ---------------------------------------------------------------------------
  const sendBeacon = useCallback(() => {
    const payload = buildPayload();
    const blob = new Blob([JSON.stringify({ session: payload })], {
      type: 'application/json',
    });
    navigator.sendBeacon(ANALYTICS_URL, blob);
  }, [buildPayload]);

  // ---------------------------------------------------------------------------
  // Public: call this whenever the widget fires an analytics event
  // ---------------------------------------------------------------------------
  const recordEvent = useCallback((eventType: string) => {
    const tier = EVENT_TO_INTERACTION[eventType];
    if (!tier) return;

    hasInteracted.current = true;

    // Only advance, never regress
    if (
      interactionType.current === undefined ||
      INTERACTION_DEPTH[tier] > INTERACTION_DEPTH[interactionType.current]
    ) {
      interactionType.current = tier;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Staggered early heartbeats: 5 s → 10 s → 20 s, then every 30 s
    let recurringInterval: ReturnType<typeof setInterval> | undefined;
    let t3: ReturnType<typeof setTimeout> | undefined;
    let t2: ReturnType<typeof setTimeout> | undefined;

    const t1 = setTimeout(() => {
      sendHeartbeat();
      t2 = setTimeout(() => {
        sendHeartbeat();
        t3 = setTimeout(() => {
          sendHeartbeat();
          recurringInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
        }, HEARTBEAT_SCHEDULE_MS[2] - HEARTBEAT_SCHEDULE_MS[1]); // 10 s
      }, HEARTBEAT_SCHEDULE_MS[1] - HEARTBEAT_SCHEDULE_MS[0]);   //  5 s
    }, HEARTBEAT_SCHEDULE_MS[0]);                                 //  5 s

    // Tab visibility changes
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Accumulate active time and flush
        if (activeStart.current !== null) {
          accumulatedActiveMs.current += Date.now() - activeStart.current;
          activeStart.current = null;
        }
        sendBeacon();
      } else {
        // Tab became visible again — resume active timer
        activeStart.current = Date.now();
      }
    };

    // Best-effort flush before unload (sendBeacon is the reliable path)
    const handleBeforeUnload = () => {
      if (activeStart.current !== null) {
        accumulatedActiveMs.current += Date.now() - activeStart.current;
        activeStart.current = null;
      }
      sendBeacon();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      clearTimeout(t1);
      if (t2) clearTimeout(t2);
      if (t3) clearTimeout(t3);
      if (recurringInterval) clearInterval(recurringInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // Final POST on React unmount
      sendHeartbeat();
    };
  }, [sendHeartbeat, sendBeacon]);

  return { recordEvent };
}
```

### Usage

```tsx
// WidgetRoot.tsx
import { useSessionTracker } from './hooks/useSessionTracker';
import { useAnalytics } from './hooks/useAnalytics'; // your existing analytics hook

export function WidgetRoot({ projectId, sessionId, visitorId }) {
  const { recordEvent } = useSessionTracker({ projectId, sessionId, visitorId });

  // Wrap your existing event-firing function so it also updates the session tracker
  const trackEvent = (eventType: string, eventLabel?: string) => {
    recordEvent(eventType);              // update session state
    logAnalyticsEvent(eventType, eventLabel); // existing analytics call
  };

  return <Widget onEvent={trackEvent} />;
}
```

`sessionId` should be a UUID you generate (or retrieve from `sessionStorage`) when the widget first loads on a tab:

```ts
// utils/session.ts
export function getOrCreateSessionId(): string {
  const key = 'divee_session_id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}
```
`sessionStorage` is scoped per tab and is cleared when the tab is closed, so a new session ID is created for each tab.

---

## Verification Checklist

1. Open the widget in a browser tab. Wait 30 s. Confirm a `POST /analytics` request appears in DevTools Network with `body.session.elapsed_seconds ≈ 30`.
2. Expand the widget. Confirm the next heartbeat (or the immediate call from `recordEvent`) sets `interaction_type = "divee_opened"` and `interaction_with_divee = true`.
3. Ask a question. Confirm the next heartbeat sends `interaction_type = "question_asked"`.
4. Background the tab (switch to another tab). Confirm a `sendBeacon` request fires immediately with the current totals.
5. Restore the tab. Confirm heartbeats resume and `active_seconds` has stopped counting while the tab was hidden.
6. Check the `analytics_sessions` table in Supabase. Confirm a single row per `session_id` with `interaction_type` at the deepest level seen.
