/**
 * Divee Article Assistant Widget
 * Embeddable AI chat widget for articles
 * 
 * Requires: content.js (for getContent, getContentTitle, getContentUrl functions)
 * These functions should be loaded before this widget or available globally.
 */

(function () {
    'use strict';

    class DiveeWidget {
        constructor(config) {
            this.config = {
                projectId: config.projectId,
                cachedBaseUrl: config.cachedBaseUrl || 'https://cdn.divee.ai/functions/v1',
                nonCacheBaseUrl: config.nonCacheBaseUrl || 'https://srv.divee.ai/functions/v1',
                analyticsBaseUrl: config.analyticsBaseUrl || 'https://analytic.divee.ai/functions/v1',
                // These will be populated from server config
                displayMode: 'anchored',
                floatingPosition: 'bottom-right',
                anchoredPosition: 'bottom',
                articleClass: null,
                containerSelector: null,
                attentionAnimation: config.attentionAnimation !== false
            };

            this.state = {
                isExpanded: false,
                isStreaming: false,
                suggestions: [],
                messages: [],
                serverConfig: null,
                conversationId: null,
                visitorToken: null,          // HMAC ownership token, set after first chat
                aiResponseCount: 0,
                suggestionsSuppressed: false,
                widgetVisibleTracked: false,   // Track if widget_visible event has been fired
                adRefreshInterval: null,       // Interval ID for auto-refreshing ads
                articleTags: [],               // Tags fetched from /articles/tags API
                activeTagPopup: null           // Currently open tag popup pill element
            };

            // Session tracking state
            this.sessionTracking = {
                startedAt: Date.now(),
                activeStart: Date.now(),       // null when tab is hidden
                accumulatedActiveMs: 0,
                hasInteracted: false,
                interactionType: null,         // 'divee_opened' | 'suggestions_received' | 'question_asked'
                timers: [],                    // setTimeout IDs for heartbeat schedule
                interval: null                 // setInterval ID for recurring heartbeats
            };

            // Analytics batching
            this.analyticsQueue = [];
            this.analyticsFlushTimer = null;
            this.analyticsConfig = {
                maxBatchSize: 10,      // Flush when queue reaches this size
                flushInterval: 3000,   // Flush after 3 seconds of inactivity
                immediateEvents: ['widget_loaded', 'impression', 'widget_visible'] // Events to send immediately
            };

            this.elements = {};

            // Cache for article content (extracted once)
            this.contentCache = {
                content: null,
                title: null,
                url: null,
                image_url: null,
                og_image: null,
                extracted: false,
                articleFound: false
            };

            // Check if suggestions are suppressed for this session
            this.checkSuggestionsSuppression();

            this.init();
        }

        isDebugMode() {
            const urlParams = new URLSearchParams(window.location.search);
            return urlParams.get('diveeDebug') === 'true';
        }

        isMockAdRequested() {
            const urlParams = new URLSearchParams(window.location.search);
            return urlParams.get('diveeMockAd') === 'true';
        }

        // ============================================
        // SESSION TRACKING
        // ============================================

        getOrCreateSessionTrackingId() {
            const key = 'divee_session_tracking_id';
            let id = sessionStorage.getItem(key);
            if (!id) {
                id = this.generateUUID();
                sessionStorage.setItem(key, id);
            }
            return id;
        }

        computeSessionTotals() {
            const now = Date.now();
            const st = this.sessionTracking;
            const activeMs = st.accumulatedActiveMs +
                (st.activeStart !== null ? now - st.activeStart : 0);
            return {
                active_seconds: Math.round(activeMs / 1000),
                elapsed_seconds: Math.round((now - st.startedAt) / 1000)
            };
        }

        buildSessionPayload() {
            const { active_seconds, elapsed_seconds } = this.computeSessionTotals();
            const st = this.sessionTracking;
            const payload = {
                project_id: this.config.projectId,
                session_id: this.getOrCreateSessionTrackingId(),
                visitor_id: this.state.visitorId || null,
                active_seconds,
                elapsed_seconds,
                interaction_with_divee: st.hasInteracted,
            };
            if (st.interactionType) {
                payload.interaction_type = st.interactionType;
            }
            return payload;
        }

        sendSessionHeartbeat() {
            const payload = this.buildSessionPayload();
            const endpoint = `${this.config.analyticsBaseUrl}/analytics`;
            this.log('[Divee Session] Heartbeat:', payload);
            const blob = new Blob([JSON.stringify({ session: payload })], {
                type: 'text/plain'
            });
            if (navigator.sendBeacon) {
                navigator.sendBeacon(endpoint, blob);
            } else {
                fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session: payload }),
                    keepalive: true
                }).catch(() => { /* best-effort telemetry */ });
            }
        }

        sendSessionBeacon() {
            const payload = this.buildSessionPayload();
            const endpoint = `${this.config.analyticsBaseUrl}/analytics`;
            const blob = new Blob([JSON.stringify({ session: payload })], {
                type: 'text/plain'
            });
            this.log('[Divee Session] Beacon:', payload);
            if (navigator.sendBeacon) {
                navigator.sendBeacon(endpoint, blob);
            } else {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', endpoint, false);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.send(JSON.stringify({ session: payload }));
            }
        }

        recordSessionEvent(eventType) {
            const EVENT_TO_INTERACTION = {
                widget_expanded: 'divee_opened',
                open_chat: 'divee_opened',
                suggestions_fetched: 'suggestions_received',
                get_suggestions: 'suggestions_received',
                question_asked: 'question_asked',
                ask_question: 'question_asked',
                suggestion_question_asked: 'question_asked',
                custom_question_asked: 'question_asked'
            };
            const INTERACTION_DEPTH = {
                divee_opened: 1,
                suggestions_received: 2,
                question_asked: 3
            };

            const tier = EVENT_TO_INTERACTION[eventType];
            if (!tier) return;

            const st = this.sessionTracking;
            st.hasInteracted = true;

            const advanced =
                st.interactionType === null ||
                INTERACTION_DEPTH[tier] > INTERACTION_DEPTH[st.interactionType];

            if (advanced) {
                st.interactionType = tier;
                // Send session heartbeat immediately on interaction advancement
                this.sendSessionHeartbeat();
            }
        }

        initSessionTracking() {
            const SCHEDULE = [5000, 10000, 20000]; // early heartbeats at 5s, 10s, 20s
            const INTERVAL = 30000;                 // then every 30s

            const st = this.sessionTracking;

            const t1 = setTimeout(() => {
                this.sendSessionHeartbeat();
                const t2 = setTimeout(() => {
                    this.sendSessionHeartbeat();
                    const t3 = setTimeout(() => {
                        this.sendSessionHeartbeat();
                        st.interval = setInterval(() => this.sendSessionHeartbeat(), INTERVAL);
                    }, SCHEDULE[2] - SCHEDULE[1]);
                    st.timers.push(t3);
                }, SCHEDULE[1] - SCHEDULE[0]);
                st.timers.push(t2);
            }, SCHEDULE[0]);
            st.timers.push(t1);

            // Track tab visibility for active_seconds
            this._handleSessionVisibility = () => {
                if (document.visibilityState === 'hidden') {
                    if (st.activeStart !== null) {
                        st.accumulatedActiveMs += Date.now() - st.activeStart;
                        st.activeStart = null;
                    }
                    this.sendSessionBeacon();
                } else {
                    st.activeStart = Date.now();
                }
            };
            document.addEventListener('visibilitychange', this._handleSessionVisibility);

            this._handleSessionBeforeUnload = () => {
                if (st.activeStart !== null) {
                    st.accumulatedActiveMs += Date.now() - st.activeStart;
                    st.activeStart = null;
                }
                this.sendSessionBeacon();
            };
            window.addEventListener('beforeunload', this._handleSessionBeforeUnload);
        }

        cleanupSessionTracking() {
            const st = this.sessionTracking;
            st.timers.forEach(t => clearTimeout(t));
            if (st.interval) clearInterval(st.interval);
            document.removeEventListener('visibilitychange', this._handleSessionVisibility);
            window.removeEventListener('beforeunload', this._handleSessionBeforeUnload);
            this.sendSessionHeartbeat();
        }

        checkSuggestionsSuppression() {
            const key = `divee_suggestions_suppressed_${window.location.href}`;
            this.state.suggestionsSuppressed = sessionStorage.getItem(key) === 'true';
        }

        suppressSuggestions() {
            const key = `divee_suggestions_suppressed_${window.location.href}`;
            sessionStorage.setItem(key, 'true');
            this.state.suggestionsSuppressed = true;
        }

        log(...args) {
            if (this.isDebugMode()) {
                console.log('[Divee]', ...args);
            }
        }

        generateUUID() {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                return crypto.randomUUID();
            }
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        }

        // L-4 fix: escape server-config strings before inserting into innerHTML.
        escapeHtml(str) {
            if (str == null) return '';
            return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
        }

        getAnalyticsIds() {
            // Visitor ID (Persistent)
            let visitorId = localStorage.getItem('divee_visitor_id');
            if (!visitorId) {
                visitorId = this.generateUUID();
                localStorage.setItem('divee_visitor_id', visitorId);
            }

            // Session ID (Per Page Load - new conversation on each page visit)
            let sessionId = this.generateUUID();

            this.state.visitorId = visitorId;
            this.state.sessionId = sessionId;

            // Restore persisted visitor token (issued by /chat, proves visitor ownership)
            const storedToken = localStorage.getItem('divee_visitor_token');
            if (storedToken) {
                this.state.visitorToken = storedToken;
            }

            // Clear any old conversation IDs from sessionStorage
            const conversationKey = `divee_conversation_${window.location.href}`;
            sessionStorage.removeItem(conversationKey);

            // Conversation ID starts null - new conversation on each page load
            // Server will assign conversation_id on first question

            return { visitorId, sessionId };
        }

        initGoogleAds() {
            if (window.googletag && window.googletag._initialized_by_divee) {
                this.log('Ads already initialized, skipping');
                return;
            }

            this.log('Initializing Google Ads...');
            const self = this; // Capture widget instance
            
            // Get ad tag ID from server config - required to show ads
            const adTagId = this.state.serverConfig?.ad_tag_id;
            if (!adTagId) {
                this.log('No ad_tag_id in server config, skipping ads');
                return;
            }
            
            // account ID for Divee
            const accountId = '22247219933';
            
            // Build ad paths: /{accountId},{adTagId}/Divee/{platform}
            const desktopAdPath = `/${accountId},${adTagId}/Divee/Desktop`;
            const mobileAdPath = `/${accountId},${adTagId}/Divee/mobileweb`;
            
            // Check if GPT is already loaded by the page
            const gptAlreadyLoaded = window.googletag && window.googletag.apiReady;
            this.log('GPT preloaded:', gptAlreadyLoaded, 'Ad tag:', adTagId);
            this._gptAlreadyLoaded = gptAlreadyLoaded;
            
            window.googletag = window.googletag || { cmd: [] };
            window.googletag._initialized_by_divee = true;
            
            // Only load GPT script if not already loaded
            if (!gptAlreadyLoaded) {
                const gptScript = document.createElement('script');
                gptScript.async = true;
                gptScript.src = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';
                gptScript.crossOrigin = 'anonymous';

                gptScript.onload = () => self.log('✓ GPT script loaded');
                gptScript.onerror = () => console.error('[Divee] Failed to load GPT script');
                document.head.appendChild(gptScript);
            }

            googletag.cmd.push(function () {

                // Get ad size overrides from config or use defaults
                let desktopSizes = [[970, 250], [728, 90], [468, 60]]; //, [300, 250]
                let desktopSizes768 = [[728, 90], [468, 60]]; // , [300, 250]
                let mobileSizes = [[336, 280], [320, 250], [300, 250], [320, 100], [300, 100], [320, 50], [300, 50]];
                
                // Parse override_desktop_ad_size if provided
                if (self.state.serverConfig?.override_desktop_ad_size) {
                    try {
                        const parsed = JSON.parse(self.state.serverConfig.override_desktop_ad_size);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            desktopSizes = parsed;
                            // Also use for 768+ breakpoint, filtering out sizes larger than 728px wide
                            desktopSizes768 = parsed.filter(size => size[0] <= 728);
                            self.log('Using override desktop ad sizes:', desktopSizes);
                        }
                    } catch (e) {
                        console.error('[Divee] Failed to parse override_desktop_ad_size:', e);
                    }
                }
                
                // Parse override_mobile_ad_size if provided
                if (self.state.serverConfig?.override_mobile_ad_size) {
                    try {
                        const parsed = JSON.parse(self.state.serverConfig.override_mobile_ad_size);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            mobileSizes = parsed;
                            self.log('Using override mobile ad sizes:', mobileSizes);
                        }
                    } catch (e) {
                        console.error('[Divee] Failed to parse override_mobile_ad_size:', e);
                    }
                }

                // Collapsed view ads - with responsive size mapping
                const desktopSizeMapping = googletag.sizeMapping()
                    .addSize([1024, 0], desktopSizes)
                    .addSize([768, 0], desktopSizes768)
                    .addSize([0, 0], [])
                    .build();
                
                const mobileSizeMapping = googletag.sizeMapping()
                    .addSize([768, 0], [])
                    .addSize([0, 0], mobileSizes)
                    .build();

                const desktopSlot = googletag.defineSlot(desktopAdPath, desktopSizes, 'div-gpt-ad-1770993606680-0');
                if (desktopSlot) {
                    desktopSlot.defineSizeMapping(desktopSizeMapping);
                    desktopSlot.addService(googletag.pubads());
                } else {
                    console.error('[Divee] Failed to define desktop slot');
                }

                const mobileSlot = googletag.defineSlot(mobileAdPath, mobileSizes, 'div-gpt-ad-1770993160534-0');
                if (mobileSlot) {
                    mobileSlot.defineSizeMapping(mobileSizeMapping);
                    mobileSlot.addService(googletag.pubads());
                } else {
                    console.error('[Divee] Failed to define mobile slot');
                }

                self.log('✓ Ad slots defined');

                googletag.pubads().collapseEmptyDivs();
                googletag.pubads().enableLazyLoad({
                    fetchMarginPercent: 200,
                    renderMarginPercent: 100,
                    mobileScaling: 2
                });
                googletag.pubads().setTargeting('content_type', 'article');
                googletag.pubads().setTargeting('display_mode', self.config.displayMode || 'anchored');
                googletag.enableServices();
                
                // If GPT was already loaded, mark slots for refresh
                const gptAlreadyLoaded = self._gptAlreadyLoaded || false;
                if (gptAlreadyLoaded) {
                    self._needsSlotRefresh = true;
                }
                
                self.log('✓ Ads initialized');
            });
        }

        async init() {
            this.log('Initializing widget...', this.config);

            // Initialize Analytics IDs
            this.getAnalyticsIds();

            // Load server configuration first (needed for ad_tag_id)
            await this.loadServerConfig();

            // Initialize Google Ads (after config is loaded to get ad_tag_id)
            this.initGoogleAds();

            if (!this.state.serverConfig) {
                this.log('Widget disabled due to config load failure');
                return;
            }

            // Extract article content
            const articleFound = this.extractArticleContent();
            
            // Don't render widget if article element not found or content is empty
            if (!articleFound) {
                this.log('Widget disabled: article element not found');
                return;
            }
            
            if (!this.articleContent || this.articleContent.trim().length < 10) {
                this.log('Widget disabled: article content is empty or too short to load', {
                    contentLength: this.articleContent?.length || 0
                });
                return;
            }

            // Track impression only when article is present
            this.trackEvent('impression', {
                url: this.contentCache.url || window.location.href,
                referrer: document.referrer
            });

            // Create widget DOM
            this.createWidget();

            // Attach event listeners
            this.attachEventListeners();

            // Setup visibility tracking
            this.setupVisibilityTracking();

            // Setup analytics batch flush on page unload
            this.setupPageUnloadFlush();

            // Setup session tracking (heartbeats + active time)
            this.initSessionTracking();

            // Setup attention animation (off by default)
            this.setupAttentionAnimation();

            // Track analytics
            this.trackEvent('widget_loaded', {
                project_id: this.config.projectId,
                article_id: this.config.articleId,
                position: this.config.position
            });

            this.fetchAndRenderArticleTags();
        }

        async loadServerConfig() {
            try {
                const serverConfig = await this.fetchServerConfig(this.config.projectId);

                this.state.serverConfig = serverConfig;
                this.log('Server config loaded:', this.state.serverConfig);

                // Apply display settings from server config (override data attributes)
                if (serverConfig.display_mode) {
                    this.config.displayMode = serverConfig.display_mode;
                    this.log('Display mode from config:', serverConfig.display_mode);
                }
                if (serverConfig.display_position) {
                    // Apply position based on display mode
                    if (this.config.displayMode === 'floating') {
                        this.config.floatingPosition = serverConfig.display_position;
                        this.log('Floating position from config:', serverConfig.display_position);
                    } else {
                        // Anchored mode: only allow 'top' or 'bottom'
                        this.config.anchoredPosition = ['top', 'bottom'].includes(serverConfig.display_position) 
                            ? serverConfig.display_position 
                            : 'bottom';
                        this.log('Anchored position from config:', this.config.anchoredPosition);
                    }
                }
                if (serverConfig.anchored_position) {
                    // Explicit anchored_position overrides display_position for anchored mode
                    this.config.anchoredPosition = ['top', 'bottom'].includes(serverConfig.anchored_position) 
                        ? serverConfig.anchored_position 
                        : 'bottom';
                    this.log('Anchored position override from config:', this.config.anchoredPosition);
                }
                if (serverConfig.article_class) {
                    this.config.articleClass = serverConfig.article_class;
                    this.log('Article class from config:', serverConfig.article_class);
                }
                
                // Handle container selector with mobile override support
                const isMobile = window.innerWidth < 768;
                if (isMobile && serverConfig.override_mobile_container_selector) {
                    this.config.containerSelector = serverConfig.override_mobile_container_selector;
                    this.log('Container selector from mobile override:', serverConfig.override_mobile_container_selector);
                } else if (serverConfig.widget_container_class) {
                    this.config.containerSelector = serverConfig.widget_container_class;
                    this.log('Container selector from config:', serverConfig.widget_container_class);
                }


                // Apply direction and language
                if (serverConfig.direction) {
                    this.elements.container?.setAttribute('dir', serverConfig.direction);
                }
                if (serverConfig.language) {
                    this.elements.container?.setAttribute('lang', serverConfig.language);
                }
                
                // Apply highlight colors as CSS custom properties
                this.applyThemeColors(serverConfig);

                // URL param overrides (for testing/debugging)
                const urlParams = new URLSearchParams(window.location.search);
                const overrideDisplayMode = urlParams.get('diveeOverrideDisplayMode');
                const overrideDisplayPosition = urlParams.get('diveeOverrideDisplayPosition');
                const overrideArticleClass = urlParams.get('diveeOverrideArticleClass');
                const overrideContainerSelector = urlParams.get('diveeOverrideContainerSelector');
                
                // Always log overrides (not just in debug mode)
                if (overrideDisplayMode || overrideDisplayPosition || overrideArticleClass || overrideContainerSelector) {
                    this.log('URL param overrides detected:', {
                        displayMode: overrideDisplayMode,
                        displayPosition: overrideDisplayPosition,
                        articleClass: overrideArticleClass,
                        containerSelector: overrideContainerSelector
                    });
                }
                
                if (overrideDisplayMode) {
                    this.config.displayMode = overrideDisplayMode;
                    this.log('Display mode overridden by URL param:', overrideDisplayMode);
                }
                if (overrideDisplayPosition) {
                    // For floating mode positions (bottom-right, bottom-left, etc.)
                    this.config.floatingPosition = overrideDisplayPosition;
                    // For anchored mode positions (top, bottom)
                    if (['top', 'bottom'].includes(overrideDisplayPosition)) {
                        this.config.anchoredPosition = overrideDisplayPosition;
                    }
                    this.log('Display position overridden by URL param:', overrideDisplayPosition);
                }
                if (overrideArticleClass) {
                    this.config.articleClass = overrideArticleClass;
                    this.log('Article class overridden by URL param:', overrideArticleClass);
                }
                if (overrideContainerSelector) {
                    this.config.containerSelector = overrideContainerSelector;
                    this.log('Container selector overridden by URL param:', overrideContainerSelector);
                }
                
                // Log final config after all overrides
                this.log('Final config after overrides:', {
                    displayMode: this.config.displayMode,
                    floatingPosition: this.config.floatingPosition,
                    anchoredPosition: this.config.anchoredPosition,
                    articleClass: this.config.articleClass,
                    containerSelector: this.config.containerSelector
                });
            } catch (error) {
                console.error('[Divee] Failed to load config:', error);
                this.state.serverConfig = null;
            }
        }

        applyThemeColors(config) {
            if (!this.elements.container) return;
            
            const colors = config?.highlight_color || this.getDefaultConfig().highlight_color;
            
            if (Array.isArray(colors) && colors.length >= 2) {
                this.elements.container.style.setProperty('--divee-color-primary', colors[0]);
                this.elements.container.style.setProperty('--divee-color-secondary', colors[1]);
                this.log('Applied theme colors:', colors[0], colors[1]);
            }
        }

        async fetchServerConfig(projectId) {
            if (!this.config.cachedBaseUrl) {
                throw new Error('Missing cachedBaseUrl');
            }

            const configUrl = `${this.config.cachedBaseUrl}/config?projectId=${encodeURIComponent(projectId)}`;

            const response = await fetch(configUrl, {
                method: 'GET'
            });

            if (!response.ok) {
                throw new Error(`Config request failed: ${response.status}`);
            }

            return response.json();
        }

        getDefaultConfig() {
            return {
                direction: 'ltr',
                language: 'en',
                icon_url: 'https://images.icon-icons.com/167/PNG/512/cnn_23166.png',
                client_name: 'Demo Site',
                client_description: 'Article Assistant',
                highlight_color: ['#68E5FD', '#A389E0'],
                show_ad: true,
                input_text_placeholders: [
                    'Ask anything about this article...'
                ]
            };
        }

        extractArticleContent() {
            // Check if content is already cached
            if (this.contentCache.extracted) {
                this.log('Using cached content');
                this.articleTitle = this.contentCache.title;
                this.articleContent = this.contentCache.content;
                return this.contentCache.articleFound;
            }

            // Check if window.diveeArticle is provided (e.g., by WordPress plugin)
            if (typeof window.diveeArticle !== 'undefined' && window.diveeArticle) {
                const diveeArticle = window.diveeArticle;
                if (diveeArticle.title || diveeArticle.content) {
                    this.log('Using article data from window.diveeArticle (WordPress plugin)');
                    this.articleTitle = diveeArticle.title || document.title || 'Untitled Article';
                    this.articleContent = diveeArticle.content || '';
                    this.articleUrl = diveeArticle.url || window.location.href;
                    
                    // Cache the provided content
                    this.contentCache = {
                        content: this.articleContent,
                        title: this.articleTitle,
                        url: this.articleUrl,
                        image_url: diveeArticle.image || null,
                        og_image: null,
                        extracted: true,
                        articleFound: true
                    };
                    return true;
                }
            }

            // Extract content using functions from content.js
            let articleFound = false;
            try {
                // Use getContentTitle() if available
                if (typeof getContentTitle === 'function') {
                    this.articleTitle = getContentTitle();
                } else {
                    this.articleTitle = document.title || document.querySelector('h1')?.textContent || 'Untitled Article';
                }

                // Check if article element exists
                let articleElement = null;
                if (this.config.articleClass) {
                    articleElement = document.querySelector(this.config.articleClass);
                }
                
                if (!articleElement) {
                    // Try default selectors
                    articleElement = document.querySelector('article') ||
                        document.querySelector('[role="article"]') ||
                        document.querySelector('main');
                }

                // If no article element found, don't render widget
                if (!articleElement) {
                    this.log('No article element found, widget will not render');
                    articleFound = false;
                } else {
                    articleFound = true;
                }

                // Use getContent() if available
                if (typeof getContent === 'function') {
                    this.articleContent = getContent(this.config.articleClass);
                } else {
                    // Fallback to simple extraction
                    this.articleContent = articleElement ? articleElement.textContent.trim() : '';
                }

                // Use getContentUrl() if available
                if (typeof getContentUrl === 'function') {
                    this.articleUrl = getContentUrl();
                } else {
                    this.articleUrl = window.location.href;
                }

                // Extract social share image metadata
                const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                               document.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
                               null;
                
                const articleImage = document.querySelector('article img')?.src ||
                                   document.querySelector('[role="article"] img')?.src ||
                                   null;

                // Cache the extracted content
                this.contentCache = {
                    content: this.articleContent,
                    title: this.articleTitle,
                    url: this.articleUrl,
                    image_url: articleImage,
                    og_image: ogImage,
                    extracted: true,
                    articleFound: articleFound
                };

                this.log('Article extracted and cached:', {
                    title: this.articleTitle,
                    url: this.articleUrl,
                    contentLength: this.articleContent.length,
                    articleFound: articleFound,
                    hasOgImage: !!ogImage,
                    hasArticleImage: !!articleImage
                });

                return articleFound;
            } catch (error) {
                console.error('[Divee] Error extracting content:', error);
                this.contentCache = {
                    content: '',
                    title: document.title || 'Untitled Article',
                    url: window.location.href,
                    image_url: null,
                    og_image: null,
                    extracted: true,
                    articleFound: false
                };
                return false;
            }
        }

        createWidget() {
            // Debug: Log config values at widget creation time
            this.log('createWidget called with config:', {
                displayMode: this.config.displayMode,
                floatingPosition: this.config.floatingPosition,
                anchoredPosition: this.config.anchoredPosition
            });
            
            // Create container
            const container = document.createElement('div');
            container.className = 'divee-widget';
            container.setAttribute('data-state', 'collapsed');
            // Force overflow:hidden via inline important — beats AMP/site CSS that may override the class rule
            container.style.setProperty('overflow', 'hidden', 'important');
            
            // Apply display mode
            if (this.config.displayMode === 'floating') {
                this.log('Applying floating mode with position:', this.config.floatingPosition);
                container.classList.add('divee-widget-floating');
                container.setAttribute('data-floating-position', this.config.floatingPosition);
            } else {
                this.log('Anchored mode, position:', this.config.anchoredPosition);
            }

            // Apply direction from config
            const config = this.state.serverConfig || this.getDefaultConfig();
            if (config.direction) {
                container.setAttribute('dir', config.direction);
            }

            // Create collapsed view
            const collapsedView = this.createCollapsedView();
            container.appendChild(collapsedView);

            // Create expanded view (hidden initially)
            const expandedView = this.createExpandedView();
            expandedView.style.display = 'none';
            container.appendChild(expandedView);

            // Create shared ad container - starts hidden, revealed only when an ad fills
            const hasAds = config.show_ad && config.ad_tag_id && this.config.displayMode !== 'floating';
            const showMockAd = !config.show_ad && this.isMockAdRequested();
            this.log('[MockAd] show_ad:', config.show_ad, '| ad_tag_id:', config.ad_tag_id, '| diveeMockAd param:', this.isMockAdRequested(), '| showMockAd:', showMockAd, '| hasAds:', hasAds);
            if (showMockAd) {
                this.log('[MockAd] Rendering mock ad GIF (ads disabled in config + diveeMockAd=true)');
            } else if (!showMockAd && this.isMockAdRequested()) {
                this.log('[MockAd] Mock ad NOT shown: diveeMockAd=true but show_ad is enabled in config (mock only works when ads are off)');
            } else {
                this.log('[MockAd] Mock ad NOT shown: diveeMockAd param is not true');
            }
            const adContainer = document.createElement('div');
            adContainer.className = 'divee-ad-container-shared';
            adContainer.style.display = (hasAds || showMockAd) ? 'block' : 'none';
            if (showMockAd) {
                adContainer.innerHTML = `
                    <div class="divee-ad-slot divee-ad-slot-shared divee-mock-ad-slot">
                        <img src="https://srv.divee.ai/storage/v1/object/public/public-files/fake-ad.gif"
                             alt="Ad placeholder"
                             class="divee-mock-ad-img" />
                    </div>
                `;
            } else {
                adContainer.innerHTML = `
                    <div class="divee-ad-slot divee-ad-slot-shared" ${hasAds ? '' : 'style="display: none;"'}>
                        <!-- Desktop Ad -->
                        <div id='div-gpt-ad-1770993606680-0' class='divee-ad-desktop' style='display: none; min-height: 60px; margin: 0 !important; max-width: 100%; overflow: hidden;'></div>
                        <!-- Mobile Ad -->
                        <div id='div-gpt-ad-1770993160534-0' class='divee-ad-mobile' style='display: none; min-height: 50px; max-width: 100%; overflow: hidden;'></div>
                    </div>
                `;
            }
            container.appendChild(adContainer);

            // Store references
            this.elements.container = container;
            this.elements.collapsedView = collapsedView;
            this.elements.expandedView = expandedView;
            this.elements.adContainer = adContainer;

            // Apply initial theme colors (will be updated when server config loads)
            this.applyThemeColors(this.state.serverConfig || this.getDefaultConfig());

            // Insert into page
            this.insertWidget(container);
        }

        createCollapsedView() {
            const view = document.createElement('div');
            view.className = 'divee-collapsed';

            const config = this.state.serverConfig || this.getDefaultConfig();
            // Hide ads in floating mode collapsed view
            const showAd = (config.show_ad && config.ad_tag_id && this.config.displayMode !== 'floating') ? '' : 'style="display: none;"';
            
            view.innerHTML = `
                <div class="divee-powered-by-collapsed">
                    <a class="divee-powered-by" href="https://www.divee.ai" target="_blank" rel="noopener noreferrer">powered by divee.ai</a>
                </div>
                <div class="divee-search-container-collapsed">
                    <img class="divee-icon-ai-collapsed" src="https://srv.divee.ai/storage/v1/object/public/public-files/ai.png" alt="AI icon" />
                    <img class="divee-icon-site-collapsed" src="${config.icon_url}" alt="Site icon" />
                    <input type="text" class="divee-search-input-collapsed" placeholder="" readonly />
                    <span class="divee-send-icon-collapsed" aria-hidden="true">&#10148;</span>
        </div>
                <div class="divee-tag-pills divee-tag-pills-collapsed"></div>
      `;

            // Add typewriter effect
            setTimeout(() => {
                const input = view.querySelector('.divee-search-input-collapsed');
                if (input && config.input_text_placeholders) {
                    this.typewriterEffect(input, config.input_text_placeholders);
                }
            }, 500);

            return view;
        }

        typewriterEffect(input, phrases) {
            if (!input || !phrases || phrases.length === 0) return;

            let phraseIndex = 0;
            let charIndex = 0;
            const typeSpeed = 50;
            const deleteSpeed = 30;
            const pauseAfterType = 2000;
            const pauseAfterDelete = 500;

            const type = () => {
                const currentPhrase = String(phrases[phraseIndex] || '');
                if (charIndex < currentPhrase.length) {
                    input.placeholder = currentPhrase.substring(0, charIndex + 1);
                    charIndex++;
                    setTimeout(type, typeSpeed + Math.random() * 30);
                } else {
                    setTimeout(erase, pauseAfterType);
                }
            };

            const erase = () => {
                const currentPhrase = String(phrases[phraseIndex] || '');
                if (charIndex > 0) {
                    input.placeholder = currentPhrase.substring(0, charIndex - 1);
                    charIndex--;
                    setTimeout(erase, deleteSpeed);
                } else {
                    // Move to next phrase
                    phraseIndex = (phraseIndex + 1) % phrases.length;
                    setTimeout(type, pauseAfterDelete);
                }
            };

            // Start typing
            type();
        }

        createEmptyState(config) {
            const container = document.createElement('div');
            container.className = 'divee-empty-state';

            const placeholders = config.input_text_placeholders || ['Ask anything about this article...'];
            // Use the first one as primary, or all of them.
            // Let's show the first one as a prompt.
            const text = placeholders.length > 0 ? placeholders[0] : 'Ask me anything about this article';

            container.innerHTML = `
                <div class="divee-empty-icon">
                    <img src="${config.icon_url}" alt="AI" />
                </div>
            `;
            return container;
        }

        createExpandedView() {
            const view = document.createElement('div');
            view.className = 'divee-expanded';

            const config = this.state.serverConfig || this.getDefaultConfig();
            const placeholder = (config.input_text_placeholders && config.input_text_placeholders.length > 0)
                ? config.input_text_placeholders[0]
                : 'Ask anything about this article...';

            view.innerHTML = `
                <div class="divee-header">
                    <div class="divee-header-top">
                        <div class="divee-icons">
                            <img class="divee-icon-site-collapsed" src="https://srv.divee.ai/storage/v1/object/public/public-files/ai.png" alt="AI icon" />
                            <img class="divee-icon-site" src="${config.icon_url}" alt="Site icon" />
                        </div>
                        <span class="divee-title">${this.escapeHtml(config.client_name)}</span>
                        <a class="divee-powered-by" href="https://www.divee.ai" target="_blank" rel="noopener noreferrer">powered by divee.ai</a>
                        <button class="divee-close" aria-label="Close">✕</button>
                    </div>
                </div>
                <div class="divee-content">
                    <div class="divee-chat">
                        <div class="divee-messages"></div>
          </div>
                    <div class="divee-input-container">
                        <div class="divee-suggestions-input" style="display: none;">
                            <div class="divee-suggestions-list"></div>
                        </div>
            <textarea 
                            class="divee-input" 
              placeholder="${placeholder}"
              rows="1"
              maxlength="200"
            ></textarea>
                        <button class="divee-send" aria-label="Send">
              <span class="divee-send-svg" aria-hidden="true">&#10148;</span>
            </button>
            <div class="divee-input-footer">
                <div class="divee-warning">${this.escapeHtml(config.disclaimer_text) || 'This is an AI driven tool, results might not always be accurate'}</div>
                <div class="divee-counter">0/200</div>
            </div>
                        <div class="divee-tag-pills divee-tag-pills-expanded"></div>
          </div>
        </div>
      `;

            // Add typewriter effect
            setTimeout(() => {
                const input = view.querySelector('.divee-input');
                if (input && config.input_text_placeholders) {
                    this.typewriterEffect(input, config.input_text_placeholders);
                }
            }, 500);

            // Add empty state if no messages
            const messagesContainer = view.querySelector('.divee-messages');
            if (this.state.messages.length === 0) {
                const emptyState = this.createEmptyState(config);
                messagesContainer.appendChild(emptyState);
            }

            return view;
        }

        insertWidget(container) {
            this.log('insertWidget called with config:', {
                displayMode: this.config.displayMode,
                anchoredPosition: this.config.anchoredPosition,
                containerSelector: this.config.containerSelector
            });
            this.log('Display mode:', this.config.displayMode);
            this.log('Config containerSelector (from server):', this.config.containerSelector);

            // For floating mode, always append to body
            if (this.config.displayMode === 'floating') {
                this.log('Floating mode: appending to body');
                document.body.appendChild(container);
                this.displayAdsIfNeeded();
                return;
            }

            let targetElement = null;

            // First, try custom container selector if provided
            if (this.config.containerSelector) {
                this.log('✓ Using containerSelector from server config:', this.config.containerSelector);
                this.log('Attempting to find element with querySelector:', this.config.containerSelector);
                targetElement = document.querySelector(this.config.containerSelector);
                if (targetElement) {
                    this.log('✓ Found custom container element:', {
                        selector: this.config.containerSelector,
                        tagName: targetElement.tagName,
                        className: targetElement.className,
                        id: targetElement.id
                    });
                } else {
                    this.log(`✗ Container selector "${this.config.containerSelector}" not found in DOM, falling back to default behavior`);
                }
            } else {
                this.log('No containerSelector from server config, using default auto-detection');
            }

            // Fallback to default behavior
            if (!targetElement) {
                this.log('Looking for default containers (article, [role="article"], main)');
                targetElement = document.querySelector('article') ||
                    document.querySelector('[role="article"]') ||
                    document.querySelector('main');
                if (targetElement) {
                    this.log('✓ Found default container:', targetElement.tagName, targetElement.className);
                } else {
                    this.log('✗ No default container found, will append to body');
                }
            }

            // Insert widget based on anchored position
            if (targetElement) {
                this.log('Inserting widget to target element, position:', this.config.anchoredPosition);
                if (this.config.anchoredPosition === 'top') {
                    this.log('Using prepend() for top position');
                    targetElement.prepend(container);
                } else {
                    this.log('Using appendChild() for bottom position');
                    targetElement.appendChild(container);
                }
            } else {
                // Final fallback: append to body if nothing found
                this.log('No suitable container found, appending to body as fallback');
                if (this.config.anchoredPosition === 'top') {
                    document.body.prepend(container);
                } else {
                    document.body.appendChild(container);
                }
            }

            this.displayAdsIfNeeded();
        }

        displayAdsIfNeeded() {
            // Display ads after widget is in DOM
            const config = this.state.serverConfig || this.getDefaultConfig();

            if (config.show_ad && window.googletag) {
                const self = this; // Capture widget instance
                
                // Use googletag.cmd.push instead of setTimeout - it automatically waits for GPT to be ready
                googletag.cmd.push(function () {
                    googletag.display('div-gpt-ad-1770993606680-0');
                    googletag.display('div-gpt-ad-1770993160534-0');
                    self.log('✓ Ad slots displayed');

                    // If GPT was already loaded, refresh newly defined slots
                    if (self._needsSlotRefresh) {
                        const collapsedSlots = googletag.pubads().getSlots().filter(slot => {
                            const slotId = slot.getSlotElementId();
                            return slotId === 'div-gpt-ad-1770993606680-0' || slotId === 'div-gpt-ad-1770993160534-0';
                        });
                        if (collapsedSlots.length > 0) {
                            googletag.pubads().refresh(collapsedSlots);
                            self.log('✓ Refreshed pre-loaded slots');
                        }
                        self._needsSlotRefresh = false;
                    }

                    // Listen for ad slot rendering events
                    let emptyAdCount = 0;
                    const diveeAdSlotIds = ['div-gpt-ad-1770993606680-0', 'div-gpt-ad-1770993160534-0'];
                    const renderedSlots = {};

                    googletag.pubads().addEventListener('slotRenderEnded', function (event) {
                        const slotId = event.slot.getSlotElementId();
                        if (!diveeAdSlotIds.includes(slotId)) return;
                        const adElement = document.getElementById(slotId);

                        // Traverse up from the specific ad element — more reliable than document.querySelector
                        const adSlotContainer = adElement?.closest('.divee-ad-slot-shared');
                        const adOuterContainer = adElement?.closest('.divee-ad-container-shared');

                        console.log('[Divee Ad] slotRenderEnded', {
                            slotId,
                            isEmpty: event.isEmpty,
                            size: event.size,
                            adElementFound: !!adElement,
                            adSlotContainerFound: !!adSlotContainer,
                            adOuterContainerFound: !!adOuterContainer,
                        });

                        renderedSlots[slotId] = !event.isEmpty;

                        if (event.isEmpty) {
                            if (adElement) adElement.style.display = 'none';
                            emptyAdCount++;
                            console.log('[Divee Ad] Slot empty, hiding:', slotId);
                            self.trackEvent('ad_unfilled', {
                                ad_unit: slotId,
                                position: 'collapsed',
                                reason: 'no_fill'
                            });
                            // If all tracked slots are empty, hide the whole container
                            if (Object.keys(renderedSlots).length === diveeAdSlotIds.length &&
                                Object.values(renderedSlots).every(filled => !filled)) {
                                if (adSlotContainer) adSlotContainer.style.display = 'none';
                                if (adOuterContainer) adOuterContainer.style.display = 'none';
                                console.log('[Divee Ad] All slots empty, hiding containers');
                            }
                        } else {
                            // Ad filled — reveal it
                            if (adElement) adElement.style.display = '';
                            if (adSlotContainer) adSlotContainer.style.display = '';
                            if (adOuterContainer) adOuterContainer.style.display = '';
                            self.trackEvent('ad_impression', {
                                ad_unit: slotId,
                                position: 'collapsed',
                                size: event.size ? `${event.size[0]}x${event.size[1]}` : 'unknown',
                                advertiser_id: event.advertiserId || null,
                                creative_id: event.creativeId || null,
                                line_item_id: event.lineItemId || null
                            });
                            if (adElement) self.setupAdClickTracking(adElement, slotId, event);
                        }
                    });

                    // Start auto-refresh for ads
                        self.startAdAutoRefresh();
                    });
            } else {
                this.log('WARNING: Ads NOT displayed!');
                this.log('WARNING: Reason:', !config.show_ad ? 'show_ad is false in config' : 'googletag not available');
                this.log('WARNING: config.show_ad:', config.show_ad);
                this.log('WARNING: window.googletag:', !!window.googletag);
            }
        }

        startAdAutoRefresh() {
            // Clear any existing refresh interval
            if (this.state.adRefreshInterval) {
                clearInterval(this.state.adRefreshInterval);
            }

            const self = this;
            const REFRESH_INTERVAL = 60000; // 1 minute in milliseconds

            this.state.adRefreshInterval = setInterval(() => {
                if (!this.isWidgetInViewport()) {
                    this.log('Ad refresh skipped: widget not near viewport');
                    return;
                }
                if (!window.googletag || !window.googletag.pubads) {
                    this.log('Ad refresh skipped: googletag not ready');
                    return;
                }

                googletag.cmd.push(function () {
                    if (!self.isWidgetInViewport()) {
                        self.log('Ad refresh skipped: widget not near viewport (cmd)');
                        return;
                    }
                    // Get all Divee ad slots
                    const allSlots = googletag.pubads().getSlots();
                    const diveeSlots = allSlots.filter(slot => {
                        const slotId = slot.getSlotElementId();
                        return slotId.startsWith('div-gpt-ad-');
                    });

                    // Only refresh slots that are currently visible
                    const visibleSlots = diveeSlots.filter(slot => {
                        const element = document.getElementById(slot.getSlotElementId());
                        if (!element) return false;

                        // Check if element is visible (not display: none and has dimensions)
                        const style = window.getComputedStyle(element);
                        if (style.display === 'none' || style.visibility === 'hidden') {
                            return false;
                        }

                        // Check if element is in viewport
                        const rect = element.getBoundingClientRect();
                        return (
                            rect.top < window.innerHeight &&
                            rect.bottom > 0 &&
                            rect.width > 0 &&
                            rect.height > 0
                        );
                    });

                    if (visibleSlots.length > 0) {
                        googletag.pubads().refresh(visibleSlots);
                        self.log('✓ Auto-refreshed', visibleSlots.length, 'ad(s)');
                        self.trackEvent('ad_auto_refresh', {
                            slots_refreshed: visibleSlots.map(s => s.getSlotElementId()),
                            count: visibleSlots.length,
                            interval_ms: REFRESH_INTERVAL
                        });
                    }
                });
            }, REFRESH_INTERVAL);
        }

        isWidgetInViewport(paddingPx = 200) {
            const container = this.elements.container;
            if (!container) return false;

            const style = window.getComputedStyle(container);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                return false;
            }

            const rect = container.getBoundingClientRect();
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
            const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

            return (
                rect.bottom > -paddingPx &&
                rect.right > -paddingPx &&
                rect.top < viewportHeight + paddingPx &&
                rect.left < viewportWidth + paddingPx &&
                rect.width > 0 &&
                rect.height > 0
            );
        }

        stopAdAutoRefresh() {
            if (this.state.adRefreshInterval) {
                clearInterval(this.state.adRefreshInterval);
                this.state.adRefreshInterval = null;
            }
        }

        setupAttentionAnimation() {
            const urlParams = new URLSearchParams(window.location.search);
            const urlOverride = urlParams.get('diveeOverrideAttentionAnimation');
            // Disabled if config says false, unless URL param explicitly forces it on
            if (!this.config.attentionAnimation && urlOverride !== 'true') return;

            // Use an in-memory counter so it resets on every page load.
            // sessionStorage was causing the animation to never show after the first
            // tab session exhausted the cap.
            const MAX_SEQUENCES = 3;
            let playCount = 0;

            const searchBar = this.elements.collapsedView?.querySelector('.divee-search-container-collapsed');
            if (!searchBar) return;

            let started = false;
            let intervalId = null;

            const runSequence = () => {
                if (this.state.isExpanded) return;
                if (playCount >= MAX_SEQUENCES) {
                    clearInterval(intervalId);
                    return;
                }
                this.playAttentionSequence(searchBar);
                playCount++;
                if (playCount >= MAX_SEQUENCES) clearInterval(intervalId);
            };

            // Only animate when widget is visible in viewport
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting && !started) {
                        started = true;
                        setTimeout(() => {
                            runSequence();
                            intervalId = setInterval(runSequence, 8000);
                        }, 2500);
                    }
                });
            }, { threshold: 0.4 });

            observer.observe(this.elements.container);
            this.attentionObserver = observer;
        }

        playAttentionSequence(container) {
            if (container.classList.contains('divee-attention-active')) return;

            container.classList.add('divee-attention-active');

            // Clean up after glow animation finishes (2.2s × 2 iterations)
            setTimeout(() => {
                container.classList.remove('divee-attention-active');
            }, 4800);
        }

        attachEventListeners() {
            // Click anywhere on collapsed view to expand
            this.elements.collapsedView.addEventListener('click', () => this.expand());

            // Close button
            const closeButton = this.elements.expandedView.querySelector('.divee-close');
            closeButton.addEventListener('click', (e) => {
                e.stopPropagation();
                this.collapse();
            });

            // Text area focus
            const textarea = this.elements.expandedView.querySelector('.divee-input');
            textarea.addEventListener('focus', () => this.onTextAreaFocus());
            textarea.addEventListener('click', () => this.onTextAreaFocus()); // Also open on click
            textarea.addEventListener('input', (e) => {
                this.autoResizeTextarea(e.target);
                this.updateCharacterCounter(e.target);
            });

            // Close suggestions on click outside
            document.addEventListener('click', (e) => {
                const suggestionsInput = this.elements.expandedView.querySelector('.divee-suggestions-input');
                const inputContainer = this.elements.expandedView.querySelector('.divee-input-container');

                if (suggestionsInput &&
                    suggestionsInput.classList.contains('is-open') &&
                    !inputContainer.contains(e.target)) {
                    suggestionsInput.classList.remove('is-open');
                }
            });

            // Send button
            const sendButton = this.elements.expandedView.querySelector('.divee-send');
            sendButton.addEventListener('click', () => this.sendQuestion());

            // Enter key to send
            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendQuestion();
                }
            });
        }

        expand() {
            this.state.isExpanded = true;
            this.elements.container.setAttribute('data-state', 'expanded');

            // Show expanded view and trigger animation
            this.elements.expandedView.style.display = 'block';
            this.elements.expandedView.style.opacity = '0';
            this.elements.expandedView.style.transform = 'translateY(10px)';

            // Fade out collapsed view
            this.elements.collapsedView.style.opacity = '0';

            setTimeout(() => {
                this.elements.collapsedView.style.display = 'none';
                this.elements.expandedView.style.opacity = '1';
                this.elements.expandedView.style.transform = 'translateY(0)';
            }, 150);

            this.trackEvent('widget_expanded', { trigger: 'click' });

            // Focus on input after animation
            setTimeout(() => {
                this.elements.expandedView.querySelector('.divee-input').focus();
            }, 300);
        }

        collapse() {
            this.state.isExpanded = false;
            this.elements.container.setAttribute('data-state', 'collapsed');

            // Fade out expanded view
            this.elements.expandedView.style.opacity = '0';
            this.elements.expandedView.style.transform = 'translateY(10px)';

            setTimeout(() => {
                this.elements.expandedView.style.display = 'none';
                this.elements.collapsedView.style.display = 'block';
                this.elements.collapsedView.style.opacity = '0';

                setTimeout(() => {
                    this.elements.collapsedView.style.opacity = '1';
                }, 50);
            }, 200);

            this.trackEvent('widget_collapsed', {
                time_spent: Date.now(),
                questions_asked: this.state.messages.filter(m => m.role === 'user').length
            });
        }

        async onTextAreaFocus() {
            const suggestionsContainer = this.elements.expandedView.querySelector('.divee-suggestions-input');

            // If we already have suggestions, just show them
            if (this.state.suggestions.length > 0) {
                if (suggestionsContainer && !suggestionsContainer.classList.contains('is-open')) {
                    suggestionsContainer.style.display = 'block';
                    suggestionsContainer.classList.add('is-open');
                    this.trackEvent('suggestions_reopened', { count: this.state.suggestions.length });
                }
                return;
            }

            this.trackEvent('textarea_focused', { timestamp: Date.now() });

            const suggestionsList = suggestionsContainer?.querySelector('.divee-suggestions-list');

            // Show shimmer loading state
            if (suggestionsContainer && suggestionsList) {
                suggestionsContainer.style.display = 'block';
                suggestionsContainer.classList.add('is-open');
                suggestionsList.innerHTML = `
        <div class="divee-suggestion divee-loading-item"><div class="divee-shimmer-line"></div></div>
        <div class="divee-suggestion divee-loading-item"><div class="divee-shimmer-line"></div></div>
        <div class="divee-suggestion divee-loading-item"><div class="divee-shimmer-line"></div></div>
      `;
            }

            try {
                const suggestions = await this.fetchSuggestions();
                this.state.suggestions = suggestions;

                // Fade out shimmer first
                // No complex fade needed, just swap content as structure matches
                if (!suggestionsList) return;
                suggestionsList.innerHTML = '';

                // Add suggestions with animation
                suggestions.forEach((item, idx) => {
                    const questionText = typeof item === 'string' ? item : item.question;
                    const questionId = typeof item === 'string' ? null : item.id;
                    const button = document.createElement('button');
                    button.className = 'divee-suggestion';
                    button.setAttribute('data-index', idx);
                    if (questionId) button.setAttribute('data-id', questionId);
                    button.textContent = questionText;
                    button.addEventListener('click', (e) => {
                        const question = e.target.textContent;
                        const id = e.target.getAttribute('data-id');
                        this.askQuestion(question, 'suggestion', id);
                    });
                    suggestionsList.appendChild(button);
                });

                this.trackEvent('suggestions_fetched', {
                    article_id: this.config.articleId,
                    suggestions_count: suggestions.length,
                    load_time: 0
                });
            } catch (error) {
                console.error('[Divee] Failed to fetch suggestions:', error);
                if (suggestionsList) {
                    suggestionsList.innerHTML = '<div class="divee-error">Could not load suggestions</div>';
                }
            }
        }

        async fetchSuggestions() {
            // Send cached content to server for suggestions
            const payload = {
                projectId: this.config.projectId,
                articleId: this.config.articleId,
                title: this.contentCache.title,
                url: this.contentCache.url,
                content: this.contentCache.content,
                visitor_id: this.state.visitorId,
                session_id: this.state.sessionId,
                metadata: {
                    image_url: this.contentCache.image_url,
                    og_image: this.contentCache.og_image
                }
            };

            try {
                const response = await fetch(`${this.config.nonCacheBaseUrl}/suggestions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error(`Suggestions request failed: ${response.status}`);
                }

                const data = await response.json();
                if (Array.isArray(data?.suggestions)) {
                    return data.suggestions;
                }
            } catch (error) {
                console.error('[Divee] Suggestions request failed:', error);
            }

            return [];
        }

        sendQuestion() {
            const textarea = this.elements.expandedView.querySelector('.divee-input');
            const question = textarea.value.trim();

            if (!question) return;

            this.askQuestion(question, 'custom', null);
            textarea.value = '';
            textarea.style.height = 'auto';

            // Reset counter
            const counter = this.elements.expandedView.querySelector('.divee-counter');
            if (counter) {
                counter.textContent = '0/200';
            }
        }

        async askQuestion(question, type, questionId) {
            // Track question event for session tracking
            this.trackEvent(type === 'suggestion' ? 'suggestion_question_asked' : 'custom_question_asked', {
                question_type: type
            });

            // Close suggestions overlay so user can see the chat
            const suggestionsContainer = this.elements.expandedView.querySelector('.divee-suggestions-input');
            if (suggestionsContainer) {
                suggestionsContainer.classList.remove('is-open');
            }

            // Add user message
            this.addMessage('user', question);

            // Start streaming response
            this.state.isStreaming = true;
            const messageId = this.addMessage('ai', '', true);

            try {
                await this.streamResponse(question, messageId, questionId);
            } catch (error) {
                console.error('[Divee] Failed to get answer:', error);
                this.updateMessage(messageId, 'Sorry, I encountered an error. Please try again.');
            } finally {
                this.state.isStreaming = false;
            }
        }

        addMessage(role, content, streaming = false) {
            const messagesContainer = this.elements.expandedView.querySelector('.divee-messages');

            // Remove empty state
            const emptyState = messagesContainer.querySelector('.divee-empty-state');
            if (emptyState) emptyState.remove();

            const chatContainer = this.elements.expandedView.querySelector('.divee-chat');
            const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const messageDiv = document.createElement('div');
            messageDiv.className = `divee-message divee-message-${role}`;
            messageDiv.setAttribute('data-message-id', messageId);

            const label = document.createElement('div');
            label.className = 'divee-message-label';
            if (role === 'user') {
                label.textContent = 'You';
            } else {
                const config = this.state.serverConfig || this.getDefaultConfig();
                label.innerHTML = `<img class="divee-message-icon" src="${config.icon_url}" alt="AI" />`;
            }

            const contentDiv = document.createElement('div');
            contentDiv.className = 'divee-message-content';
            contentDiv.textContent = content;

            if (streaming) {
                const cursor = document.createElement('span');
                cursor.className = 'divee-cursor';
                cursor.textContent = '▊';
                contentDiv.appendChild(cursor);
            }

            messageDiv.appendChild(label);
            messageDiv.appendChild(contentDiv);
            messagesContainer.appendChild(messageDiv);

            // Scroll to bottom of chat container
            chatContainer.scrollTop = chatContainer.scrollHeight;

            this.state.messages.push({ id: messageId, role, content });

            return messageId;
        }

        updateMessage(messageId, content, append = false) {
            const messageDiv = this.elements.expandedView.querySelector(`[data-message-id="${messageId}"]`);
            if (!messageDiv) return;

            const contentDiv = messageDiv.querySelector('.divee-message-content');
            const cursor = contentDiv.querySelector('.divee-cursor');

            if (append) {
                const textNode = document.createTextNode(content);
                if (cursor) {
                    contentDiv.insertBefore(textNode, cursor);
                } else {
                    contentDiv.appendChild(textNode);
                }
            } else {
                if (cursor) cursor.remove();
                contentDiv.textContent = content;
            }

            // Scroll to bottom of chat container
            const chatContainer = this.elements.expandedView.querySelector('.divee-chat');
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        async simulateStreaming(messageId, text) {
            const chunkSize = 4;
            for (let i = 0; i < text.length; i += chunkSize) {
                const chunk = text.slice(i, i + chunkSize);
                this.updateMessage(messageId, chunk, true);
                await new Promise(resolve => setTimeout(resolve, 15));
            }
        }

        async streamResponse(question, messageId, questionId) {
            const payload = {
                projectId: this.config.projectId,
                questionId: questionId || `q-${Date.now()}`,
                question: question,
                title: this.contentCache.title,
                url: this.contentCache.url,
                content: this.contentCache.content,
                visitor_id: this.state.visitorId,
                session_id: this.state.sessionId,
                conversation_id: this.state.conversationId, // Include if exists
                metadata: {
                    image_url: this.contentCache.image_url,
                    og_image: this.contentCache.og_image
                }
            };

            const response = await fetch(`${this.config.nonCacheBaseUrl}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                if (response.status === 403) {
                    this.updateMessage(messageId, 'Free form questions are currently not supported.');
                    const messageDiv = this.elements.expandedView.querySelector(`[data-message-id="${messageId}"]`);
                    const cursor = messageDiv?.querySelector('.divee-cursor');
                    if (cursor) cursor.remove();
                    return;
                }
                if (response.status === 429) {
                    const errorData = await response.json().catch(() => ({}));
                    this.updateMessage(messageId, errorData.error || 'Too many requests. Please try again later.');
                    const messageDiv = this.elements.expandedView.querySelector(`[data-message-id="${messageId}"]`);
                    const cursor = messageDiv?.querySelector('.divee-cursor');
                    if (cursor) cursor.remove();
                    return;
                }
                throw new Error(`Chat request failed: ${response.status}`);
            }

            // Store conversation ID from response header (per page session only)
            const conversationId = response.headers.get('X-Conversation-Id');
            if (conversationId && !this.state.conversationId) {
                this.state.conversationId = conversationId;
            }

            // Store visitor ownership token for authenticating /conversations calls (C-2 fix)
            const visitorToken = response.headers.get('X-Visitor-Token');
            if (visitorToken) {
                this.state.visitorToken = visitorToken;
                localStorage.setItem('divee_visitor_token', visitorToken);
            }

            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await response.json();
                if (data?.answer) {
                    await this.simulateStreaming(messageId, data.answer);
                }
            } else if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });

                    const parts = buffer.split('\n\n');
                    buffer = parts.pop() || '';

                    for (const part of parts) {
                        const lines = part.split('\n');
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed.startsWith('data:')) continue;
                            const data = trimmed.replace(/^data:\s*/, '');
                            if (data === '[DONE]') continue;
                            try {
                                const json = JSON.parse(data);
                                const delta = json?.choices?.[0]?.delta?.content;
                                if (delta) this.updateMessage(messageId, delta, true);
                            } catch {
                                // ignore parse errors
                            }
                        }
                    }
                }
            }

            const messageDiv = this.elements.expandedView.querySelector(`[data-message-id="${messageId}"]`);
            const cursor = messageDiv?.querySelector('.divee-cursor');
            if (cursor) cursor.remove();

            // Increment AI response count and check if we should show a suggestion
            this.state.aiResponseCount++;
            await this.maybeShowSuggestionCard();
        }

        async maybeShowSuggestionCard() {
            // Show suggestion card after every 2nd AI response (#2, #4, #6, #8...)
            if (!this.state.suggestionsSuppressed && this.state.aiResponseCount % 2 === 0) {
                await this.showSuggestionCard();
            }
        }

        // ============================================
        // ARTICLE TAG PILLS & POPUP
        // ============================================

        getArticleUniqueId() {
            // article unique_id = url (without query params) + projectId (matches articleDao.ts convention)
            let url = this.contentCache.url;
            const projectId = this.config.projectId;
            if (!url || !projectId) return null;
            try { url = url.split('?')[0].split('#')[0]; } catch (e) {}
            return url + projectId;
        }

        async fetchAndRenderArticleTags() {
            const articleId = this.getArticleUniqueId();
            
            if (!articleId) {
                this.log('[Divee Tags] No articleId, skipping tag fetch');
                return;
            }

            try {
                const url = `${this.config.cachedBaseUrl}/articles/tags?projectId=${encodeURIComponent(this.config.projectId)}&articleId=${encodeURIComponent(articleId)}`;
                this.log('[Divee Tags] Fetching:', url);
                const response = await fetch(url);
                this.log('[Divee Tags] Response status:', response.status);
                if (!response.ok) return;

                const data = await response.json();
                this.log('[Divee Tags] Response data:', data);
                const tags = Array.isArray(data?.tags) ? data.tags.slice(0, 5) : [];
                this.log('[Divee Tags] Tags found:', tags.length, tags);
                if (tags.length === 0) return;

                this.state.articleTags = tags;
                this.renderTagPills();
                this.log('[Divee Tags] Pills rendered');
            } catch (error) {
                console.error('[Divee Tags] Failed to fetch:', error);
            }
        }

        renderTagPills() {
            const tags = this.state.articleTags;
            if (!tags || tags.length === 0) return;

            // Render in both collapsed and expanded pill containers
            const containers = [
                this.elements.collapsedView?.querySelector('.divee-tag-pills-collapsed'),
                this.elements.expandedView?.querySelector('.divee-tag-pills-expanded')
            ].filter(Boolean);

            containers.forEach(container => {
                container.innerHTML = '';
                tags.forEach(tag => {
                    const pill = document.createElement('button');
                    pill.className = 'divee-tag-pill';
                    pill.setAttribute('data-tag', tag.value);
                    pill.setAttribute('data-type', tag.type);
                    pill.textContent = tag.value.length > 20 ? tag.value.substring(0, 20) + '...' : tag.value;
                    pill.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.handleTagPillClick(pill, tag);
                    });
                    container.appendChild(pill);
                });
            });
        }

        async handleTagPillClick(pillElement, tag) {
            // If same pill is clicked again, close popup
            if (pillElement.classList.contains('active')) {
                this.closeTagPopup();
                return;
            }

            // Close existing popup if any
            this.closeTagPopup();

            // Mark pill as active
            pillElement.classList.add('active');
            this.state.activeTagPopup = pillElement;

            // Track analytics
            this.trackEvent('tag_pill_click', {
                tag: tag.value,
                tag_type: tag.type,
                article_id: this.getArticleUniqueId()
            });

            // Show loading state
            pillElement.classList.add('loading');

            try {
                const currentUniqueId = this.getArticleUniqueId();
                const url = `${this.config.cachedBaseUrl}/articles/by-tag?projectId=${encodeURIComponent(this.config.projectId)}&tag=${encodeURIComponent(tag.value)}&tagType=${encodeURIComponent(tag.type)}&limit=5${currentUniqueId ? '&excludeId=' + encodeURIComponent(currentUniqueId) : ''}`;
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Request failed: ${response.status}`);

                const data = await response.json();
                const seen = new Set();
                const articles = (data?.articles || []).filter(a => {
                    // Exclude current article
                    if (a.unique_id === this.getArticleUniqueId()) return false;
                    // Deduplicate by base URL (strip query params and hash)
                    const baseUrl = (a.url || '').split('?')[0].split('#')[0];
                    if (seen.has(baseUrl)) return false;
                    seen.add(baseUrl);
                    return true;
                }).slice(0, 5);

                pillElement.classList.remove('loading');
                this.showTagPopup(pillElement, tag, articles);
            } catch (error) {
                this.log('[Divee] Failed to fetch articles by tag:', error);
                pillElement.classList.remove('loading', 'active');
                this.state.activeTagPopup = null;
            }
        }

        showTagPopup(pillElement, tag, articles) {
            // Create popup element
            const popup = document.createElement('div');
            popup.className = 'divee-tag-popup';
            popup.setAttribute('data-type', tag.tag_type || 'category');

            // Inherit widget CSS custom properties
            const widgetEl = this.elements.container;
            if (widgetEl) {
                popup.style.setProperty('--divee-color-primary', getComputedStyle(widgetEl).getPropertyValue('--divee-color-primary'));
                popup.style.setProperty('--divee-color-secondary', getComputedStyle(widgetEl).getPropertyValue('--divee-color-secondary'));
            }

            const typeLabels = { category: 'Category', person: 'Person', place: 'Place' };

            const header = document.createElement('div');
            header.className = 'divee-tag-popup-header';
            header.innerHTML = `
                <div>
                    <div class="divee-tag-popup-tag-label">${typeLabels[tag.tag_type] || 'Topic'}</div>
                    <span class="divee-tag-popup-title">${this.escapeHtml(tag.value)}</span>
                </div>
                <button class="divee-tag-popup-close" aria-label="Close">✕</button>
            `;
            popup.appendChild(header);

            const articleList = document.createElement('div');
            articleList.className = 'divee-tag-popup-articles';

            if (articles.length === 0) {
                articleList.innerHTML = '<div class="divee-tag-popup-empty">No articles found</div>';
            } else {
                articles.forEach(article => {
                    const card = document.createElement('a');
                    card.className = 'divee-tag-popup-article';
                    card.href = article.url;
                    card.target = '_blank';
                    card.rel = 'noopener noreferrer';

                    const imgUrl = article.image_url || 'https://srv.divee.ai/storage/v1/object/public/public-files/placeholder.jpg';
                    let domain = '';
                    try { domain = new URL(article.url).hostname.replace('www.', ''); } catch (e) {}
                    card.innerHTML = `
                        <div class="divee-tag-popup-article-img">
                            <img src="${imgUrl}" alt="" loading="lazy" />
                        </div>
                        <div class="divee-tag-popup-article-info">
                            <div class="divee-tag-popup-article-title">${this.escapeHtml(article.title)}</div>
                            ${domain ? `<div class="divee-tag-popup-article-domain">${this.escapeHtml(domain)}</div>` : ''}
                        </div>
                        <span class="divee-tag-popup-article-arrow">›</span>
                    `;

                    card.addEventListener('click', () => {
                        this.trackEvent('tag_article_click', {
                            tag: tag.value,
                            clicked_article_id: article.unique_id,
                            source_article_id: this.getArticleUniqueId()
                        });
                    });

                    articleList.appendChild(card);
                });
            }

            popup.appendChild(articleList);

            // Close button handler
            popup.querySelector('.divee-tag-popup-close').addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeTagPopup();
            });

            // Position popup near the pill (opens upward, on body to avoid overflow clipping)
            document.body.appendChild(popup);

            const pillRect = pillElement.getBoundingClientRect();
            const popupRect = popup.getBoundingClientRect();
            const scrollTop = window.scrollY || document.documentElement.scrollTop;
            const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
            let topPos = pillRect.top + scrollTop - popupRect.height - 36;
            if (topPos - scrollTop < 0) topPos = pillRect.bottom + scrollTop + 6;
            let leftPos = pillRect.left + scrollLeft;
            if (pillRect.left + popupRect.width > window.innerWidth) {
                leftPos = scrollLeft + window.innerWidth - popupRect.width - 8;
            }
            popup.style.top = topPos + 'px';
            popup.style.left = leftPos + 'px';
            this._activeTagPopupElement = popup;

            // Close popup on click outside
            this._tagPopupOutsideClickHandler = (e) => {
                if (!popup.contains(e.target) && !pillElement.contains(e.target)) {
                    this.closeTagPopup();
                }
            };
            setTimeout(() => {
                document.addEventListener('click', this._tagPopupOutsideClickHandler, true);
            }, 0);
        }

        closeTagPopup() {
            // Remove active state from all pills
            const allPills = this.elements.container?.querySelectorAll('.divee-tag-pill.active');
            allPills?.forEach(p => p.classList.remove('active'));

            // Remove popup element from body
            if (this._activeTagPopupElement) {
                this._activeTagPopupElement.remove();
                this._activeTagPopupElement = null;
            }

            // Remove outside click handler
            if (this._tagPopupOutsideClickHandler) {
                document.removeEventListener('click', this._tagPopupOutsideClickHandler, true);
                this._tagPopupOutsideClickHandler = null;
            }

            this.state.activeTagPopup = null;
        }

        async fetchSuggestedArticle() {
            const payload = {
                projectId: this.config.projectId,
                currentUrl: this.contentCache.url,
                conversationId: this.state.conversationId
            };

            try {
                const response = await fetch(`${this.config.nonCacheBaseUrl}/suggested-articles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error(`Suggested articles request failed: ${response.status}`);
                }

                const data = await response.json();
                return data.suggestion || null;
            } catch (error) {
                console.error('[Divee] Failed to fetch suggested article:', error);
                return null;
            }
        }

        async showSuggestionCard() {
            const suggestion = await this.fetchSuggestedArticle();
            
            // Don't show card if no suggestions available
            if (!suggestion) return;

            const messagesContainer = this.elements.expandedView.querySelector('.divee-messages');
            const chatContainer = this.elements.expandedView.querySelector('.divee-chat');
            
            const cardId = `suggestion-${Date.now()}`;
            const card = this.createSuggestionCard(suggestion, cardId);
            messagesContainer.appendChild(card);
            
            // Scroll to bottom
            chatContainer.scrollTop = chatContainer.scrollHeight;

            // Track analytics
            this.trackEvent('suggestion_shown', {
                article_id: suggestion.unique_id,
                conversation_id: this.state.conversationId,
                position_in_chat: this.state.aiResponseCount
            });
        }

        createSuggestionCard(suggestion, cardId) {
            const card = document.createElement('div');
            card.className = 'divee-suggestion-card';
            card.setAttribute('data-card-id', cardId);
            card.setAttribute('role', 'link');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', `Suggested article: ${suggestion.title}`);

            const imageUrl = suggestion.image_url || 'https://srv.divee.ai/storage/v1/object/public/public-files/placeholder.jpg';
            
            card.innerHTML = `
                <button class="divee-suggestion-dismiss" aria-label="Dismiss suggestion">✕</button>
                <div class="divee-suggestion-image">
                    <img src="${imageUrl}" alt="${suggestion.title}" />
                </div>
                <div class="divee-suggestion-text">
                    <div class="divee-suggestion-label">DIVE DEEPER...</div>
                    <div class="divee-suggestion-title">${suggestion.title}</div>
                </div>
            `;

            // Handle card click (open article)
            card.addEventListener('click', (e) => {
                if (!e.target.closest('.divee-suggestion-dismiss')) {
                    this.trackEvent('suggestion_clicked', {
                        article_id: suggestion.unique_id,
                        conversation_id: this.state.conversationId,
                        position_in_chat: this.state.aiResponseCount
                    });
                    window.open(suggestion.url, '_blank');
                }
            });

            // Handle Enter/Space for accessibility
            card.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.divee-suggestion-dismiss')) {
                    e.preventDefault();
                    this.trackEvent('suggestion_clicked', {
                        article_id: suggestion.unique_id,
                        conversation_id: this.state.conversationId,
                        position_in_chat: this.state.aiResponseCount
                    });
                    window.open(suggestion.url, '_blank');
                }
            });

            // Handle dismiss button
            const dismissBtn = card.querySelector('.divee-suggestion-dismiss');
            dismissBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.trackEvent('suggestion_x_clicked', {
                    article_id: suggestion.unique_id,
                    conversation_id: this.state.conversationId,
                    position_in_chat: this.state.aiResponseCount
                });
                this.showDismissalConfirmation(card, cardId, suggestion);
            });

            return card;
        }

        showDismissalConfirmation(card, cardId, suggestion) {
            // Transform card to confirmation state
            card.classList.add('divee-suggestion-dismissing');
            card.innerHTML = `
                <div class="divee-suggestion-confirm">
                    <div class="divee-suggestion-confirm-title">Don't show suggestions in this chat?</div>
                    <div class="divee-suggestion-confirm-subtitle">(You'll miss related articles)</div>
                    <div class="divee-suggestion-confirm-actions">
                        <button class="divee-btn-ghost divee-cancel-dismiss">Cancel</button>
                        <button class="divee-btn-primary divee-confirm-dismiss">Yes, hide them</button>
                    </div>
                </div>
            `;

            // Handle cancel
            const cancelBtn = card.querySelector('.divee-cancel-dismiss');
            cancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.trackEvent('suggestion_dismissed_cancelled', {
                    article_id: suggestion.unique_id,
                    conversation_id: this.state.conversationId
                });
                // Remove the card
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 200);
            });

            // Handle confirm
            const confirmBtn = card.querySelector('.divee-confirm-dismiss');
            confirmBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.trackEvent('suggestion_dismissed_confirmed', {
                    article_id: suggestion.unique_id,
                    conversation_id: this.state.conversationId
                });
                this.suppressSuggestions();
                // Remove the card
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 200);
            });
        }

        autoResizeTextarea(textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
        }

        updateCharacterCounter(textarea) {
            const counter = this.elements.expandedView.querySelector('.divee-counter');
            if (counter) {
                const length = textarea.value.length;
                counter.textContent = `${length}/200`;
            }
        }

        setupAdClickTracking(adElement, slotId, eventData) {
            const self = this;
            
            // Track clicks on the ad container
            adElement.addEventListener('click', () => {
                // Click detected - event tracking happens in analytics
            });
            
            // Also track clicks on any links inside the ad
            setTimeout(() => {
                const iframe = adElement.querySelector('iframe');
                if (iframe) {
                    iframe.addEventListener('load', () => {
                        // Iframe loaded
                    });
                }
            }, 100);
        }

        trackEvent(eventName, data = {}) {
            this.log('[Divee Analytics]', eventName, data);

            // Update session tracking interaction state
            this.recordSessionEvent(eventName);
            
            // Get visitor and session IDs from state (already initialized in init())
            const visitorId = this.state.visitorId;
            const sessionId = this.state.sessionId;
            const projectId = this.config.projectId;
            
            if (!projectId) {
                console.warn('[Divee Analytics] No project ID available for tracking');
                return;
            }
            
            if (!visitorId || !sessionId) {
                console.warn('[Divee Analytics] Missing visitor or session IDs');
                return;
            }
            
            // Prepare event payload
            const articleUrl = window.location.origin + window.location.pathname;
            const event = {
                project_id: projectId,
                visitor_id: visitorId,
                session_id: sessionId,
                event_type: eventName,
                event_label: data.label || null,
                article_url: articleUrl,
                event_data: data,
                timestamp: Date.now()
            };
            
            // Check if this event should be sent immediately
            if (this.analyticsConfig.immediateEvents.includes(eventName)) {
                this.sendAnalyticsBatch([event]);
                return;
            }
            
            // Add to queue
            this.analyticsQueue.push(event);
            this.log('[Divee Analytics] Queued event, queue size:', this.analyticsQueue.length);
            
            // Flush if queue is full
            if (this.analyticsQueue.length >= this.analyticsConfig.maxBatchSize) {
                this.flushAnalytics();
                return;
            }
            
            // Reset flush timer
            this.scheduleAnalyticsFlush();
        }

        scheduleAnalyticsFlush() {
            // Clear existing timer
            if (this.analyticsFlushTimer) {
                clearTimeout(this.analyticsFlushTimer);
            }
            
            // Set new timer
            this.analyticsFlushTimer = setTimeout(() => {
                this.flushAnalytics();
            }, this.analyticsConfig.flushInterval);
        }

        flushAnalytics() {
            // Clear timer
            if (this.analyticsFlushTimer) {
                clearTimeout(this.analyticsFlushTimer);
                this.analyticsFlushTimer = null;
            }
            
            // Nothing to flush
            if (this.analyticsQueue.length === 0) {
                return;
            }
            
            // Get events and clear queue
            const events = [...this.analyticsQueue];
            this.analyticsQueue = [];
            
            this.log('[Divee Analytics] Flushing batch of', events.length, 'events');
            this.sendAnalyticsBatch(events);
        }

        sendAnalyticsBatch(events) {
            if (events.length === 0) return;
            
            try {
                const endpoint = `${this.config.analyticsBaseUrl}/analytics`;
                this.log('[Divee Analytics] Sending to:', endpoint);

                const payload = events.length === 1 ? events[0] : { batch: events };
                
                fetch(endpoint, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload),
                    keepalive: true
                }).catch(err => {
                    console.error('[Divee Analytics] Failed to send batch:', err);
                });
            } catch (err) {
                console.error('[Divee Analytics] Error sending batch:', err);
            }
        }

        setupVisibilityTracking() {
            // Track when widget becomes visible in viewport (fires once per session)
            if (!this.elements.container || this.state.widgetVisibleTracked) {
                return;
            }

            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting && !this.state.widgetVisibleTracked) {
                        this.state.widgetVisibleTracked = true;
                        
                        this.trackEvent('widget_visible', {
                            url: this.contentCache.url || window.location.href,
                            display_mode: this.config.displayMode,
                            viewport_width: window.innerWidth,
                            viewport_height: window.innerHeight
                        });
                        
                        this.log('Widget visible event fired');
                        
                        // Disconnect observer after firing once
                        observer.disconnect();
                    }
                });
            }, {
                threshold: 0.5  // Fire when 50% of widget is visible
            });

            observer.observe(this.elements.container);
        }

        setupPageUnloadFlush() {
            // Flush analytics on page unload
            const flushOnUnload = () => {
                // Stop ad auto-refresh
                this.stopAdAutoRefresh();

                if (this.analyticsQueue.length > 0) {
                    const events = [...this.analyticsQueue];
                    this.analyticsQueue = [];
                    
                    // Use sendBeacon for reliable delivery on page unload
                    const endpoint = `${this.config.analyticsBaseUrl}/analytics`;
                    const payload = events.length === 1 ? events[0] : { batch: events };
                    
                    if (navigator.sendBeacon) {
                        // Use text/plain to avoid CORS preflight.
                        // The server reads the raw body with req.text() + JSON.parse(),
                        // so Content-Type doesn't matter for parsing.
                        const blob = new Blob([JSON.stringify(payload)], { type: 'text/plain' });
                        navigator.sendBeacon(endpoint, blob);
                    } else {
                        // Fallback to sync XHR (blocking but reliable)
                        const xhr = new XMLHttpRequest();
                        xhr.open('POST', endpoint, false);
                        xhr.setRequestHeader('Content-Type', 'application/json');
                        xhr.send(JSON.stringify(payload));
                    }
                }
            };
            
            window.addEventListener('pagehide', flushOnUnload);
            window.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    flushOnUnload();
                }
            });
        }
    }

    // Global debug API — accessible from the browser console as window.divee
    const diveeInstances = [];
    window.divee = {
        article: function (index) {
            const widget = diveeInstances[index || 0];
            if (!widget) { console.warn('[Divee] No widget instance found'); return; }
            console.group('[Divee] Article');
            console.log('Title:  ', widget.contentCache.title);
            console.log('URL:    ', widget.contentCache.url);
            console.log('Content:', widget.contentCache.content);
            console.log('Images: ', { og_image: widget.contentCache.og_image, article_image: widget.contentCache.image_url });
            console.groupEnd();
        },
        config: function (index) {
            const widget = diveeInstances[index || 0];
            if (!widget) { console.warn('[Divee] No widget instance found'); return; }
            console.group('[Divee] Config');
            console.log('Client config:', widget.config);
            console.log('Server config:', widget.state.serverConfig);
            console.log('State:        ', widget.state);
            console.groupEnd();
        },
        instances: function () { return diveeInstances; }
    };

    // Auto-initialize from script tag
    function autoInit() {
        const scripts = document.querySelectorAll('script[data-project-id]');
        const urlParams = new URLSearchParams(window.location.search);
        const isDebug = urlParams.get('diveeDebug') === 'true';

        scripts.forEach((script, index) => {
            const config = {
                projectId: script.getAttribute('data-project-id'),
                cachedBaseUrl: "https://cdn.divee.ai/functions/v1",
                nonCacheBaseUrl: "https://srv.divee.ai/functions/v1",
                analyticsBaseUrl: "https://analytic.divee.ai/functions/v1",
                attentionAnimation: script.getAttribute('data-attention-animation') !== 'false'
            };

            // Show deprecation warnings if data attributes are used
            if (isDebug) {
                const deprecated = [
                    { attr: 'data-display-mode', msg: 'Use display_mode in project settings' },
                    { attr: 'data-floating-position', msg: 'Use display_position in project settings' },
                    { attr: 'data-article-class', msg: 'Use article_class in project settings' },
                    { attr: 'data-container-selector', msg: 'Use widget_container_class in project settings' }
                ].filter(d => script.getAttribute(d.attr));
                
                if (deprecated.length > 0) {
                    console.warn('[Divee] Deprecated attributes:', deprecated.map(d => d.attr).join(', '));
                }
                console.log(`[Divee] Auto-init [${index}]:`, config);
            }
            const instance = new DiveeWidget(config);
            diveeInstances.push(instance);
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }

    // Expose for manual initialization
    window.DiveeWidget = DiveeWidget;

})();
