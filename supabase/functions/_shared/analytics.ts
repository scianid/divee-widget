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

async function enrichGeo(ctx: AnalyticsContext): Promise<void> {
    if (!ctx.ip || ctx.geo?.country) return;

    try {
        const ipApiKey = Deno.env.get('IP_API_KEY');
        let keyParam = '';
        if (ipApiKey) {
            keyParam = `&key=${ipApiKey}`;
        } else {
            console.warn('Analytics: IP_API_KEY not configured, skipping geo lookup');
            return;
        }
        // https://members.ip-api.com/#pricing
        const res = await fetch(`http://pro.ip-api.com/json/${ctx.ip}?fields=countryCode,city,lat,lon,status,mobile,proxy${keyParam}`);
        const resData = await res.json();
        if (resData.status === 'success') {
            ctx.geo = {
                country: resData.countryCode,
                city: resData.city,
                latitude: resData.lat,
                longitude: resData.lon
            };
            if (resData.mobile !== null) {
                ctx.platform = resData.mobile ? 'mobile' : 'desktop';
            }
        }
    } catch (e) {
        console.error('Analytics: Failed to resolve geo from IP:', e);
    }
}

export async function logImpression(supabase: ReturnType<typeof createClient>, ctx: AnalyticsContext) {
    if (!ctx.projectId) return;

    await enrichGeo(ctx);

    try {
        const { error } = await supabase.from('analytics_impressions').insert({
            project_id: ctx.projectId,
            visitor_id: ctx.visitorId || null,
            session_id: ctx.sessionId || null,
            url: ctx.url,
            referrer: ctx.referrer,
            article_url: ctx.articleUrl || null,
            ip: ctx.ip,
            geo_country: ctx.geo?.country,
            geo_city: ctx.geo?.city,
            geo_lat: ctx.geo?.latitude,
            geo_lng: ctx.geo?.longitude,
            platform: ctx.platform || 'unknown',
        });

        if (error) {
            console.error('Analytics: Failed to log impression', error);
        }
    } catch (err) {
        console.error('Analytics: Error logging impression', err);
    }
}

export async function logImpressionBatch(supabase: ReturnType<typeof createClient>, contexts: AnalyticsContext[]) {
    if (contexts.length === 0) return;

    // Resolve all geo lookups in parallel, then bulk insert in one round-trip
    await Promise.allSettled(contexts.map(ctx => enrichGeo(ctx)));

    try {
        const { error } = await supabase.from('analytics_impressions').insert(
            contexts.map(ctx => ({
                project_id: ctx.projectId,
                visitor_id: ctx.visitorId || null,
                session_id: ctx.sessionId || null,
                url: ctx.url,
                referrer: ctx.referrer,
                article_url: ctx.articleUrl || null,
                ip: ctx.ip,
                geo_country: ctx.geo?.country,
                geo_city: ctx.geo?.city,
                geo_lat: ctx.geo?.latitude,
                geo_lng: ctx.geo?.longitude,
                platform: ctx.platform || 'unknown',
            }))
        );

        if (error) {
            console.error('Analytics: Failed to bulk insert impressions', error);
        }
    } catch (err) {
        console.error('Analytics: Error bulk inserting impressions', err);
    }
}

export async function logEvent(
    supabase: ReturnType<typeof createClient>,
    ctx: AnalyticsContext,
    eventType: string,
    eventLabel?: string
) {
    if (!ctx.projectId) return;

    try {
        const { error } = await supabase.from('analytics_events').insert({
            project_id: ctx.projectId,
            visitor_id: ctx.visitorId || null,
            session_id: ctx.sessionId || null,
            event_type: eventType,
            event_label: eventLabel,
            article_url: ctx.articleUrl || null,
        });

        if (error) {
            console.error('Analytics: Failed to log event', error);
        }
    } catch (err) {
        console.error('Analytics: Error logging event', err);
    }
}

export interface BatchEventRow {
    project_id: string;
    visitor_id?: string;
    session_id?: string;
    event_type: string;
    event_label?: string;
    article_url?: string;
}

export async function logEventBatch(
    supabase: ReturnType<typeof createClient>,
    rows: BatchEventRow[]
) {
    if (rows.length === 0) return;

    try {
        const { error } = await supabase.from('analytics_events').insert(
            rows.map(r => ({
                project_id: r.project_id,
                visitor_id: r.visitor_id || null,
                session_id: r.session_id || null,
                event_type: r.event_type,
                event_label: r.event_label || null,
                article_url: r.article_url || null,
            }))
        );

        if (error) {
            console.error('Analytics: Failed to bulk insert events', error);
        }
    } catch (err) {
        console.error('Analytics: Error bulk inserting events', err);
    }
}
