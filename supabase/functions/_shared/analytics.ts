// @ts-ignore
import { createClient } from 'jsr:@supabase/supabase-js@2';

export interface AnalyticsContext {
    projectId: string;
    visitorId?: string;
    sessionId?: string;
    url?: string;
    referrer?: string;
    articleUrl?: string;
    ip?: string;
    geo?: {
        country?: string;
        city?: string;
        latitude?: number;
        longitude?: number;
    };
    platform?: 'mobile' | 'desktop' | 'unknown';
}

export async function logEvent(
    supabase: ReturnType<typeof createClient>,
    ctx: AnalyticsContext,
    eventType: string,
    eventLabel?: string
) {
    if (!ctx.projectId) return;

    try {
        // @ts-ignore
        const analyticsUrl = Deno.env.get('ANALYTICS_PROXY_URL');
        if (!analyticsUrl) {
            console.warn('Analytics: ANALYTICS_PROXY_URL not configured, skipping event');
            return;
        }

        await fetch(analyticsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: ctx.projectId,
                visitor_id: ctx.visitorId || null,
                session_id: ctx.sessionId || null,
                event_type: eventType,
                event_label: eventLabel || null,
                article_url: ctx.articleUrl || null,
                url: ctx.url || null,
            }),
        });
    } catch (err) {
        console.error('Analytics: Error logging event via secondary', err);
    }
}

export interface BatchEventRow {
    project_id: string;
    visitor_id?: string;
    session_id?: string;
    event_type: string;
    event_label?: string;
    article_url?: string;
    url?: string;
}

export async function logEventBatch(
    supabase: ReturnType<typeof createClient>,
    rows: BatchEventRow[]
) {
    if (rows.length === 0) return;

    try {
        // @ts-ignore
        const analyticsUrl = Deno.env.get('ANALYTICS_PROXY_URL');
        if (!analyticsUrl) {
            console.warn('Analytics: ANALYTICS_PROXY_URL not configured, skipping batch events');
            return;
        }

        await fetch(analyticsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                batch: rows.map(r => ({
                    project_id: r.project_id,
                    visitor_id: r.visitor_id || null,
                    session_id: r.session_id || null,
                    event_type: r.event_type,
                    event_label: r.event_label || null,
                    article_url: r.article_url || null,
                    url: r.url || null,
                })),
            }),
        });
    } catch (err) {
        console.error('Analytics: Error bulk sending events via secondary', err);
    }
}
