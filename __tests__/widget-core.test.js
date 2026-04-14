/**
 * Widget Core Functionality Tests
 * Tests for widget.js initialization and core methods
 */

const { describe, test, expect, beforeEach } = require('@jest/globals');

describe('DiveeWidget Core', () => {
  let mockConfig;
  
  beforeEach(() => {
    // Clear DOM
    document.body.innerHTML = '';

    // Reset localStorage and sessionStorage
    localStorage.clear();
    sessionStorage.clear();
    // Reset singleton guard so each test can re-eval the widget script
    delete window.__diveeWidgetLoaded;
    
    // Mock config
    mockConfig = {
      projectId: 'test-project-123',
      nonCacheBaseUrl: 'https://api.test.com'
    };
    
    // Mock fetch responses
    fetch.mockClear();
  });

  describe('UUID Generation', () => {
    test('should generate valid UUID', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      const uuid = widget.generateUUID();
      
      // In test environment, crypto.randomUUID is mocked
      expect(uuid).toBeTruthy();
      expect(typeof uuid).toBe('string');
      expect(uuid.length).toBeGreaterThan(0);
      
      expect(crypto.randomUUID).toHaveBeenCalled();
      expect(uuid).toBe('test-uuid-1234-5678-90ab-cdef');
    });
  });

  describe('Analytics IDs', () => {
    test.skip('should generate and store visitor ID in localStorage', () => {
      // Skipped: localStorage mock inside eval doesn't work properly
      // Test this in E2E tests where real storage is available
      localStorage.getItem.mockReturnValueOnce(null);
      
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      const { visitorId } = widget.getAnalyticsIds();
      
      expect(visitorId).toBe('test-uuid-1234-5678-90ab-cdef');
      expect(localStorage.setItem).toHaveBeenCalledWith('divee_visitor_id', visitorId);
    });

    test.skip('should reuse existing visitor ID from localStorage', () => {
      // Skipped: localStorage mock inside eval doesn't work properly
      // Test this in E2E tests where real storage is available
      const existingId = 'existing-visitor-id';
      localStorage.getItem.mockReturnValueOnce(existingId);
      
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      const { visitorId } = widget.getAnalyticsIds();
      
      expect(visitorId).toBe(existingId);
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });

    test.skip('should generate and store session ID in sessionStorage', () => {
      // Skipped: sessionStorage mock inside eval doesn't work properly
      // Test this in E2E tests where real storage is available
      localStorage.getItem.mockReturnValueOnce('visitor-id');
      sessionStorage.getItem.mockReturnValueOnce(null);
      
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      const { sessionId } = widget.getAnalyticsIds();
      
      expect(sessionId).toBe('test-uuid-1234-5678-90ab-cdef');
      expect(sessionStorage.setItem).toHaveBeenCalledWith('divee_session_id', sessionId);
    });

    test.skip('should reuse existing session ID from sessionStorage', () => {
      // Skipped: sessionStorage mock inside eval doesn't work properly
      // Test this in E2E tests where real storage is available
      const existingId = 'existing-session-id';
      localStorage.getItem.mockReturnValueOnce('visitor-id');
      sessionStorage.getItem.mockReturnValueOnce(existingId);
      
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      const { sessionId } = widget.getAnalyticsIds();
      
      expect(sessionId).toBe(existingId);
      expect(sessionStorage.setItem).not.toHaveBeenCalled();
    });
  });

  describe('Debug Mode', () => {
    test.skip('should detect debug mode from URL parameter', () => {
      // Skipped: jsdom doesn't support window.location reassignment
      // This functionality is tested in E2E tests
      const originalLocation = window.location;
      delete window.location;
      window.location = {
        ...originalLocation,
        search: '?diveeDebug=true'
      };
      
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      expect(widget.isDebugMode()).toBe(true);
      
      // Restore
      window.location = originalLocation;
    });

    test('should not be in debug mode without parameter', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      expect(widget.isDebugMode()).toBe(false);
    });
  });

  describe('Configuration', () => {
    test('should use provided nonCacheBaseUrl', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      expect(widget.config.nonCacheBaseUrl).toBe('https://api.test.com');
    });

    test('should use default nonCacheBaseUrl if not provided', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget({ projectId: 'test' });
      expect(widget.config.nonCacheBaseUrl).toBe('https://srv.divee.ai/functions/v1');
    });

    test('should have default display mode as anchored', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      expect(widget.config.displayMode).toBe('anchored');
    });

    test('should have default floating position as bottom-right', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      expect(widget.config.floatingPosition).toBe('bottom-right');
    });
  });

  describe('Visitor Token Storage (C-2)', () => {
    test('should initialise visitorToken state as null when no token in localStorage', () => {
      // localStorage.getItem returns null by default (jsdom)
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);

      const widget = new DiveeWidget(mockConfig);
      widget.getAnalyticsIds();

      // No stored token — state should be falsy
      expect(widget.state.visitorToken).toBeFalsy();
    });

    test('should restore visitorToken from localStorage on getAnalyticsIds', () => {
      const storedToken = 'visitor-abc|proj-123|9999999999999|cafebabe';
      // Consent must be granted for the widget to read persisted visitor data
      localStorage.setItem('divee_consent', 'granted');
      localStorage.setItem('divee_visitor_token', storedToken);

      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);

      const widget = new DiveeWidget(mockConfig);
      widget.getAnalyticsIds();

      expect(widget.state.visitorToken).toBe(storedToken);
    });

    test('should NOT read visitorToken from localStorage when consent not granted', () => {
      // Token present in localStorage but no consent — widget must ignore it
      localStorage.setItem('divee_visitor_token', 'leaked-token');

      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);

      const widget = new DiveeWidget(mockConfig);
      widget.getAnalyticsIds();

      expect(widget.state.visitorToken).toBeFalsy();
    });
  });

  describe('Cookie Consent', () => {
    const loadWidget = () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      return new DiveeWidget(mockConfig);
    };

    test('initial consent is null when nothing stored', () => {
      const widget = loadWidget();
      expect(widget.state.consent).toBeNull();
    });

    test('initial consent restored from localStorage when previously granted', () => {
      localStorage.setItem('divee_consent', 'granted');
      const widget = loadWidget();
      expect(widget.state.consent).toBe('granted');
    });

    test('previously declined consent does NOT persist across page loads', () => {
      // Simulate a prior decline (which by contract never wrote anything)
      const widget = loadWidget();
      expect(widget.state.consent).toBeNull();
    });

    test('storageSet writes to memory only when consent is null', () => {
      const widget = loadWidget();
      widget.storageSet('divee_visitor_id', 'mem-id');
      expect(widget._memStore.divee_visitor_id).toBe('mem-id');
      expect(localStorage.getItem('divee_visitor_id')).toBeNull();
    });

    test('storageSet writes to memory only when consent is denied', () => {
      const widget = loadWidget();
      widget.state.consent = 'denied';
      widget.storageSet('divee_visitor_id', 'mem-id');
      expect(widget._memStore.divee_visitor_id).toBe('mem-id');
      expect(localStorage.getItem('divee_visitor_id')).toBeNull();
    });

    test('storageSet writes to localStorage when consent is granted', () => {
      localStorage.setItem('divee_consent', 'granted');
      const widget = loadWidget();
      widget.storageSet('divee_visitor_id', 'persisted-id');
      expect(localStorage.getItem('divee_visitor_id')).toBe('persisted-id');
      expect(widget._memStore.divee_visitor_id).toBe('persisted-id');
    });

    test('storageGet prefers memory over localStorage', () => {
      localStorage.setItem('divee_consent', 'granted');
      localStorage.setItem('divee_visitor_id', 'from-ls');
      const widget = loadWidget();
      widget._memStore.divee_visitor_id = 'from-mem';
      expect(widget.storageGet('divee_visitor_id')).toBe('from-mem');
    });

    test('storageGet ignores localStorage when consent not granted', () => {
      // Use a key the widget itself never touches, so memStore stays empty
      localStorage.setItem('divee_unrelated_key', 'leaked-value');
      const widget = loadWidget();
      expect(widget.storageGet('divee_unrelated_key')).toBeNull();
    });

    test('getAnalyticsIds persists newly-minted visitor ID when consent granted', () => {
      localStorage.setItem('divee_consent', 'granted');
      const widget = loadWidget();
      widget.getAnalyticsIds();
      expect(localStorage.getItem('divee_visitor_id')).toBe(widget.state.visitorId);
    });

    test('getAnalyticsIds keeps visitor ID in memory only when consent denied', () => {
      const widget = loadWidget();
      widget.state.consent = 'denied';
      widget.getAnalyticsIds();
      expect(widget.state.visitorId).toBeTruthy();
      expect(localStorage.getItem('divee_visitor_id')).toBeNull();
      expect(widget._memStore.divee_visitor_id).toBe(widget.state.visitorId);
    });

    test('maybeShowConsent is a no-op when ask_concent is false', () => {
      const widget = loadWidget();
      widget.state.serverConfig = { ask_concent: false };
      widget.elements.expandedView = document.createElement('div');
      widget.elements.expandedView.innerHTML = '<div class="divee-consent" style="display:none;"></div>';
      widget.maybeShowConsent();
      const consentEl = widget.elements.expandedView.querySelector('.divee-consent');
      expect(consentEl.style.display).toBe('none');
    });

    test('maybeShowConsent shows banner when ask_concent=true and undecided', () => {
      const widget = loadWidget();
      widget.state.serverConfig = { ask_concent: true };
      widget.elements.expandedView = document.createElement('div');
      widget.elements.expandedView.innerHTML = '<div class="divee-consent" style="display:none;"></div>';
      widget.maybeShowConsent();
      const consentEl = widget.elements.expandedView.querySelector('.divee-consent');
      expect(consentEl.style.display).toBe('flex');
    });

    test('maybeShowConsent does not reshow when already decided', () => {
      const widget = loadWidget();
      widget.state.serverConfig = { ask_concent: true };
      widget.state.consent = 'denied';
      widget.elements.expandedView = document.createElement('div');
      widget.elements.expandedView.innerHTML = '<div class="divee-consent" style="display:none;"></div>';
      widget.maybeShowConsent();
      const consentEl = widget.elements.expandedView.querySelector('.divee-consent');
      expect(consentEl.style.display).toBe('none');
    });

    test('handleConsent(true) persists consent and flushes memory store', () => {
      const widget = loadWidget();
      widget.elements.expandedView = document.createElement('div');
      widget.elements.expandedView.innerHTML = '<div class="divee-consent" style="display:flex;"></div>';
      widget.trackEvent = jest.fn();
      widget._memStore.divee_visitor_id = 'mem-id';
      widget._memStore.divee_visitor_token = 'mem-token';

      widget.handleConsent(true);

      expect(widget.state.consent).toBe('granted');
      expect(localStorage.getItem('divee_consent')).toBe('granted');
      expect(localStorage.getItem('divee_visitor_id')).toBe('mem-id');
      expect(localStorage.getItem('divee_visitor_token')).toBe('mem-token');
      expect(widget.elements.expandedView.querySelector('.divee-consent').style.display).toBe('none');
      expect(widget.trackEvent).toHaveBeenCalledWith('consent_decision', { accepted: true });
    });

    test('handleConsent(false) keeps values in memory only', () => {
      const widget = loadWidget();
      widget.elements.expandedView = document.createElement('div');
      widget.elements.expandedView.innerHTML = '<div class="divee-consent" style="display:flex;"></div>';
      widget.trackEvent = jest.fn();
      widget._memStore.divee_visitor_id = 'mem-id';

      widget.handleConsent(false);

      expect(widget.state.consent).toBe('denied');
      expect(localStorage.getItem('divee_consent')).toBeNull();
      expect(localStorage.getItem('divee_visitor_id')).toBeNull();
      expect(widget._memStore.divee_visitor_id).toBe('mem-id');
      expect(widget.elements.expandedView.querySelector('.divee-consent').style.display).toBe('none');
      expect(widget.trackEvent).toHaveBeenCalledWith('consent_decision', { accepted: false });
    });

    test('after granting consent, subsequent storageSet writes to localStorage', () => {
      const widget = loadWidget();
      widget.elements.expandedView = document.createElement('div');
      widget.elements.expandedView.innerHTML = '<div class="divee-consent"></div>';
      widget.trackEvent = jest.fn();

      widget.storageSet('divee_visitor_token', 'tok-1');
      expect(localStorage.getItem('divee_visitor_token')).toBeNull();

      widget.handleConsent(true);

      widget.storageSet('divee_visitor_token', 'tok-2');
      expect(localStorage.getItem('divee_visitor_token')).toBe('tok-2');
    });
  });

  describe('Default Config', () => {
    test('should return valid default config', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      const defaultConfig = widget.getDefaultConfig();
      
      expect(defaultConfig).toHaveProperty('direction', 'ltr');
      expect(defaultConfig).toHaveProperty('language', 'en');
      expect(defaultConfig).toHaveProperty('show_ad', true);
      expect(defaultConfig.input_text_placeholders).toBeInstanceOf(Array);
      expect(defaultConfig.highlight_color).toBeInstanceOf(Array);
    });
  });

  describe('Content Caching', () => {
    test.skip('should cache extracted content', () => {
      // Skipped: Content extraction doesn't work properly in jsdom
      // Test this in E2E tests instead
      document.body.innerHTML = `
        <article>
          <h1>Test Article</h1>
          <p>This is test content that should be cached properly.</p>
        </article>
      `;
      
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      const contentJs = require('fs').readFileSync('./src/content.js', 'utf8');
      eval(contentJs);
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      widget.extractArticleContent();
      
      expect(widget.contentCache.extracted).toBe(true);
      expect(widget.contentCache.content).toBeTruthy();
      expect(widget.contentCache.title).toBeTruthy();
      expect(widget.contentCache.url).toBeTruthy();
    });

    test('should use cached content on subsequent calls', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      
      // Set cached content
      widget.contentCache = {
        content: 'Cached content',
        title: 'Cached title',
        url: 'https://cached.com',
        extracted: true
      };
      
      // Call extract again
      widget.extractArticleContent();
      
      // Should use cached values
      expect(widget.articleTitle).toBe('Cached title');
      expect(widget.articleContent).toBe('Cached content');
    });
  });

  describe('State Management', () => {
    test('should initialize with collapsed state', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      expect(widget.state.isExpanded).toBe(false);
    });

    test('should initialize with empty messages', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      expect(widget.state.messages).toEqual([]);
    });

    test('should initialize with empty suggestions', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      expect(widget.state.suggestions).toEqual([]);
    });

    test('should not be streaming initially', () => {
      const widgetJs = require('fs').readFileSync('./src/widget.js', 'utf8');
      eval(widgetJs);
      
      const widget = new DiveeWidget(mockConfig);
      expect(widget.state.isStreaming).toBe(false);
    });
  });
});
