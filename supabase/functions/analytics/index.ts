// @ts-ignore
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logEvent, logImpression, logEventBatch, logImpressionBatch, type AnalyticsContext, type BatchEventRow } from '../_shared/analytics.ts';
import { getRequestOriginUrl, isAllowedOrigin } from '../_shared/origin.ts';
import { supabaseClient } from '../_shared/supabaseClient.ts';
import { getProjectById } from '../_shared/dao/projectDao.ts';

// Allowed event types for analytics tracking
const ALLOWED_EVENT_TYPES = [
    'impression',
    'widget_loaded',
    'widget_visible',
    'widget_expanded',
    'widget_collapsed',
    'open_chat',
    'textarea_focused',
    'suggestions_fetched',
    'suggestions_reopened',
    'suggestion_clicked',
    'suggestion_shown',
    'suggestion_x_clicked',
    'suggestion_dismissed_cancelled',
    'suggestion_dismissed_confirmed',
    'click_suggestion',
    'question_asked',
    'ask_question',
    'answer_streamed',
    'ad_impression',
    'ad_unfilled',
    'ad_refresh',
    'ad_auto_refresh',
    'conversation_started',
    'conversation_continued',
] as const;

type AllowedEventType = typeof ALLOWED_EVENT_TYPES[number];

interface AnalyticsEvent {
    project_id: string;
    visitor_id?: string;
    session_id?: string;
    event_type: string;
    event_label?: string;
    timestamp?: number;
}

async function processEvent(
    event: AnalyticsEvent,
    supabase: ReturnType<typeof supabaseClient> extends Promise<infer T> ? T : never,
    req: Request
): Promise<{ success: boolean; error?: string }> {
    const { project_id, visitor_id, session_id, event_type, event_label } = event;

    if (!project_id || !event_type) {
        return { success: false, error: 'Missing required fields: project_id and event_type' };
    }

    // Validate event type
    if (!ALLOWED_EVENT_TYPES.includes(event_type as AllowedEventType)) {
        // Log warning but don't fail - allows forward compatibility
        console.warn(`Unknown event_type: ${event_type}`);
        return { success: false, error: `Invalid event_type: ${event_type}` };
    }

    // H-1 fix: trust only cf-connecting-ip, which Cloudflare injects and clients cannot spoof.
    // Supabase Edge Functions always run on Cloudflare Workers, making this the correct
    // authoritative header regardless of any upstream CDN in front of the origin site.
    const clientIp = req.headers.get('cf-connecting-ip') ?? undefined;

    // Extract analytics context from request
    const context: AnalyticsContext = {
        projectId: project_id,
        visitorId: visitor_id,
        sessionId: session_id,
        url: req.headers.get('referer') || undefined,
        referrer: req.headers.get('referer') || undefined,
        ip: clientIp,
    };

    // Handle impression separately to use logImpression with geo enrichment
    if (event_type === 'impression') {
        await logImpression(supabase, context);
    } else {
        // Log the event
        await logEvent(supabase, context, event_type, event_label);
    }

    return { success: true };
}

serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        // Parse request body
        let body: Record<string, unknown>;
        try {
            body = await req.json();
        } catch {
            return new Response(
                JSON.stringify({ error: 'Invalid or empty request body' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // Create Supabase client
        const supabase = await supabaseClient();

        // Check if this is a batch request
        if (body.batch && Array.isArray(body.batch)) {
            // Process batch of events
            const events: AnalyticsEvent[] = body.batch;
            
            if (events.length === 0) {
                return new Response(
                    JSON.stringify({ error: 'Empty batch' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );
            }

            // Validate all events belong to the same project (security check)
            const projectIds = [...new Set(events.map(e => e.project_id))];
            if (projectIds.length > 1) {
                return new Response(
                    JSON.stringify({ error: 'All events in a batch must belong to the same project' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );
            }

            const projectId = projectIds[0];
            if (!projectId) {
                return new Response(
                    JSON.stringify({ error: 'Missing project_id in batch events' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );
            }

            // Validate project exists
            let project;
            try {
                project = await getProjectById(projectId, supabase);
            } catch (error) {
                return new Response(
                    JSON.stringify({ error: 'Invalid project_id' }),
                    { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );
            }

            // Validate origin is allowed for this project
            const requestUrl = getRequestOriginUrl(req);
            if (!isAllowedOrigin(requestUrl, project.allowed_urls)) {
                return new Response(
                    JSON.stringify({ error: 'Origin not allowed' }),
                    { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );
            }

            // Split impressions (need geo enrichment) from regular events
            const clientIp = req.headers.get('cf-connecting-ip') ?? undefined;
            const impressionEvents: AnalyticsEvent[] = [];
            const regularRows: BatchEventRow[] = [];
            let failed = 0;

            for (const event of events) {
                if (!event.project_id || !event.event_type) { failed++; continue; }
                if (!ALLOWED_EVENT_TYPES.includes(event.event_type as AllowedEventType)) { failed++; continue; }

                if (event.event_type === 'impression') {
                    impressionEvents.push(event);
                } else {
                    regularRows.push({
                        project_id: event.project_id,
                        visitor_id: event.visitor_id,
                        session_id: event.session_id,
                        event_type: event.event_type,
                        event_label: event.event_label,
                    });
                }
            }

            // All geo lookups run in parallel, then one bulk INSERT per table
            const impressionContexts: AnalyticsContext[] = impressionEvents.map(event => ({
                projectId: event.project_id,
                visitorId: event.visitor_id,
                sessionId: event.session_id,
                url: req.headers.get('referer') || undefined,
                referrer: req.headers.get('referer') || undefined,
                ip: clientIp,
            }));

            await Promise.all([
                logEventBatch(supabase, regularRows),
                logImpressionBatch(supabase, impressionContexts),
            ]);

            const processed = regularRows.length + impressionEvents.length;

            return new Response(
                JSON.stringify({ success: true, processed, failed, total: events.length }),
                { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // Single event (backward compatible)
        const { project_id, visitor_id, session_id, event_type, event_label } = body;

        if (!project_id || !event_type) {
            return new Response(
                JSON.stringify({ error: 'Missing required fields: project_id and event_type' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // Validate event type
        if (!ALLOWED_EVENT_TYPES.includes(event_type)) {
            return new Response(
                JSON.stringify({ error: `Invalid event_type. Allowed types: ${ALLOWED_EVENT_TYPES.join(', ')}` }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // Validate project exists
        let project;
        try {
            project = await getProjectById(project_id, supabase);
        } catch (error) {
            return new Response(
                JSON.stringify({ error: 'Invalid project_id' }),
                { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // Validate origin is allowed for this project
        const requestUrl = getRequestOriginUrl(req);
        if (!isAllowedOrigin(requestUrl, project.allowed_urls)) {
            console.warn('analytics: origin not allowed (single)', { attempted: requestUrl, allowed: project.allowed_urls, projectId: project_id });
            return new Response(
                JSON.stringify({ error: 'Origin not allowed' }),
                { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // H-1 fix: trust only cf-connecting-ip, which Cloudflare injects and clients cannot spoof.
        // Supabase Edge Functions always run on Cloudflare Workers, making this the correct
        // authoritative header regardless of any upstream CDN in front of the origin site.
        const clientIp = req.headers.get('cf-connecting-ip') ?? undefined;

        // Extract analytics context from request
        const context: AnalyticsContext = {
            projectId: project_id,
            visitorId: visitor_id,
            sessionId: session_id,
            url: req.headers.get('referer') || undefined,
            referrer: req.headers.get('referer') || undefined,
            ip: clientIp,
        };

        // Handle impression separately to use logImpression with geo enrichment
        if (event_type === 'impression') {
            await logImpression(supabase, context);
        } else {
            // Log the event
            await logEvent(supabase, context, event_type, event_label);
        }

        return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Error processing analytics event:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
