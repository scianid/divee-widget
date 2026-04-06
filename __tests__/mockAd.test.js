/**
 * Mock Ad Feature Tests
 * Tests for diveeMockAd=true URL param behavior:
 * - isMockAdRequested() detects the URL param correctly
 * - Mock ad GIF is rendered when ads are OFF in config AND param is true
 * - Mock ad is NOT shown when ads are ON in config (even with param)
 * - Mock ad is NOT shown when param is absent (even when ads are off)
 */

const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');

const widgetJs = fs.readFileSync('./src/widget.js', 'utf8');

const MOCK_AD_URL = 'https://srv.divee.ai/storage/v1/object/public/public-files/fake-ad.gif';

const OriginalURLSearchParams = global.URLSearchParams;

// Helper: mock URLSearchParams to simulate specific search params
function mockURLSearchParams(params) {
  global.URLSearchParams = jest.fn().mockImplementation(() => ({
    get: jest.fn((key) => params[key] ?? null),
  }));
}

function restoreURLSearchParams() {
  global.URLSearchParams = OriginalURLSearchParams;
}

// Helper: create a widget instance. The constructor calls async init() but we
// don't await it — the widget DOM is built manually via createWidget().
function makeWidget(serverConfig, mockAdReturnValue) {
  delete window.__diveeWidgetLoaded;
  eval(widgetJs); // eslint-disable-line no-eval
  const widget = new DiveeWidget({ projectId: 'test-project' }); // eslint-disable-line no-undef
  widget.state.serverConfig = serverConfig;
  if (mockAdReturnValue !== undefined) {
    widget.isMockAdRequested = jest.fn(() => mockAdReturnValue);
  }
  return widget;
}

describe('isMockAdRequested()', () => {
  beforeEach(() => {
    delete window.__diveeWidgetLoaded;
  });
  afterEach(() => {
    restoreURLSearchParams();
  });

  test('returns true when diveeMockAd=true is in URL', () => {
    mockURLSearchParams({ diveeMockAd: 'true' });
    eval(widgetJs); // eslint-disable-line no-eval
    const widget = new DiveeWidget({ projectId: 'test-project' }); // eslint-disable-line no-undef
    expect(widget.isMockAdRequested()).toBe(true);
  });

  test('returns false when diveeMockAd is absent', () => {
    mockURLSearchParams({});
    eval(widgetJs); // eslint-disable-line no-eval
    const widget = new DiveeWidget({ projectId: 'test-project' }); // eslint-disable-line no-undef
    expect(widget.isMockAdRequested()).toBe(false);
  });

  test('returns false when diveeMockAd=false', () => {
    mockURLSearchParams({ diveeMockAd: 'false' });
    eval(widgetJs); // eslint-disable-line no-eval
    const widget = new DiveeWidget({ projectId: 'test-project' }); // eslint-disable-line no-undef
    expect(widget.isMockAdRequested()).toBe(false);
  });

  test('returns false when diveeMockAd has any value other than "true"', () => {
    mockURLSearchParams({ diveeMockAd: '1' });
    eval(widgetJs); // eslint-disable-line no-eval
    const widget = new DiveeWidget({ projectId: 'test-project' }); // eslint-disable-line no-undef
    expect(widget.isMockAdRequested()).toBe(false);
  });
});

describe('Mock Ad rendering in createWidget()', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('renders mock ad GIF when show_ad is false and diveeMockAd=true', () => {
    const widget = makeWidget({ show_ad: false, ad_tag_id: null }, true);
    widget.createWidget();

    const img = document.querySelector('.divee-mock-ad-img');
    expect(img).not.toBeNull();
    expect(img.src).toBe(MOCK_AD_URL);
  });

  test('mock ad container is visible when mock ad is shown', () => {
    const widget = makeWidget({ show_ad: false, ad_tag_id: null }, true);
    widget.createWidget();

    const adContainer = document.querySelector('.divee-ad-container-shared');
    expect(adContainer).not.toBeNull();
    expect(adContainer.style.display).toBe('block');
  });

  test('mock ad slot has centering class', () => {
    const widget = makeWidget({ show_ad: false, ad_tag_id: null }, true);
    widget.createWidget();

    const slot = document.querySelector('.divee-mock-ad-slot');
    expect(slot).not.toBeNull();
  });

  test('does NOT render mock ad when show_ad is true (even with diveeMockAd=true)', () => {
    // show_ad=true means hasAds=true, so showMockAd=false regardless of param
    const widget = makeWidget({ show_ad: true, ad_tag_id: 'some-tag' }, true);
    widget.createWidget();

    const img = document.querySelector('.divee-mock-ad-img');
    expect(img).toBeNull();
  });

  test('renders real Google ad slots (not mock) when show_ad is true', () => {
    const widget = makeWidget({ show_ad: true, ad_tag_id: 'some-tag' }, true);
    widget.createWidget();

    expect(document.getElementById('div-gpt-ad-1770993606680-0')).not.toBeNull();
    expect(document.getElementById('div-gpt-ad-1770993160534-0')).not.toBeNull();
  });
});

describe('Mock Ad NOT shown when URL param is absent', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('does NOT render mock ad when diveeMockAd param is missing, even with show_ad=false', () => {
    const widget = makeWidget({ show_ad: false, ad_tag_id: null }, false);
    widget.createWidget();

    const img = document.querySelector('.divee-mock-ad-img');
    expect(img).toBeNull();
  });

  test('ad container is hidden when no real ads and no mock ad', () => {
    const widget = makeWidget({ show_ad: false, ad_tag_id: null }, false);
    widget.createWidget();

    const adContainer = document.querySelector('.divee-ad-container-shared');
    expect(adContainer).not.toBeNull();
    expect(adContainer.style.display).toBe('none');
  });
});
