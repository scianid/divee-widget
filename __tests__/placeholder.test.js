/**
 * Placeholder Injection Tests
 * Ensures a #divee-widget-placeholder div is injected after each script[data-project-id].
 */

const { describe, test, expect, beforeEach } = require('@jest/globals');
const fs = require('fs');

const widgetJs = fs.readFileSync('./src/widget.js', 'utf8');

describe('Placeholder injection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    delete window.__diveeWidgetLoaded;
    delete window.DiveeWidget;
    delete window.DiveeSDK;

    fetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    );
  });

  test('injects a placeholder div after the script tag', () => {
    const script = document.createElement('script');
    script.setAttribute('data-project-id', 'test-123');
    document.body.appendChild(script);

    eval(widgetJs);

    const placeholder = document.getElementById('divee-widget-placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder.tagName).toBe('DIV');
    expect(script.nextElementSibling).toBe(placeholder);
  });

  test('placeholder is empty', () => {
    const script = document.createElement('script');
    script.setAttribute('data-project-id', 'test-123');
    document.body.appendChild(script);

    eval(widgetJs);

    const placeholder = document.getElementById('divee-widget-placeholder');
    expect(placeholder.innerHTML).toBe('');
  });

  test('does not inject duplicate placeholder on re-eval', () => {
    const script = document.createElement('script');
    script.setAttribute('data-project-id', 'test-123');
    document.body.appendChild(script);

    // Manually run the IIFE logic once
    eval(widgetJs);

    // Reset guard so second eval runs autoInit again
    delete window.__diveeWidgetLoaded;
    delete window.DiveeWidget;
    delete window.DiveeSDK;
    eval(widgetJs);

    const placeholders = document.querySelectorAll('#divee-widget-placeholder');
    expect(placeholders.length).toBe(1);
  });

  test('does not inject placeholder when no script tag exists', () => {
    eval(widgetJs);

    const placeholder = document.getElementById('divee-widget-placeholder');
    expect(placeholder).toBeNull();
  });

  test('injects placeholder between script and its next sibling', () => {
    const script = document.createElement('script');
    script.setAttribute('data-project-id', 'test-123');
    document.body.appendChild(script);

    const existingDiv = document.createElement('div');
    existingDiv.id = 'existing';
    document.body.appendChild(existingDiv);

    eval(widgetJs);

    const placeholder = document.getElementById('divee-widget-placeholder');
    expect(script.nextElementSibling).toBe(placeholder);
    expect(placeholder.nextElementSibling).toBe(existingDiv);
  });
});
