import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from 'react';
import {
  sanitizeModelOutput,
  type SanitizeOutputOptions,
  type TarpitOptions,
} from '@prompt-aegis/core';
import { detectAutomation, type AutomationSignals } from './automation';
import { guardInput, type GuardInputOptions, type GuardTarget } from './guard';
import { buildHoneypotSpec, type HoneypotTrapEvent } from './honeypot';

/** Attach `guardInput` to a ref'd input / textarea / contenteditable. */
export function useAegisGuard<T extends GuardTarget>(
  ref: RefObject<T | null>,
  options: GuardInputOptions = {},
): void {
  const opts = useRef(options);
  opts.current = options;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return guardInput(el, {
      ...opts.current,
      onDetect: (e) => opts.current.onDetect?.(e),
      onBlock: (e) => opts.current.onBlock?.(e),
    });
  }, [ref]);
}

export interface AegisHoneypotProps extends TarpitOptions {
  /**
   * Seed for deterministic output. Provide one (e.g. the route path) when
   * server-rendering so the client hydrates identical markup.
   */
  seed?: string | number;
  trapPath?: string;
  onTrap?: (event: HoneypotTrapEvent) => void;
}

const toCamel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Invisible tarpit / canary block. SSR-safe when `seed` is given. */
export function AegisHoneypot(props: AegisHoneypotProps): ReactElement {
  const { onTrap, ...rest } = props;
  const spec = useMemo(
    () => buildHoneypotSpec(rest),
    [rest.seed, rest.canary, rest.trapPath, rest.paragraphs, rest.notice],
  );
  const style = Object.fromEntries(
    Object.entries(spec.style).map(([k, v]) => [toCamel(k), v]),
  ) as CSSProperties;
  const { payload } = spec;
  return createElement(
    'div',
    {
      'data-aegis-honeypot': payload.canary,
      'aria-hidden': true,
      'data-nosnippet': '',
      inert: true,
      style,
      onClickCapture: (e: { target: EventTarget | null; preventDefault(): void }) => {
        const a = (e.target as Element | null)?.closest?.('a');
        if (!a) return;
        e.preventDefault();
        onTrap?.({
          type: 'link-click',
          href: a.getAttribute('href') ?? '',
          canary: payload.canary,
        });
      },
    } as Record<string, unknown>,
    payload.notice ? createElement('p', { key: 'n' }, payload.notice) : null,
    ...payload.paragraphs.map((p, i) => createElement('p', { key: `p${i}` }, p)),
    ...payload.links.map((l, i) =>
      createElement(
        'a',
        { key: `a${i}`, href: l.href, rel: 'nofollow noopener', tabIndex: -1 },
        l.text,
      ),
    ),
  );
}

/** Client-side automation signals (empty during SSR / first render). */
export function useAutomationDetection(): AutomationSignals {
  const [state, setState] = useState<AutomationSignals>({ automated: false, signals: [] });
  useEffect(() => setState(detectAutomation()), []);
  return state;
}

/** Memoised `sanitizeModelOutput` for rendering LLM markdown. */
export function useSafeModelOutput(markdown: string, options?: SanitizeOutputOptions): string {
  const key = JSON.stringify(options ?? {});
  return useMemo(() => sanitizeModelOutput(markdown, options).text, [markdown, key]);
}
