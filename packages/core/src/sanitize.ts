import {
  detectInjection,
  resolveRules,
  type DetectOptions,
  type DetectionResult,
  type RiskLevel,
} from './detect';
import { normalizeForMatching, stripInvisible, type StripInvisibleOptions } from './unicode';

export type SanitizeMode =
  /** Only strip invisibles / neutralise tokens; report detections. */
  | 'detect'
  /** Additionally replace matched injection phrases with a placeholder. */
  | 'redact'
  /** Like `redact`, and set `blocked` when the score reaches `blockThreshold`. */
  | 'block';

export interface SanitizeOptions extends DetectOptions {
  mode?: SanitizeMode;
  /** Score at/above which `blocked` becomes `true` in `block` mode. Default 0.85. */
  blockThreshold?: number;
  /** Minimum severity a rule needs before its matches are redacted. Default `high`. */
  redactSeverity?: 'low' | 'medium' | 'high' | 'critical';
  /** Placeholder for redacted spans. Default `[filtered]`. */
  redactWith?: string;
  /** Replace chat-template control tokens such as `<|im_start|>`. Default `true`. */
  neutralizeSpecialTokens?: boolean;
  /** Apply NFKC normalisation to the returned text (changes full-width CJK punctuation!). Default `false`. */
  normalize?: boolean;
  /** Hard cap on returned length. */
  maxLength?: number;
  /** Options forwarded to `stripInvisible`. */
  invisible?: StripInvisibleOptions;
}

export interface SanitizeResult {
  /** Text that is safe(r) to forward to the model. */
  text: string;
  /** Original input, unchanged. */
  original: string;
  changed: boolean;
  blocked: boolean;
  score: number;
  level: RiskLevel;
  detection: DetectionResult;
  /** Human readable list of what was done. */
  actions: string[];
}

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

const SPECIAL_TOKEN_RE =
  /<\|(?:im_start|im_end|im_sep|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id|begin_of_text|end_of_text|eom_id|python_tag)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?start_of_turn>|<end_of_turn>/gi;

/** Replace chat-template control tokens with an inert, visible form. */
export function neutralizeSpecialTokens(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(SPECIAL_TOKEN_RE, (tok) => {
    count++;
    return '[' + tok.replace(/[<>|[\]/]/g, '').trim() + ']';
  });
  return { text: out, count };
}

/**
 * Ingress filter for untrusted text headed to an LLM (chat input, retrieved
 * documents, tool output). Pure function — runs in browsers, Node, Deno, Bun,
 * edge workers.
 */
export function sanitizePrompt(input: string, options: SanitizeOptions = {}): SanitizeResult {
  const mode = options.mode ?? 'redact';
  const actions: string[] = [];
  const original = typeof input === 'string' ? input : String(input ?? '');

  const detection = detectInjection(original, options);

  let text = original;
  const stripped = stripInvisible(text, { collectFindings: false, ...options.invisible });
  if (stripped.removed > 0) {
    text = stripped.text;
    actions.push(`stripped ${stripped.removed} invisible character(s)`);
  }

  if (options.normalize) {
    const n = text.normalize('NFKC');
    if (n !== text) actions.push('applied NFKC normalisation');
    text = n;
  }

  if (options.neutralizeSpecialTokens ?? true) {
    const r = neutralizeSpecialTokens(text);
    if (r.count > 0) actions.push(`neutralised ${r.count} special token(s)`);
    text = r.text;
  }

  if (mode !== 'detect') {
    const minRank = SEVERITY_RANK[options.redactSeverity ?? 'high'];
    const placeholder = options.redactWith ?? '[filtered]';
    const rules = resolveRules(options).filter(
      (r) => SEVERITY_RANK[r.severity] >= minRank && r.category !== 'special-token',
    );
    const redactAll = (input: string) => {
      let count = 0;
      let out = input;
      for (const rule of rules) {
        const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, '') + 'g');
        out = out.replace(re, (m) => {
          if (!m) return m;
          count++;
          return placeholder;
        });
      }
      return { out, count };
    };

    let { out, count } = redactAll(text);
    // Detection matches on folded text (NFKC + homoglyphs). If it found a
    // redactable phrase that the raw text hid (full-width / Cyrillic letters),
    // redact on the folded text instead — changing the text is the lesser evil.
    const detectedRedactable = detection.matches.some((m) => rules.some((r) => r.id === m.ruleId));
    if (count === 0 && detectedRedactable) {
      const folded = redactAll(normalizeForMatching(text));
      if (folded.count > 0) {
        ({ out, count } = folded);
        actions.push('normalised obfuscated text (NFKC + homoglyphs) to redact it');
      } else {
        actions.push('detected phrase could not be redacted');
      }
    }
    text = out;
    if (count > 0) actions.push(`redacted ${count} injection phrase(s)`);
  }

  if (options.maxLength !== undefined && text.length > options.maxLength) {
    text = text.slice(0, options.maxLength);
    actions.push(`truncated to ${options.maxLength} chars`);
  }

  const blocked = mode === 'block' && detection.score >= (options.blockThreshold ?? 0.85);
  if (blocked) actions.push('blocked');

  return {
    text,
    original,
    changed: text !== original,
    blocked,
    score: detection.score,
    level: detection.level,
    detection,
    actions,
  };
}
