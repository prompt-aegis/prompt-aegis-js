import {
  sanitizePrompt,
  stripInvisible,
  type SanitizeOptions,
  type SanitizeResult,
} from '@prompt-aegis/core';

type TextControl = HTMLInputElement | HTMLTextAreaElement;
export type GuardTarget = TextControl | HTMLElement;

export interface GuardEvent {
  element: GuardTarget;
  source: 'paste' | 'input' | 'drop' | 'submit';
  result: SanitizeResult;
}

export interface GuardInputOptions {
  /** Options forwarded to `sanitizePrompt` (detection runs in `detect` mode here). */
  sanitize?: SanitizeOptions;
  /** Strip invisible characters from the field as the user types / pastes. Default `true`. */
  stripInvisible?: boolean;
  /** Cancel pastes / drops whose risk score reaches this threshold. Default: never. */
  blockPasteAt?: number;
  /** Called whenever content is flagged (`level !== 'none'`). */
  onDetect?: (event: GuardEvent) => void;
  /** Called when a paste/drop was blocked. */
  onBlock?: (event: GuardEvent) => void;
}

const isTextControl = (el: Element): el is TextControl =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && /^(?:text|search|url|email|tel|)$/i.test(el.type));

function readValue(el: GuardTarget): string {
  return isTextControl(el) ? el.value : (el.textContent ?? '');
}

/**
 * Set a text control's value through the *native* prototype setter.
 *
 * React installs an instance-level `value` setter to track the last value it
 * knows about; assigning `el.value` directly updates that tracker, so React
 * concludes nothing changed and never fires `onChange` — leaving component
 * state stale. Going through the prototype setter avoids that.
 */
function setNativeValue(el: TextControl, value: string): void {
  const view = el.ownerDocument.defaultView;
  const proto =
    view && el instanceof view.HTMLTextAreaElement
      ? view.HTMLTextAreaElement.prototype
      : (view?.HTMLInputElement.prototype ?? Object.getPrototypeOf(el));
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** Replace a field's content, preserving caret position as well as possible. */
function writeValue(el: GuardTarget, value: string): void {
  if (isTextControl(el)) {
    const before = el.value;
    const caret = el.selectionStart ?? before.length;
    const removedBeforeCaret =
      before.slice(0, caret).length -
      stripInvisible(before.slice(0, caret), { collectFindings: false }).text.length;
    setNativeValue(el, value);
    const pos = Math.max(0, caret - removedBeforeCaret);
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      /* some input types do not support selection */
    }
  } else if (el.isContentEditable) {
    // Only rewrite text nodes so markup/formatting is preserved.
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue ?? '';
      const s = stripInvisible(t, { collectFindings: false }).text;
      if (s !== t) n.nodeValue = s;
    }
  }
}

/**
 * Wrap a getter so `guardInput` always reads the *current* options. Used by
 * the React hook and Vue directive so changing options never requires
 * re-binding listeners.
 */
export function liveGuardOptions(get: () => GuardInputOptions | undefined): GuardInputOptions {
  return {
    get sanitize() {
      return get()?.sanitize;
    },
    get stripInvisible() {
      return get()?.stripInvisible;
    },
    get blockPasteAt() {
      return get()?.blockPasteAt;
    },
    onDetect: (e) => get()?.onDetect?.(e),
    onBlock: (e) => get()?.onBlock?.(e),
  };
}

/**
 * Guard a text input, textarea or contenteditable that feeds an LLM:
 * strips invisible/smuggling characters live and reports injection attempts.
 * Options are read on every event, so passing a mutable / live object works.
 * Returns a disposer.
 */
export function guardInput(el: GuardTarget, options: GuardInputOptions = {}): () => void {
  let composing = false;
  let redispatching = false;

  const report = (source: GuardEvent['source'], text: string): SanitizeResult => {
    const result = sanitizePrompt(text, { ...options.sanitize, mode: 'detect' });
    if (result.level !== 'none') options.onDetect?.({ element: el, source, result });
    return result;
  };

  const onPaste = (e: ClipboardEvent | DragEvent) => {
    const dt = 'clipboardData' in e ? e.clipboardData : (e as DragEvent).dataTransfer;
    const text = dt?.getData('text/plain') ?? '';
    if (!text) return;
    const source = e.type === 'drop' ? 'drop' : 'paste';
    const result = report(source, text);
    const threshold = options.blockPasteAt;
    if (threshold !== undefined && result.score >= threshold) {
      e.preventDefault();
      options.onBlock?.({ element: el, source, result });
    }
  };

  const clean = () => {
    if (!(options.stripInvisible ?? true)) return;
    const value = readValue(el);
    const cleaned = stripInvisible(value, { collectFindings: false });
    if (cleaned.removed === 0) return;
    writeValue(el, cleaned.text);
    // Let framework listeners that already ran (or run at document level,
    // e.g. Vue v-model) observe the cleaned value.
    redispatching = true;
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
      redispatching = false;
    }
  };

  const onInput = (e: Event) => {
    // Never rewrite the field mid-composition: it breaks IME input (注音, 拼音, かな).
    if (redispatching || composing || (e as InputEvent).isComposing) return;
    clean();
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    clean();
  };

  // Capture phase: run before same-element bubble listeners (v-model, inline handlers).
  el.addEventListener('paste', onPaste as EventListener);
  el.addEventListener('drop', onPaste as EventListener);
  el.addEventListener('input', onInput, true);
  el.addEventListener('compositionstart', onCompositionStart);
  el.addEventListener('compositionend', onCompositionEnd);
  return () => {
    el.removeEventListener('paste', onPaste as EventListener);
    el.removeEventListener('drop', onPaste as EventListener);
    el.removeEventListener('input', onInput, true);
    el.removeEventListener('compositionstart', onCompositionStart);
    el.removeEventListener('compositionend', onCompositionEnd);
  };
}

export interface GuardFormOptions {
  sanitize?: SanitizeOptions;
  /** Field names to check; default all text inputs and textareas. */
  fields?: string[];
  /** Write sanitized values back into the fields before submit. Default `true`. */
  rewrite?: boolean;
  onDetect?: (event: GuardEvent) => void;
  /** Called when submission was prevented because a field was blocked. */
  onBlock?: (event: GuardEvent) => void;
}

/**
 * Sanitize every text field of a form on submit. In `block` mode a high-risk
 * field cancels the submission.
 */
export function guardForm(form: HTMLFormElement, options: GuardFormOptions = {}): () => void {
  const onSubmit = (e: SubmitEvent | Event) => {
    const controls = Array.from(form.elements).filter(isTextControl);
    for (const el of controls) {
      if (options.fields && !options.fields.includes(el.name)) continue;
      const result = sanitizePrompt(el.value, options.sanitize);
      if (result.level !== 'none') options.onDetect?.({ element: el, source: 'submit', result });
      if (result.blocked) {
        e.preventDefault();
        e.stopImmediatePropagation();
        options.onBlock?.({ element: el, source: 'submit', result });
        return;
      }
      if ((options.rewrite ?? true) && result.changed) setNativeValue(el, result.text);
    }
  };
  form.addEventListener('submit', onSubmit, true);
  return () => form.removeEventListener('submit', onSubmit, true);
}
