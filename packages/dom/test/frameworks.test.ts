// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createApp, h, nextTick, withDirectives } from 'vue';
import { AegisHoneypot as ReactHoneypot } from '../src/react';
import { AegisHoneypot as VueHoneypot, PromptAegis, vAegisGuard } from '../src/vue';

describe('React', () => {
  it('SSR renders deterministic honeypot markup', () => {
    const a = renderToString(
      createElement(ReactHoneypot, { seed: '/pricing', trapPath: '/__aegis/trap' }),
    );
    const b = renderToString(
      createElement(ReactHoneypot, { seed: '/pricing', trapPath: '/__aegis/trap' }),
    );
    expect(a).toBe(b);
    expect(a).toContain('aria-hidden="true"');
    expect(a).toContain('data-aegis-honeypot="aegis-');
    expect(a).toContain('href="/__aegis/trap/');
    expect(a).toContain('left:-10000px');
  });
});

describe('Vue', () => {
  it('renders honeypot and emits trap', async () => {
    const onTrap = vi.fn();
    const root = document.createElement('div');
    document.body.appendChild(root);
    createApp({ render: () => h(VueHoneypot, { seed: 'x', trapPath: '/t', onTrap }) }).mount(root);
    await nextTick();
    const el = root.querySelector('[data-aegis-honeypot]') as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    el.querySelector('a')!.click();
    expect(onTrap).toHaveBeenCalledWith(expect.objectContaining({ type: 'link-click' }));
  });

  it('v-aegis-guard directive strips invisibles', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    createApp({
      render: () => withDirectives(h('textarea', { id: 'ta' }), [[vAegisGuard, {}]]),
    }).mount(root);
    const ta = root.querySelector('#ta') as HTMLTextAreaElement;
    ta.value = 'a\u200Bb';
    ta.dispatchEvent(new Event('input'));
    expect(ta.value).toBe('ab');
  });

  it('plugin registers directive and component', () => {
    const directive = vi.fn();
    const component = vi.fn();
    PromptAegis.install({ directive, component });
    expect(directive).toHaveBeenCalledWith('aegis-guard', vAegisGuard);
    expect(component).toHaveBeenCalledWith('AegisHoneypot', VueHoneypot);
  });
});
