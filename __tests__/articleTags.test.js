/**
 * Tests for Article Tags feature:
 * - getArticleUniqueId (URL stripping)
 * - fetchAndRenderArticleTags (API call + rendering)
 * - renderTagPills (DOM creation, truncation)
 * - handleTagPillClick (fetch articles, dedup, popup)
 * - showTagPopup / closeTagPopup (DOM lifecycle)
 * - diveeTags URL param gating
 * - Analytics events (tag_pill_click, tag_article_click)
 */

const fs = require('fs');

// Mock IntersectionObserver for jsdom
global.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
};

describe('Article Tags Feature', () => {
    let widget;
    let mockConfig;

    beforeEach(() => {
        document.body.innerHTML = `
            <article>
                <h1>Test Article Title</h1>
                <p>This is a test article with enough content to pass the minimum length check for widget initialization.</p>
            </article>
        `;

        localStorage.clear();
        sessionStorage.clear();
        delete window.__diveeWidgetLoaded;
        fetch.mockClear();
        fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

        mockConfig = {
            projectId: 'test-project-123',
            nonCacheBaseUrl: 'https://srv.test.com/functions/v1',
            cachedBaseUrl: 'https://cdn.test.com/functions/v1',
            analyticsBaseUrl: 'https://analytic.test.com/functions/v1',
        };

        const contentJs = fs.readFileSync('./src/content.js', 'utf8');
        const widgetJs = fs.readFileSync('./src/widget.js', 'utf8');
        eval(contentJs);
        eval(widgetJs);

        widget = new DiveeWidget(mockConfig);
        widget.contentCache = {
            url: 'https://example.com/article/test-article.html?foo=bar',
            title: 'Test Article',
            content: 'Test content',
            extracted: true,
            articleFound: true,
        };
        widget.config = { ...widget.config, ...mockConfig };
    });

    afterEach(() => {
        // Clean up any popups left on body
        document.querySelectorAll('.divee-tag-popup').forEach(el => el.remove());
    });

    // ─── getArticleUniqueId ─────────────────────────────────────────

    describe('getArticleUniqueId', () => {
        test('should strip query params from URL', () => {
            widget.contentCache.url = 'https://example.com/article.html?fbclid=abc123&utm=test';
            const id = widget.getArticleUniqueId();
            expect(id).toBe('https://example.com/article.htmltest-project-123');
        });

        test('should strip hash fragments from URL', () => {
            widget.contentCache.url = 'https://example.com/article.html#section-1';
            const id = widget.getArticleUniqueId();
            expect(id).toBe('https://example.com/article.htmltest-project-123');
        });

        test('should return null if url is missing', () => {
            widget.contentCache.url = null;
            expect(widget.getArticleUniqueId()).toBeNull();
        });

        test('should return null if projectId is missing', () => {
            widget.config.projectId = null;
            expect(widget.getArticleUniqueId()).toBeNull();
        });

        test('should handle URL without query params', () => {
            widget.contentCache.url = 'https://example.com/article.html';
            const id = widget.getArticleUniqueId();
            expect(id).toBe('https://example.com/article.htmltest-project-123');
        });

        test('should concatenate url and projectId correctly', () => {
            widget.contentCache.url = 'https://example.com/path';
            widget.config.projectId = 'proj-abc';
            expect(widget.getArticleUniqueId()).toBe('https://example.com/pathproj-abc');
        });
    });

    // ─── fetchAndRenderArticleTags ──────────────────────────────────

    describe('fetchAndRenderArticleTags', () => {
        test('should fetch tags from cachedBaseUrl', async () => {
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ tags: [] }),
            });

            await widget.fetchAndRenderArticleTags();

            expect(fetch).toHaveBeenCalledTimes(1);
            const calledUrl = fetch.mock.calls[0][0];
            expect(calledUrl).toContain('cdn.test.com');
            expect(calledUrl).toContain('/articles/tags');
            expect(calledUrl).toContain('projectId=test-project-123');
        });

        test('should include articleId without query params', async () => {
            widget.contentCache.url = 'https://example.com/article.html?debug=true';
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ tags: [] }),
            });

            await widget.fetchAndRenderArticleTags();

            const calledUrl = fetch.mock.calls[0][0];
            expect(calledUrl).toContain(encodeURIComponent('https://example.com/article.htmltest-project-123'));
            expect(calledUrl).not.toContain('debug');
        });

        test('should store tags in state when API returns tags', async () => {
            const mockTags = [
                { value: 'Politics', type: 'category', confidence: 0.95 },
                { value: 'Israel', type: 'place', confidence: 0.9 },
            ];
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ tags: mockTags }),
            });

            // Set up DOM containers for renderTagPills
            widget.elements = {
                container: document.createElement('div'),
                collapsedView: null,
                expandedView: null,
            };

            await widget.fetchAndRenderArticleTags();

            expect(widget.state.articleTags).toEqual(mockTags);
        });

        test('should limit tags to 5', async () => {
            const mockTags = Array.from({ length: 8 }, (_, i) => ({
                value: `Tag ${i}`,
                type: 'category',
                confidence: 0.9 - i * 0.05,
            }));
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ tags: mockTags }),
            });

            widget.elements = { container: document.createElement('div'), collapsedView: null, expandedView: null };
            await widget.fetchAndRenderArticleTags();

            expect(widget.state.articleTags).toHaveLength(5);
        });

        test('should not call API if articleId is null', async () => {
            widget.contentCache.url = null;
            fetch.mockClear();

            await widget.fetchAndRenderArticleTags();

            expect(fetch).not.toHaveBeenCalled();
        });

        test('should handle non-ok response gracefully', async () => {
            fetch.mockClear();
            fetch.mockResolvedValueOnce({ ok: false, status: 403 });

            await widget.fetchAndRenderArticleTags();

            expect(widget.state.articleTags).toEqual([]);
        });

        test('should handle fetch error gracefully', async () => {
            fetch.mockClear();
            fetch.mockRejectedValueOnce(new Error('Network error'));

            await widget.fetchAndRenderArticleTags();

            expect(widget.state.articleTags).toEqual([]);
        });
    });

    // ─── renderTagPills ─────────────────────────────────────────────

    describe('renderTagPills', () => {
        beforeEach(() => {
            // Set up collapsed and expanded containers
            const collapsed = document.createElement('div');
            collapsed.innerHTML = '<div class="divee-tag-pills-collapsed"></div>';
            const expanded = document.createElement('div');
            expanded.innerHTML = '<div class="divee-tag-pills-expanded"></div>';

            widget.elements = {
                container: document.createElement('div'),
                collapsedView: collapsed,
                expandedView: expanded,
            };

            widget.state.articleTags = [
                { value: 'Politics', type: 'category', confidence: 0.95 },
                { value: 'John Doe', type: 'person', confidence: 0.9 },
            ];
        });

        test('should create pill buttons in collapsed container', () => {
            widget.renderTagPills();

            const container = widget.elements.collapsedView.querySelector('.divee-tag-pills-collapsed');
            const pills = container.querySelectorAll('.divee-tag-pill');
            expect(pills).toHaveLength(2);
        });

        test('should create pill buttons in expanded container', () => {
            widget.renderTagPills();

            const container = widget.elements.expandedView.querySelector('.divee-tag-pills-expanded');
            const pills = container.querySelectorAll('.divee-tag-pill');
            expect(pills).toHaveLength(2);
        });

        test('should set data-tag attribute with tag value', () => {
            widget.renderTagPills();

            const pill = widget.elements.collapsedView.querySelector('.divee-tag-pill');
            expect(pill.getAttribute('data-tag')).toBe('Politics');
        });

        test('should set data-type attribute with tag type', () => {
            widget.renderTagPills();

            const pills = widget.elements.collapsedView.querySelectorAll('.divee-tag-pill');
            expect(pills[0].getAttribute('data-type')).toBe('category');
            expect(pills[1].getAttribute('data-type')).toBe('person');
        });

        test('should truncate tags longer than 20 characters', () => {
            widget.state.articleTags = [
                { value: 'Very Long Category Name Here', type: 'category', confidence: 0.9 },
            ];

            widget.renderTagPills();

            const pill = widget.elements.collapsedView.querySelector('.divee-tag-pill');
            expect(pill.textContent).toBe('Very Long Category N...');
            expect(pill.textContent.length).toBeLessThanOrEqual(23); // 20 + '...'
        });

        test('should not truncate tags with 20 or fewer characters', () => {
            widget.state.articleTags = [
                { value: 'Short Tag', type: 'category', confidence: 0.9 },
            ];

            widget.renderTagPills();

            const pill = widget.elements.collapsedView.querySelector('.divee-tag-pill');
            expect(pill.textContent).toBe('Short Tag');
        });

        test('should preserve full value in data-tag even when truncated', () => {
            const fullValue = 'Very Long Category Name Here';
            widget.state.articleTags = [
                { value: fullValue, type: 'category', confidence: 0.9 },
            ];

            widget.renderTagPills();

            const pill = widget.elements.collapsedView.querySelector('.divee-tag-pill');
            expect(pill.getAttribute('data-tag')).toBe(fullValue);
        });

        test('should not render if no tags', () => {
            widget.state.articleTags = [];
            widget.renderTagPills();

            const container = widget.elements.collapsedView.querySelector('.divee-tag-pills-collapsed');
            expect(container.children).toHaveLength(0);
        });
    });

    // ─── handleTagPillClick ─────────────────────────────────────────

    describe('handleTagPillClick', () => {
        let pill;
        const tag = { value: 'Politics', type: 'category', tag_type: 'category' };

        beforeEach(() => {
            pill = document.createElement('button');
            pill.className = 'divee-tag-pill';
            document.body.appendChild(pill);

            widget.elements = {
                container: document.createElement('div'),
            };
            widget.trackEvent = jest.fn();
            widget.closeTagPopup = jest.fn();
        });

        test('should close popup if same pill clicked again', async () => {
            pill.classList.add('active');

            await widget.handleTagPillClick(pill, tag);

            expect(widget.closeTagPopup).toHaveBeenCalled();
        });

        test('should track tag_pill_click event', async () => {
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ articles: [] }),
            });

            await widget.handleTagPillClick(pill, tag);

            expect(widget.trackEvent).toHaveBeenCalledWith('tag_pill_click', expect.objectContaining({
                tag: 'Politics',
                tag_type: 'category',
            }));
        });

        test('should add loading class while fetching', async () => {
            let loadingDuringFetch = false;
            fetch.mockClear();
            fetch.mockImplementationOnce(() => {
                loadingDuringFetch = pill.classList.contains('loading');
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({ articles: [] }),
                });
            });

            await widget.handleTagPillClick(pill, tag);

            expect(loadingDuringFetch).toBe(true);
        });

        test('should remove loading class after fetch completes', async () => {
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ articles: [] }),
            });

            await widget.handleTagPillClick(pill, tag);

            expect(pill.classList.contains('loading')).toBe(false);
        });

        test('should fetch articles from cachedBaseUrl with correct params', async () => {
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ articles: [] }),
            });

            await widget.handleTagPillClick(pill, tag);

            const calledUrl = fetch.mock.calls[0][0];
            expect(calledUrl).toContain('cdn.test.com');
            expect(calledUrl).toContain('/articles/by-tag');
            expect(calledUrl).toContain('tag=Politics');
            expect(calledUrl).toContain('tagType=category');
            expect(calledUrl).toContain('limit=5');
        });

        test('should exclude current article from results', async () => {
            widget.contentCache.url = 'https://example.com/current.html';
            widget.config.projectId = 'proj-1';

            const mockArticles = [
                { unique_id: 'https://example.com/current.htmlproj-1', url: 'https://example.com/current.html', title: 'Current' },
                { unique_id: 'https://example.com/other.htmlproj-1', url: 'https://example.com/other.html', title: 'Other' },
            ];
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ articles: mockArticles }),
            });

            // Replace showTagPopup to capture articles
            let receivedArticles;
            widget.showTagPopup = jest.fn((_, __, articles) => { receivedArticles = articles; });

            await widget.handleTagPillClick(pill, tag);

            expect(receivedArticles).toHaveLength(1);
            expect(receivedArticles[0].title).toBe('Other');
        });

        test('should deduplicate articles by base URL (strip query params)', async () => {
            const mockArticles = [
                { unique_id: 'a1', url: 'https://example.com/article.html', title: 'Article 1' },
                { unique_id: 'a2', url: 'https://example.com/article.html?fbclid=abc', title: 'Article 1 Dup' },
                { unique_id: 'a3', url: 'https://example.com/other.html', title: 'Other' },
            ];
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ articles: mockArticles }),
            });

            let receivedArticles;
            widget.showTagPopup = jest.fn((_, __, articles) => { receivedArticles = articles; });

            await widget.handleTagPillClick(pill, tag);

            expect(receivedArticles).toHaveLength(2);
            expect(receivedArticles[0].title).toBe('Article 1');
            expect(receivedArticles[1].title).toBe('Other');
        });

        test('should deduplicate articles by base URL (strip hash)', async () => {
            const mockArticles = [
                { unique_id: 'a1', url: 'https://example.com/article.html', title: 'Article 1' },
                { unique_id: 'a2', url: 'https://example.com/article.html#section', title: 'Article 1 Hash' },
            ];
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ articles: mockArticles }),
            });

            let receivedArticles;
            widget.showTagPopup = jest.fn((_, __, articles) => { receivedArticles = articles; });

            await widget.handleTagPillClick(pill, tag);

            expect(receivedArticles).toHaveLength(1);
        });

        test('should cap results at 5 articles', async () => {
            const mockArticles = Array.from({ length: 10 }, (_, i) => ({
                unique_id: `a${i}`,
                url: `https://example.com/article-${i}.html`,
                title: `Article ${i}`,
            }));
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ articles: mockArticles }),
            });

            let receivedArticles;
            widget.showTagPopup = jest.fn((_, __, articles) => { receivedArticles = articles; });

            await widget.handleTagPillClick(pill, tag);

            expect(receivedArticles).toHaveLength(5);
        });

        test('should remove active and loading on fetch error', async () => {
            fetch.mockClear();
            fetch.mockRejectedValueOnce(new Error('Network error'));

            await widget.handleTagPillClick(pill, tag);

            expect(pill.classList.contains('active')).toBe(false);
            expect(pill.classList.contains('loading')).toBe(false);
            expect(widget.state.activeTagPopup).toBeNull();
        });
    });

    // ─── showTagPopup ───────────────────────────────────────────────

    describe('showTagPopup', () => {
        let pill;
        const tag = { value: 'Politics', type: 'category', tag_type: 'category' };
        const articles = [
            { url: 'https://example.com/a1.html', title: 'First Article', unique_id: 'a1', image_url: 'https://img.com/1.jpg' },
            { url: 'https://example.com/a2.html', title: 'Second Article', unique_id: 'a2', image_url: null },
        ];

        beforeEach(() => {
            pill = document.createElement('button');
            pill.className = 'divee-tag-pill';
            document.body.appendChild(pill);

            widget.elements = { container: document.createElement('div') };
            widget.trackEvent = jest.fn();
        });

        test('should append popup to document.body', () => {
            widget.showTagPopup(pill, tag, articles);

            const popup = document.querySelector('.divee-tag-popup');
            expect(popup).not.toBeNull();
            expect(popup.parentElement).toBe(document.body);
        });

        test('should set data-type attribute on popup', () => {
            widget.showTagPopup(pill, tag, articles);

            const popup = document.querySelector('.divee-tag-popup');
            expect(popup.getAttribute('data-type')).toBe('category');
        });

        test('should display type label in header', () => {
            widget.showTagPopup(pill, tag, articles);

            const label = document.querySelector('.divee-tag-popup-tag-label');
            expect(label.textContent).toBe('Category');
        });

        test('should display tag name in header', () => {
            widget.showTagPopup(pill, tag, articles);

            const title = document.querySelector('.divee-tag-popup-title');
            expect(title.textContent).toBe('Politics');
        });

        test('should render article cards', () => {
            widget.showTagPopup(pill, tag, articles);

            const cards = document.querySelectorAll('.divee-tag-popup-article');
            expect(cards).toHaveLength(2);
        });

        test('should set article link href and target', () => {
            widget.showTagPopup(pill, tag, articles);

            const card = document.querySelector('.divee-tag-popup-article');
            expect(card.href).toContain('example.com/a1.html');
            expect(card.target).toBe('_blank');
            expect(card.rel).toBe('noopener noreferrer');
        });

        test('should use placeholder image when image_url is null', () => {
            widget.showTagPopup(pill, tag, articles);

            const imgs = document.querySelectorAll('.divee-tag-popup-article-img img');
            expect(imgs[1].src).toContain('placeholder.jpg');
        });

        test('should extract domain from article URL', () => {
            widget.showTagPopup(pill, tag, articles);

            const domain = document.querySelector('.divee-tag-popup-article-domain');
            expect(domain.textContent).toBe('example.com');
        });

        test('should show empty state when no articles', () => {
            widget.showTagPopup(pill, tag, []);

            const empty = document.querySelector('.divee-tag-popup-empty');
            expect(empty).not.toBeNull();
            expect(empty.textContent).toBe('No articles found');
        });

        test('should have close button', () => {
            widget.showTagPopup(pill, tag, articles);

            const closeBtn = document.querySelector('.divee-tag-popup-close');
            expect(closeBtn).not.toBeNull();
            expect(closeBtn.getAttribute('aria-label')).toBe('Close');
        });

        test('should store popup reference for cleanup', () => {
            widget.showTagPopup(pill, tag, articles);

            expect(widget._activeTagPopupElement).not.toBeNull();
            expect(widget._activeTagPopupElement.classList.contains('divee-tag-popup')).toBe(true);
        });

        test('should display "Topic" label for unknown tag types', () => {
            const unknownTag = { value: 'Custom', type: 'custom', tag_type: 'custom' };
            widget.showTagPopup(pill, unknownTag, []);

            const label = document.querySelector('.divee-tag-popup-tag-label');
            expect(label.textContent).toBe('Topic');
        });

        test('should display "Person" label for person tags', () => {
            const personTag = { value: 'John Doe', type: 'person', tag_type: 'person' };
            widget.showTagPopup(pill, personTag, []);

            const label = document.querySelector('.divee-tag-popup-tag-label');
            expect(label.textContent).toBe('Person');
        });

        test('should display "Place" label for place tags', () => {
            const placeTag = { value: 'Israel', type: 'place', tag_type: 'place' };
            widget.showTagPopup(pill, placeTag, []);

            const label = document.querySelector('.divee-tag-popup-tag-label');
            expect(label.textContent).toBe('Place');
        });
    });

    // ─── closeTagPopup ──────────────────────────────────────────────

    describe('closeTagPopup', () => {
        test('should remove popup from DOM', () => {
            const popup = document.createElement('div');
            popup.className = 'divee-tag-popup';
            document.body.appendChild(popup);
            widget._activeTagPopupElement = popup;

            widget.elements = { container: document.createElement('div') };

            widget.closeTagPopup();

            expect(document.querySelector('.divee-tag-popup')).toBeNull();
            expect(widget._activeTagPopupElement).toBeNull();
        });

        test('should remove active class from pills', () => {
            const container = document.createElement('div');
            const pill1 = document.createElement('button');
            pill1.className = 'divee-tag-pill active';
            const pill2 = document.createElement('button');
            pill2.className = 'divee-tag-pill active';
            container.appendChild(pill1);
            container.appendChild(pill2);

            widget.elements = { container };
            widget._activeTagPopupElement = null;

            widget.closeTagPopup();

            expect(pill1.classList.contains('active')).toBe(false);
            expect(pill2.classList.contains('active')).toBe(false);
        });

        test('should set activeTagPopup state to null', () => {
            widget.elements = { container: document.createElement('div') };
            widget._activeTagPopupElement = null;
            widget.state.activeTagPopup = document.createElement('button');

            widget.closeTagPopup();

            expect(widget.state.activeTagPopup).toBeNull();
        });

        test('should remove outside click handler', () => {
            const handler = jest.fn();
            widget._tagPopupOutsideClickHandler = handler;
            widget.elements = { container: document.createElement('div') };
            widget._activeTagPopupElement = null;

            const spy = jest.spyOn(document, 'removeEventListener');

            widget.closeTagPopup();

            expect(spy).toHaveBeenCalledWith('click', handler, true);
            expect(widget._tagPopupOutsideClickHandler).toBeNull();
            spy.mockRestore();
        });
    });

    // ─── Analytics ──────────────────────────────────────────────────

    describe('Analytics Events', () => {
        let pill;
        const tag = { value: 'Politics', type: 'category', tag_type: 'category' };

        beforeEach(() => {
            pill = document.createElement('button');
            pill.className = 'divee-tag-pill';
            document.body.appendChild(pill);

            const expandedView = document.createElement('div');
            expandedView.innerHTML = '<div class="divee-suggestions-input"></div><div class="divee-input-container"></div>';
            widget.elements = { container: document.createElement('div'), expandedView };
            widget.trackEvent = jest.fn();
        });

        test('should fire tag_pill_click on pill click', async () => {
            fetch.mockClear();
            fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ articles: [] }),
            });

            await widget.handleTagPillClick(pill, tag);

            expect(widget.trackEvent).toHaveBeenCalledWith('tag_pill_click', {
                tag: 'Politics',
                tag_type: 'category',
                article_id: widget.getArticleUniqueId(),
            });
        });

        test('should fire tag_article_click when article card is clicked', () => {
            const articles = [
                { url: 'https://example.com/a1.html', title: 'Article 1', unique_id: 'uid-1' },
            ];

            widget.showTagPopup(pill, tag, articles);

            const card = document.querySelector('.divee-tag-popup-article');
            // Dispatch non-bubbling click so it reaches card listener but not document handlers
            card.dispatchEvent(new MouseEvent('click', { bubbles: false }));

            expect(widget.trackEvent).toHaveBeenCalledWith('tag_article_click', {
                tag: 'Politics',
                clicked_article_id: 'uid-1',
                source_article_id: widget.getArticleUniqueId(),
            });
        });

        test('should not fire tag_pill_click when closing active pill', async () => {
            pill.classList.add('active');
            widget.closeTagPopup = jest.fn();

            await widget.handleTagPillClick(pill, tag);

            expect(widget.trackEvent).not.toHaveBeenCalled();
        });
    });

    // ─── diveeTags URL param gating ─────────────────────────────────

    describe('diveeTags URL param gating', () => {
        test('should not enable tags without diveeTags param', () => {
            const urlParams = new URLSearchParams('');
            const tagsEnabled = urlParams.get('diveeTags') === 'true';
            expect(tagsEnabled).toBe(false);
        });

        test('should enable tags with diveeTags=true', () => {
            const urlParams = new URLSearchParams('?diveeTags=true');
            const tagsEnabled = urlParams.get('diveeTags') === 'true';
            expect(tagsEnabled).toBe(true);
        });

        test('should not enable tags with diveeTags=false', () => {
            const urlParams = new URLSearchParams('?diveeTags=false');
            const tagsEnabled = urlParams.get('diveeTags') === 'true';
            expect(tagsEnabled).toBe(false);
        });

        test('should enable tags among other params', () => {
            const urlParams = new URLSearchParams('?debug=1&diveeTags=true&foo=bar');
            const tagsEnabled = urlParams.get('diveeTags') === 'true';
            expect(tagsEnabled).toBe(true);
        });
    });
});
