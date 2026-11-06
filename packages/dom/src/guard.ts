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

/** Replace a text control's value, preserving caret position as well as possible. */
function writeValue(el: GuardTarget, value: string): void {
  if (isTextControl(el)) {
    const before = el.value;
    const caret = el.selectionStart ?? before.length;
    const removedBeforeCaret =
      before.slice(0, caret).length -
      stripInvisible(before.slice(0, caret), { collectFindings: false }).text.length;
    el.value = value;
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
 * Guard a text input, textarea or contenteditable that feeds an LLM:
 * strips invisible/smuggling characters live and reports injection attempts.
 * Returns a disposer.
 */
export function guardInput(el: GuardTarget, options: GuardInputOptions = {}): () => void {
  const strip = options.stripInvisible ?? true;
  const sanitizeOpts: SanitizeOptions = { ...options.sanitize, mode: 'detect' };

  const report = (source: GuardEvent['source'], text: string): SanitizeResult => {
    const result = sanitizePrompt(text, sanitizeOpts);
    if (result.level !== 'none') options.onDetect?.({ element: el, source, result });
    return result;
  };

  const onPaste = (e: ClipboardEvent | DragEvent) => {
    const dt = 'clipboardData' in e ? e.clipboardData : (e as DragEvent).dataTransfer;
    const text = dt?.getData('text/plain') ?? '';
    if (!text) return;
    const source = e.type === 'drop' ? 'drop' : 'paste';
    const result = report(source, text);
    if (options.blockPasteAt !== undefined && result.score >= options.blockPasteAt) {
      e.preventDefault();
      options.onBlock?.({ element: el, source, result });
    }
  };

  const onInput = () => {
    if (!strip) return;
    const value = readValue(el);
    const cleaned = stripInvisible(value, { collectFindings: false });
    if (cleaned.removed > 0) writeValue(el, cleaned.text);
  };

  el.addEventListener('paste', onPaste as EventListener);
  el.addEventListener('drop', onPaste as EventListener);
  el.addEventListener('input', onInput);
  return () => {
    el.removeEventListener('paste', onPaste as EventListener);
    el.removeEventListener('drop', onPaste as EventListener);
    el.removeEventListener('input', onInput);
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
      if ((options.rewrite ?? true) && result.changed) el.value = result.text;
    }
  };
  form.addEventListener('submit', onSubmit, true);
  return () => form.removeEventListener('submit', onSubmit, true);
}
