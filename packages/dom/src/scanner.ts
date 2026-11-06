import {
  detectInjection,
  stripInvisible,
  type DetectOptions,
  type DetectionResult,
} from '@prompt-aegis/core';
import { HONEYPOT_ATTR } from './honeypot';

export type HiddenReason =
  | 'display-none'
  | 'visibility-hidden'
  | 'opacity-zero'
  | 'font-size-zero'
  | 'offscreen'
  | 'clipped'
  | 'same-color'
  | 'hidden-attribute'
  | 'aria-hidden'
  | 'comment'
  | 'attribute';

export interface HiddenInjectionFinding {
  /** Element carrying the text (for comments: the parent). */
  element: Element;
  text: string;
  reasons: HiddenReason[];
  detection: DetectionResult;
}

export interface ScanOptions {
  detect?: DetectOptions;
  /** Report hidden text even if no injection rule matched. Default `false`. */
  includeClean?: boolean;
  /** Attributes whose values are scanned. Default: alt, title, aria-label, aria-description, placeholder. */
  attributes?: string[];
  /** Scan HTML comments. Default `true`. */
  comments?: boolean;
  /** Skip our own honeypots. Default `true`. */
  skipHoneypots?: boolean;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD']);

function parseColor(c: string): string {
  return c.replace(/\s+/g, '').toLowerCase();
}

/** Why (if at all) is this element hidden from a human viewer? */
export function hiddenReasons(
  el: Element,
  cache?: WeakMap<Element, HiddenReason[]>,
): HiddenReason[] {
  const cached = cache?.get(el);
  if (cached) return cached;
  const reasons: HiddenReason[] = [];
  const view = el.ownerDocument.defaultView;
  if (!view) return reasons;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.hasAttribute('hidden')) reasons.push('hidden-attribute');
    const s = view.getComputedStyle(cur);
    if (s.display === 'none') reasons.push('display-none');
    if (cur === el && s.visibility === 'hidden') reasons.push('visibility-hidden');
    if (parseFloat(s.opacity) === 0) reasons.push('opacity-zero');
    if (cur === el && /^0(?:\.0+)?(?:px|em|rem|%)?$/.test(s.fontSize.trim()))
      reasons.push('font-size-zero');
    const left = parseFloat(s.left);
    const top = parseFloat(s.top);
    const textIndent = parseFloat(s.textIndent);
    if ((s.position === 'absolute' || s.position === 'fixed') && (left <= -999 || top <= -999))
      reasons.push('offscreen');
    if (textIndent <= -999) reasons.push('offscreen');
    if (
      /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(s.clip) ||
      /inset\(\s*50%\s*\)/.test(s.clipPath ?? '')
    ) {
      reasons.push('clipped');
    }
    if (
      cur === el &&
      s.color &&
      s.backgroundColor &&
      parseColor(s.color) === parseColor(s.backgroundColor) &&
      !/transparent|rgba\(0,0,0,0\)/.test(parseColor(s.backgroundColor))
    ) {
      reasons.push('same-color');
    }
  }
  const out = [...new Set(reasons)];
  cache?.set(el, out);
  return out;
}

/**
 * Find text that is hidden from humans but would be read by an LLM that
 * ingests this DOM (indirect prompt injection in user-generated content,
 * third-party widgets, emails rendered in a webview, …).
 */
export function scanForHiddenInjections(
  root: ParentNode = document,
  options: ScanOptions = {},
): HiddenInjectionFinding[] {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const findings: HiddenInjectionFinding[] = [];
  const attrs = options.attributes ?? [
    'alt',
    'title',
    'aria-label',
    'aria-description',
    'placeholder',
  ];
  const skipHoneypots = options.skipHoneypots ?? true;
  const includeClean = options.includeClean ?? false;
  const cache = new WeakMap<Element, HiddenReason[]>();

  const consider = (element: Element, text: string, reasons: HiddenReason[]) => {
    const t = text.trim();
    if (!t) return;
    const detection = detectInjection(t, options.detect);
    if (includeClean || detection.level !== 'none')
      findings.push({ element, text: t, reasons, detection });
  };

  const walker = doc.createTreeWalker(
    root as Node,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (SKIP_TAGS.has(el.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          if (skipHoneypots && el.hasAttribute(HONEYPOT_ATTR)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.COMMENT_NODE) {
      if ((options.comments ?? true) && node.parentElement)
        consider(node.parentElement, node.nodeValue ?? '', ['comment']);
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (!parent) continue;
      const text = node.nodeValue ?? '';
      const reasons = hiddenReasons(parent, cache);
      // Visible text with smuggled characters is also hidden content.
      const smuggled = stripInvisible(text, { collectFindings: false }).decodedTagPayload;
      if (reasons.length > 0 || smuggled) consider(parent, text, reasons);
      continue;
    }
    const el = node as Element;
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v) consider(el, v, ['attribute']);
    }
  }
  return findings;
}

/**
 * Extract only the text a human would actually see — the safe thing to feed
 * an LLM when summarising / answering about the current page.
 */
export function extractVisibleText(root: Element = document.body): string {
  const doc = root.ownerDocument;
  const parts: string[] = [];
  const cache = new WeakMap<Element, HiddenReason[]>();
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`[${HONEYPOT_ATTR}]`)) return NodeFilter.FILTER_REJECT;
      return hiddenReasons(parent, cache).length
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = stripInvisible(n.nodeValue ?? '', { collectFindings: false }).text.trim();
    if (t) parts.push(t);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
