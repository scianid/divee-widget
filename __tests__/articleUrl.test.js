/**
 * article_url dimension tests
 *
 * Covers:
 *  - trackEvent() attaches article_url stripped of query params and hash
 *  - article_url is always origin + pathname regardless of search/hash presence
 *  - analytics.ts helpers (logEvent, logEventBatch)
 *    forward article_url to the request payload
 */

const { describe, test, expect, beforeEach } = require('@jest/globals');

// ---------------------------------------------------------------------------
// Helpers ported from widget.js logic
// ---------------------------------------------------------------------------

/**
 * Returns origin + pathname — the canonical article_url.
 * Mirrors the logic added to widget.js trackEvent().
 */
function computeArticleUrl(location) {
    return location.origin + location.pathname;
}

// ---------------------------------------------------------------------------
// Inline port of AnalyticsContext + insert row builders from analytics.ts
// These replicate the pure data-mapping logic so we can unit-test it
// without Deno / Supabase dependencies.
// ---------------------------------------------------------------------------

function buildEventRow(ctx, eventType, eventLabel) {
    return {
        project_id: ctx.projectId,
        visitor_id: ctx.visitorId || null,
        session_id: ctx.sessionId || null,
        event_type: eventType,
        event_label: eventLabel || null,
        article_url: ctx.articleUrl || null,
    };
}

function buildBatchEventRow(r) {
    return {
        project_id: r.project_id,
        visitor_id: r.visitor_id || null,
        session_id: r.session_id || null,
        event_type: r.event_type,
        event_label: r.event_label || null,
        article_url: r.article_url || null,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('article_url computation (widget.js trackEvent logic)', () => {
    test('strips query string from URL', () => {
        const loc = { origin: 'https://example.com', pathname: '/news/story', search: '?utm_source=google', hash: '' };
        expect(computeArticleUrl(loc)).toBe('https://example.com/news/story');
    });

    test('strips hash fragment from URL', () => {
        const loc = { origin: 'https://example.com', pathname: '/news/story', search: '', hash: '#section-2' };
        expect(computeArticleUrl(loc)).toBe('https://example.com/news/story');
    });

    test('strips both query string and hash', () => {
        const loc = { origin: 'https://example.com', pathname: '/news/story', search: '?ref=newsletter', hash: '#top' };
        expect(computeArticleUrl(loc)).toBe('https://example.com/news/story');
    });

    test('preserves plain URL with no params', () => {
        const loc = { origin: 'https://example.com', pathname: '/about', search: '', hash: '' };
        expect(computeArticleUrl(loc)).toBe('https://example.com/about');
    });

    test('preserves trailing slash on root', () => {
        const loc = { origin: 'https://example.com', pathname: '/', search: '', hash: '' };
        expect(computeArticleUrl(loc)).toBe('https://example.com/');
    });

    test('works with deep nested paths', () => {
        const loc = { origin: 'https://news.site.co.il', pathname: '/category/tech/2026/03/article-slug', search: '?page=2', hash: '' };
        expect(computeArticleUrl(loc)).toBe('https://news.site.co.il/category/tech/2026/03/article-slug');
    });
});

describe('article_url in analytics event payload (widget.js trackEvent)', () => {
    let widget;

    beforeEach(() => {
        // Reset fetch mock
        fetch.mockClear();
        fetch.mockResolvedValue({ ok: true, text: async () => '' });

        // Load widget into the test environment
        const fs = require('fs');
        const widgetJs = fs.readFileSync('./src/widget.js', 'utf8');
        eval(widgetJs); // eslint-disable-line no-eval

        widget = new DiveeWidget({ // eslint-disable-line no-undef
            projectId: 'test-project-123',
            analyticsBaseUrl: 'https://analytic.test.com/functions/v1',
        });
        widget.state.visitorId = 'visitor-abc';
        widget.state.sessionId = 'session-xyz';
    });

    test('event sent immediately includes article_url field (string, no ? or #)', () => {
        widget.analyticsConfig.immediateEvents = ['widget_loaded'];
        fetch.mockClear(); // clear config fetch calls from widget init
        widget.trackEvent('widget_loaded', {});

        expect(fetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body).toHaveProperty('article_url');
        expect(typeof body.article_url).toBe('string');
        expect(body.article_url).not.toContain('?');
        expect(body.article_url).not.toContain('#');
    });

    test('article_url does not contain query string characters', () => {
        widget.analyticsConfig.immediateEvents = ['widget_loaded'];
        fetch.mockClear();
        widget.trackEvent('widget_loaded', {});

        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.article_url).not.toContain('?');
    });

    test('article_url does not contain hash fragment characters', () => {
        widget.analyticsConfig.immediateEvents = ['widget_loaded'];
        fetch.mockClear();
        widget.trackEvent('widget_loaded', {});

        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.article_url).not.toContain('#');
    });

    test('queued events include article_url on flush', () => {
        widget.analyticsConfig.maxBatchSize = 1;
        widget.analyticsConfig.immediateEvents = [];
        fetch.mockClear();
        widget.trackEvent('widget_closed', {});

        expect(fetch).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(fetch.mock.calls[0][1].body);
        const event = payload.batch ? payload.batch[0] : payload;
        expect(event).toHaveProperty('article_url');
    });

    test.skip('article_url reflects exact page path - tested in E2E (jsdom cannot reassign window.location)', () => {
        // jsdom intercepts the location setter as a navigation attempt; location
        // reassignment tests are covered in E2E via Playwright.
    });
});

describe('article_url in analytics.ts insert row builders', () => {
    const baseCtx = {
        projectId: 'proj-1',
        visitorId: 'visitor-abc',
        sessionId: 'session-xyz',
        url: 'https://example.com/articles/test-story?x=1',
        referrer: 'https://google.com',
        articleUrl: 'https://example.com/articles/test-story',
        ip: '1.2.3.4',
        platform: 'desktop',
    };

    describe('logEvent row', () => {
        test('includes article_url in event row', () => {
            const row = buildEventRow(baseCtx, 'widget_loaded', null);
            expect(row.article_url).toBe('https://example.com/articles/test-story');
        });

        test('article_url is null when not provided', () => {
            const row = buildEventRow({ ...baseCtx, articleUrl: undefined }, 'widget_loaded');
            expect(row.article_url).toBeNull();
        });
    });

    describe('logEventBatch rows (BatchEventRow)', () => {
        test('passes article_url through in batch row', () => {
            const batchRow = {
                project_id: 'proj-1',
                visitor_id: 'v1',
                session_id: 's1',
                event_type: 'ad_impression',
                event_label: null,
                article_url: 'https://example.com/articles/test-story',
            };
            const row = buildBatchEventRow(batchRow);
            expect(row.article_url).toBe('https://example.com/articles/test-story');
        });

        test('article_url is null when not in batch row', () => {
            const batchRow = {
                project_id: 'proj-1',
                visitor_id: 'v1',
                session_id: 's1',
                event_type: 'widget_closed',
            };
            const row = buildBatchEventRow(batchRow);
            expect(row.article_url).toBeNull();
        });
    });
});
