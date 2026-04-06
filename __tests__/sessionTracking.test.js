/**
 * Session Tracking Tests
 * Tests for session tracking heartbeat, interaction tracking, and beacon logic
 */

const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');

describe('Session Tracking', () => {
  let DiveeWidget;

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    fetch.mockClear();
    delete window.__diveeWidgetLoaded;
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ show_ad: false })
    });

    // Mock navigator.sendBeacon
    navigator.sendBeacon = jest.fn(() => true);

    const widgetJs = fs.readFileSync('./src/widget.js', 'utf8');
    eval(widgetJs);
    DiveeWidget = window.DiveeWidget;
  });

  function createWidget(overrides = {}) {
    const config = {
      projectId: 'test-project-123',
      nonCacheBaseUrl: 'https://api.test.com',
      analyticsBaseUrl: 'https://analytic.test.com',
      ...overrides
    };
    return new DiveeWidget(config);
  }

  describe('getOrCreateSessionTrackingId', () => {
    test('should create a new session tracking ID if none exists', () => {
      const widget = createWidget();
      const id = widget.getOrCreateSessionTrackingId();
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      // Verify it was stored in sessionStorage
      expect(sessionStorage.getItem('divee_session_tracking_id')).toBe(id);
    });

    test('should reuse existing session tracking ID from sessionStorage', () => {
      sessionStorage.setItem('divee_session_tracking_id', 'existing-session-id');

      const widget = createWidget();
      const id = widget.getOrCreateSessionTrackingId();
      expect(id).toBe('existing-session-id');
    });

    test('should return the same ID on repeated calls', () => {
      const widget = createWidget();
      const id1 = widget.getOrCreateSessionTrackingId();
      const id2 = widget.getOrCreateSessionTrackingId();
      expect(id1).toBe(id2);
    });
  });

  describe('recordSessionEvent', () => {
    test('should set interaction for widget_expanded', () => {
      const widget = createWidget();
      widget.recordSessionEvent('widget_expanded');

      expect(widget.sessionTracking.hasInteracted).toBe(true);
      expect(widget.sessionTracking.interactionType).toBe('divee_opened');
    });

    test('should set interaction for open_chat', () => {
      const widget = createWidget();
      widget.recordSessionEvent('open_chat');

      expect(widget.sessionTracking.hasInteracted).toBe(true);
      expect(widget.sessionTracking.interactionType).toBe('divee_opened');
    });

    test('should advance interaction type from divee_opened to suggestions_received', () => {
      const widget = createWidget();
      widget.recordSessionEvent('widget_expanded');
      expect(widget.sessionTracking.interactionType).toBe('divee_opened');

      widget.recordSessionEvent('suggestions_fetched');
      expect(widget.sessionTracking.interactionType).toBe('suggestions_received');
    });

    test('should advance interaction type to question_asked', () => {
      const widget = createWidget();
      widget.recordSessionEvent('widget_expanded');
      widget.recordSessionEvent('suggestions_fetched');
      widget.recordSessionEvent('custom_question_asked');

      expect(widget.sessionTracking.interactionType).toBe('question_asked');
    });

    test('should not regress interaction type', () => {
      const widget = createWidget();
      widget.recordSessionEvent('custom_question_asked');
      expect(widget.sessionTracking.interactionType).toBe('question_asked');

      // Attempt to regress to a lower tier
      widget.recordSessionEvent('widget_expanded');
      expect(widget.sessionTracking.interactionType).toBe('question_asked');

      widget.recordSessionEvent('suggestions_fetched');
      expect(widget.sessionTracking.interactionType).toBe('question_asked');
    });

    test('should ignore non-interaction events', () => {
      const widget = createWidget();
      widget.recordSessionEvent('widget_loaded');
      widget.recordSessionEvent('impression');
      widget.recordSessionEvent('widget_visible');
      widget.recordSessionEvent('ad_impression');

      expect(widget.sessionTracking.hasInteracted).toBe(false);
      expect(widget.sessionTracking.interactionType).toBeNull();
    });

    test('should send immediate heartbeat when interaction advances', () => {
      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';
      navigator.sendBeacon.mockClear();

      widget.recordSessionEvent('widget_expanded');

      expect(navigator.sendBeacon).toHaveBeenCalledWith(
        'https://analytic.test.com/analytics',
        expect.any(Blob)
      );
    });

    test('should not send heartbeat when interaction does not advance', () => {
      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';

      widget.recordSessionEvent('custom_question_asked');
      navigator.sendBeacon.mockClear();

      // Lower tier should not trigger a heartbeat
      widget.recordSessionEvent('widget_expanded');

      // sendBeacon should not have been called again
      expect(navigator.sendBeacon).not.toHaveBeenCalled();
    });

    test('should handle all question event types', () => {
      const questionEvents = [
        'question_asked',
        'ask_question',
        'suggestion_question_asked',
        'custom_question_asked'
      ];

      questionEvents.forEach(eventType => {
        const widget = createWidget();
        widget.recordSessionEvent(eventType);
        expect(widget.sessionTracking.interactionType).toBe('question_asked');
        expect(widget.sessionTracking.hasInteracted).toBe(true);
      });
    });

    test('should handle get_suggestions event', () => {
      const widget = createWidget();
      widget.recordSessionEvent('get_suggestions');

      expect(widget.sessionTracking.hasInteracted).toBe(true);
      expect(widget.sessionTracking.interactionType).toBe('suggestions_received');
    });
  });

  describe('computeSessionTotals', () => {
    test('should compute elapsed_seconds from startedAt', () => {
      const widget = createWidget();
      const now = Date.now();
      widget.sessionTracking.startedAt = now - 10000; // 10 seconds ago
      widget.sessionTracking.activeStart = now - 10000;

      const totals = widget.computeSessionTotals();
      expect(totals.elapsed_seconds).toBeGreaterThanOrEqual(10);
      expect(totals.active_seconds).toBeGreaterThanOrEqual(10);
    });

    test('should not count active time when tab is hidden (activeStart is null)', () => {
      const widget = createWidget();
      const now = Date.now();
      widget.sessionTracking.startedAt = now - 30000;
      widget.sessionTracking.accumulatedActiveMs = 10000; // 10s active before hidden
      widget.sessionTracking.activeStart = null; // tab is hidden

      const totals = widget.computeSessionTotals();
      expect(totals.elapsed_seconds).toBeGreaterThanOrEqual(30);
      expect(totals.active_seconds).toBe(10); // only accumulated time
    });

    test('should add accumulated time to current active time', () => {
      const widget = createWidget();
      const now = Date.now();
      widget.sessionTracking.startedAt = now - 20000;
      widget.sessionTracking.accumulatedActiveMs = 5000;
      widget.sessionTracking.activeStart = now - 3000;

      const totals = widget.computeSessionTotals();
      expect(totals.active_seconds).toBeGreaterThanOrEqual(8); // 5s + 3s
      expect(totals.active_seconds).toBeLessThanOrEqual(9);
    });
  });

  describe('buildSessionPayload', () => {
    test('should include all required fields', () => {
      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';
      widget.sessionTracking.startedAt = Date.now() - 5000;

      const payload = widget.buildSessionPayload();
      expect(payload).toHaveProperty('project_id', 'test-project-123');
      expect(payload).toHaveProperty('session_id');
      expect(payload).toHaveProperty('visitor_id', 'visitor-123');
      expect(payload).toHaveProperty('active_seconds');
      expect(payload).toHaveProperty('elapsed_seconds');
      expect(payload).toHaveProperty('interaction_with_divee', false);
      expect(typeof payload.session_id).toBe('string');
    });

    test('should include interaction_type when set', () => {
      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';
      widget.recordSessionEvent('widget_expanded');

      const payload = widget.buildSessionPayload();
      expect(payload.interaction_with_divee).toBe(true);
      expect(payload.interaction_type).toBe('divee_opened');
    });

    test('should omit interaction_type when no interaction', () => {
      const widget = createWidget();
      const payload = widget.buildSessionPayload();
      expect(payload).not.toHaveProperty('interaction_type');
    });

    test('should handle null visitorId', () => {
      const widget = createWidget();
      widget.state.visitorId = null;

      const payload = widget.buildSessionPayload();
      expect(payload.visitor_id).toBeNull();
    });
  });

  describe('sendSessionHeartbeat', () => {
    test('should send session payload via sendBeacon', () => {
      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';
      navigator.sendBeacon.mockClear();

      widget.sendSessionHeartbeat();

      expect(navigator.sendBeacon).toHaveBeenCalledWith(
        'https://analytic.test.com/analytics',
        expect.any(Blob)
      );
    });
  });

  describe('sendSessionBeacon', () => {
    test('should use navigator.sendBeacon', () => {
      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';

      widget.sendSessionBeacon();

      expect(navigator.sendBeacon).toHaveBeenCalledWith(
        'https://analytic.test.com/analytics',
        expect.any(Blob)
      );
    });

    test('should fall back to XHR if sendBeacon is not available', () => {
      const origSendBeacon = navigator.sendBeacon;
      navigator.sendBeacon = undefined;

      const mockXHR = {
        open: jest.fn(),
        setRequestHeader: jest.fn(),
        send: jest.fn()
      };
      const origXMLHttpRequest = global.XMLHttpRequest;
      global.XMLHttpRequest = jest.fn(() => mockXHR);

      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';
      widget.sendSessionBeacon();

      expect(mockXHR.open).toHaveBeenCalledWith('POST', 'https://analytic.test.com/analytics', false);
      expect(mockXHR.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(mockXHR.send).toHaveBeenCalled();

      navigator.sendBeacon = origSendBeacon;
      global.XMLHttpRequest = origXMLHttpRequest;
    });
  });

  describe('trackEvent integration', () => {
    test('should update session tracking when trackEvent is called with interaction event', () => {
      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';
      widget.state.sessionId = 'session-456';

      widget.trackEvent('widget_expanded', { trigger: 'click' });

      expect(widget.sessionTracking.hasInteracted).toBe(true);
      expect(widget.sessionTracking.interactionType).toBe('divee_opened');
    });

    test('should not update session tracking for non-interaction events', () => {
      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';
      widget.state.sessionId = 'session-456';

      widget.trackEvent('widget_loaded', {});

      expect(widget.sessionTracking.hasInteracted).toBe(false);
      expect(widget.sessionTracking.interactionType).toBeNull();
    });
  });

  describe('initSessionTracking', () => {
    test('should set up heartbeat timers', () => {
      jest.useFakeTimers();

      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';

      // Clear any calls from constructor
      navigator.sendBeacon.mockClear();

      widget.sessionTracking.timers = [];
      widget.sessionTracking.interval = null;
      widget.initSessionTracking();

      expect(widget.sessionTracking.timers.length).toBeGreaterThan(0);

      // Advance past first heartbeat at 5s
      jest.advanceTimersByTime(5000);
      expect(navigator.sendBeacon).toHaveBeenCalledWith(
        'https://analytic.test.com/analytics',
        expect.any(Blob)
      );

      jest.useRealTimers();
    });

    test('should send beacon on visibility hidden', () => {
      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';
      navigator.sendBeacon.mockClear();

      // Simulate tab becoming hidden
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(navigator.sendBeacon).toHaveBeenCalled();

      // Restore
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true
      });
    });

    test('should pause active timer when tab is hidden and resume when visible', () => {
      const widget = createWidget();
      const now = Date.now();
      widget.sessionTracking.startedAt = now;
      widget.sessionTracking.activeStart = now;
      widget.sessionTracking.accumulatedActiveMs = 0;

      // Manually set up the visibility listener (init is async so may not have run)
      widget.initSessionTracking();

      // Simulate tab hidden
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(widget.sessionTracking.activeStart).toBeNull();
      expect(widget.sessionTracking.accumulatedActiveMs).toBeGreaterThanOrEqual(0);

      // Simulate tab visible again
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(widget.sessionTracking.activeStart).not.toBeNull();
    });
  });

  describe('cleanupSessionTracking', () => {
    test('should clear all timers and send final heartbeat', () => {
      jest.useFakeTimers();

      const widget = createWidget();
      widget.state.visitorId = 'visitor-123';
      navigator.sendBeacon.mockClear();

      widget.cleanupSessionTracking();

      // Should send final heartbeat via sendBeacon
      expect(navigator.sendBeacon).toHaveBeenCalledWith(
        'https://analytic.test.com/analytics',
        expect.any(Blob)
      );

      jest.useRealTimers();
    });
  });
});
