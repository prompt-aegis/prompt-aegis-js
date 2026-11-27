// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { injectHoneypot } from '../src/index';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('DOM adversarial probes', () => {
  it('A12 RESISTED: scanning for the old product marker and notice finds nothing', () => {
    const trap = injectHoneypot({ seed: 'article', trapPath: '/documents/archive' });
    expect(trap.element.outerHTML).not.toMatch(/data-aegis-honeypot|aegis-|synthetic decoy/i);
    expect(trap.element.textContent).toContain(trap.canary);
  });

  it('A13 LIMIT: a generic hidden-content filter discards the entire trap', () => {
    document.body.innerHTML = '<main><h1>Pricing</h1><p>Standard plan: $20 monthly.</p></main>';
    const trap = injectHoneypot({ seed: 'article', trapPath: '/documents/archive' });
    const extracted = document.body.cloneNode(true) as HTMLElement;
    // No knowledge of the library marker or canary format is needed.
    extracted.querySelectorAll('[aria-hidden="true"], [inert]').forEach((node) => node.remove());
    expect(extracted.textContent).toContain('Standard plan: $20 monthly.');
    expect(extracted.textContent).not.toContain(trap.canary);
    expect(extracted.querySelectorAll('a')).toHaveLength(0);
    expect(trap.element.querySelectorAll('a').length).toBeGreaterThan(0);
  });
});
