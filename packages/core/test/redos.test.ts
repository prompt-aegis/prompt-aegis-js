import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, detectInjection, sanitizeModelOutput, sanitizePrompt } from '../src/index';

/**
 * Regression guard against catastrophic backtracking (ReDoS).
 * Every rule and every public text pipeline must stay (near-)linear on
 * adversarial input. Linear code finishes 20k chars in a few ms; quadratic
 * code takes seconds; cubic code effectively never finishes.
 */
const N = 20_000;
const BUDGET_MS = 500;

const PREFIXES = [
  '',
  '![',
  '![a](',
  '![a](http://x',
  '<img ',
  'ignore ',
  'send ',
  'curl ',
  '<|',
  'system',
  'decode ',
  'you are ',
  '忽略',
  'x\n\n',
  '[a]: ',
];
const FILLERS = [
  ' ',
  '\n',
  '![',
  '[',
  '](',
  'a',
  'a ',
  '?',
  '=',
  'A',
  ' \n',
  '\t',
  '(',
  '\u3000',
  '#',
  '*',
  'src ',
  'a\u200B',
  '`',
  '``a',
  '<',
  '<a b=',
  '<a ',
  '[',
  '\\',
];

const inputs: [string, string][] = [];
for (const p of PREFIXES) {
  for (const f of FILLERS) {
    inputs.push([
      `${JSON.stringify(p)} + ${JSON.stringify(f)}×n`,
      p + f.repeat(Math.ceil(N / f.length)).slice(0, N),
    ]);
  }
}

function timed(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe('ReDoS resistance', () => {
  it.each(DEFAULT_RULES.map((r) => [r.id, r] as const))(
    'rule %s is linear on adversarial input',
    (_id, rule) => {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, '') + 'g');
      let worst = 0;
      let worstLabel = '';
      for (const [label, text] of inputs) {
        const ms = timed(() => text.replace(re, ''));
        if (ms > worst) [worst, worstLabel] = [ms, label];
      }
      expect(worst, `slowest input: ${worstLabel}`).toBeLessThan(BUDGET_MS);
    },
  );

  it.each([
    ['detectInjection', (s: string) => detectInjection(s)],
    ['sanitizePrompt (redact low)', (s: string) => sanitizePrompt(s, { redactSeverity: 'low' })],
    ['sanitizeModelOutput', (s: string) => sanitizeModelOutput(s)],
    [
      'sanitizeModelOutput (filter html)',
      (s: string) => sanitizeModelOutput(s, { html: 'filter' }),
    ],
  ] as const)('%s is linear on adversarial input', (_name, fn) => {
    let worst = 0;
    let worstLabel = '';
    for (const [label, text] of inputs) {
      const ms = timed(() => fn(text));
      if (ms > worst) [worst, worstLabel] = [ms, label];
    }
    expect(worst, `slowest input: ${worstLabel}`).toBeLessThan(BUDGET_MS * 2);
  });
});
