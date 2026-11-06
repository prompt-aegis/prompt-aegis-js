import {
  buildTarpitPayload,
  isSearchEngine,
  type TarpitOptions,
  type TarpitPayload,
} from '@prompt-aegis/core';

export const HONEYPOT_ATTR = 'data-aegis-honeypot';

/**
 * Visually hidden (off-screen + clipped), removed from the accessibility tree
 * (`aria-hidden`) and from focus/interaction (`inert`). Unlike `display:none`,
 * many scrapers and DOM-to-text agents still read it.
 */
export const HIDDEN_STYLE: Readonly<Record<string, string>> = Object.freeze({
  position: 'absolute',
  left: '-10000px',
  top: 'auto',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  'clip-path': 'inset(50%)',
  'white-space': 'nowrap',
  'pointer-events': 'none',
  'user-select': 'none',
});

export interface HoneypotTrapEvent {
  type: 'link-click' | 'field-filled';
  href?: string;
  field?: string;
  canary: string;
}

export interface HoneypotOptions extends TarpitOptions {
  /** Where to insert. Default `document.body`. */
  target?: HTMLElement;
  /** Insert position relative to target. Default `beforeend`. */
  position?: InsertPosition;
  /** Path for trap links (should be `Disallow`ed in robots.txt). */
  trapPath?: string;
  /** Called when automation interacts with a trap. */
  onTrap?: (event: HoneypotTrapEvent) => void;
  /**
   * Do nothing when the page is rendered by a search-engine crawler
   * (Googlebot, Bingbot …). Hidden text can be treated as spam by search
   * engines, and those crawlers honour robots.txt anyway. Default `true`.
   */
  skipSearchEngines?: boolean;
}

export interface HoneypotHandle {
  element: HTMLElement;
  payload: TarpitPayload;
  canary: string;
  remove(): void;
}

/** Shared, framework-neutral description of the honeypot markup. */
export interface HoneypotSpec {
  attrs: Record<string, string>;
  style: Record<string, string>;
  payload: TarpitPayload;
}

export function buildHoneypotSpec(
  options: TarpitOptions & { trapPath?: string } = {},
): HoneypotSpec {
  const maze =
    options.maze ?? (options.trapPath ? { basePath: options.trapPath, count: 3 } : undefined);
  const payload = buildTarpitPayload({ ...options, ...(maze ? { maze } : {}) });
  return {
    attrs: {
      [HONEYPOT_ATTR]: payload.canary,
      'aria-hidden': 'true',
      inert: '',
      'data-nosnippet': '',
    },
    style: { ...HIDDEN_STYLE },
    payload,
  };
}

/** Inject an invisible tarpit / canary block into the page. */
export function injectHoneypot(options: HoneypotOptions = {}): HoneypotHandle {
  const doc = options.target?.ownerDocument ?? document;
  const target = options.target ?? doc.body;
  const spec = buildHoneypotSpec(options);

  const ua = doc.defaultView?.navigator.userAgent;
  if ((options.skipSearchEngines ?? true) && isSearchEngine(ua)) {
    // Detached element so callers can treat the handle uniformly.
    return {
      element: doc.createElement('div'),
      payload: spec.payload,
      canary: spec.payload.canary,
      remove() {},
    };
  }

  const root = doc.createElement('div');
  for (const [k, v] of Object.entries(spec.attrs)) root.setAttribute(k, v);
  for (const [k, v] of Object.entries(spec.style)) root.style.setProperty(k, v);

  if (spec.payload.notice) {
    const p = doc.createElement('p');
    p.textContent = spec.payload.notice;
    root.appendChild(p);
  }
  for (const text of spec.payload.paragraphs) {
    const p = doc.createElement('p');
    p.textContent = text;
    root.appendChild(p);
  }
  for (const link of spec.payload.links) {
    const a = doc.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    a.rel = 'nofollow noopener';
    a.tabIndex = -1;
    root.appendChild(a);
  }

  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a) return;
    e.preventDefault();
    options.onTrap?.({
      type: 'link-click',
      href: a.getAttribute('href') ?? '',
      canary: spec.payload.canary,
    });
  };
  root.addEventListener('click', onClick);
  target.insertAdjacentElement(options.position ?? 'beforeend', root);

  return {
    element: root,
    payload: spec.payload,
    canary: spec.payload.canary,
    remove() {
      root.removeEventListener('click', onClick);
      root.remove();
    },
  };
}

export interface HoneypotFieldOptions {
  /** Field name; pick something tempting like `website` or `company_url`. Default `website`. */
  name?: string;
  onTrap?: (event: HoneypotTrapEvent) => void;
  /** Prevent submission when filled. Default `true`. */
  preventSubmit?: boolean;
}

/**
 * Classic form honeypot: an invisible field that humans never fill but
 * form-filling bots and LLM browser agents often do.
 */
export function addHoneypotField(
  form: HTMLFormElement,
  options: HoneypotFieldOptions = {},
): () => void {
  const doc = form.ownerDocument;
  const name = options.name ?? 'website';
  const wrapper = doc.createElement('div');
  wrapper.setAttribute(HONEYPOT_ATTR, 'field');
  wrapper.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(HIDDEN_STYLE)) wrapper.style.setProperty(k, v);
  const input = doc.createElement('input');
  input.type = 'text';
  input.name = name;
  input.tabIndex = -1;
  input.autocomplete = 'off';
  wrapper.appendChild(input);
  form.appendChild(wrapper);

  const onSubmit = (e: Event) => {
    if (!input.value) return;
    if (options.preventSubmit ?? true) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    options.onTrap?.({ type: 'field-filled', field: name, canary: 'field' });
  };
  form.addEventListener('submit', onSubmit, true);
  return () => {
    form.removeEventListener('submit', onSubmit, true);
    wrapper.remove();
  };
}
