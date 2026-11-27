import {
  DEFAULT_RULES,
  SEVERITY_WEIGHT,
  type InjectionRule,
  type RuleCategory,
  type Severity,
} from './rules';
import { normalizeForMatching, stripInvisible, type InvisibleCategory } from './unicode';

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface DetectionMatch {
  ruleId: string;
  category: RuleCategory | 'invisible-unicode';
  severity: Severity;
  description: string;
  /** The matched excerpt (from the normalised text). */
  match: string;
  /** Index into the normalised text. */
  index: number;
}

export interface DetectOptions {
  /** Replace the built-in rule set entirely. */
  rules?: InjectionRule[];
  /** Additional rules appended to the active set. */
  extraRules?: InjectionRule[];
  /** Rule ids to disable. */
  disabledRules?: string[];
  /** Max matches recorded per rule (keeps output bounded). Default 5. */
  maxMatchesPerRule?: number;
  /** Treat any invisible / smuggling characters as a finding. Default `true`. */
  flagInvisible?: boolean;
  /**
   * Characters scanned. Default 1 000 000. Rules are linear-time, so the
   * whole input is scanned; anything longer than this is reported as the
   * `scan.truncated` finding (severity high) rather than silently passing —
   * otherwise padding the input would hide an attack past the limit.
   */
  maxScanLength?: number;
  /**
   * Also scan decoded views of the text: Base64 segments that decode to
   * readable text, and — when the text mentions ROT13 / reversing / decoding —
   * its ROT13 and reversed forms. Catches "decode this, then follow it".
   * Default `true`.
   */
  decode?: boolean;
}

export interface DetectionResult {
  /** 0 … 1 aggregated risk score. */
  score: number;
  level: RiskLevel;
  /** `true` when level is `medium` or above. */
  flagged: boolean;
  matches: DetectionMatch[];
  /** Normalised text the rules ran against. */
  normalized: string;
  invisible: { removed: number; categories: InvisibleCategory[]; decodedTagPayload?: string };
}

/** Prepare text for matching: strip invisibles, NFKC, collapse whitespace. */
export const DEFAULT_MAX_SCAN_LENGTH = 1_000_000;

export function prepareForMatching(text: string, maxLength = DEFAULT_MAX_SCAN_LENGTH) {
  const slice = text.length > maxLength ? text.slice(0, maxLength) : text;
  const stripped = stripInvisible(slice, { collectFindings: false, preserveEmojiZwj: true });
  const normalized = normalizeForMatching(stripped.text).replace(/[ \t\f\v\u00a0\u3000]+/g, ' ');
  return { stripped, normalized };
}

// ─── Decoded views ─────────────────────────────────────────────────────────
// "Decode this, then do what it says" carries no keywords in the visible
// text. We decode cheap, common encodings and run the same rules over the
// result. Bounded so it stays linear in the input.

/** Text hints that an encoding other than Base64 is in play. */
const DECODE_HINT =
  /\b(?:rot-?13|caesar|reverse[ds]?|backwards?|decode|decrypt|unscramble)\b|解碼|解码|解密|反轉|反转|倒過來|倒过来|倒著|倒着|倒序|逆序|反過來|反过来|還原|还原/i;
const B64_CANDIDATE = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const MAX_DECODED_CHARS = 200_000;

function decodeBase64Text(blob: string): string | null {
  const atobFn = (globalThis as { atob?: (s: string) => string }).atob;
  if (!atobFn) return null;
  let b64 = blob.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length % 4 === 1) return null;
  b64 += '='.repeat((4 - (b64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atobFn(b64);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null; // not UTF-8 text (an image, a hash, …)
  }
  // Mostly printable, and containing a word, or it is just noise.
  let printable = 0;
  for (const ch of text) if (ch >= ' ' || ch === '\n' || ch === '\t') printable++;
  if (printable < text.length * 0.9 || !/[\p{L}]{2}/u.test(text)) return null;
  return text;
}

const rot13 = (s: string) =>
  s.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

/** Extra haystacks: decoded Base64 always; ROT13 / reversed only on a hint. */
function decodedViews(normalized: string): { text: string; source: string }[] {
  const views: { text: string; source: string }[] = [];
  // Every candidate is tried (no count cap: padding with junk tokens must not
  // push the payload out of reach). Total work stays linear: candidates do not
  // overlap, and decoded text is bounded by MAX_DECODED_CHARS.
  const decodedParts: string[] = [];
  let budget = MAX_DECODED_CHARS;
  B64_CANDIDATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (budget > 0 && (m = B64_CANDIDATE.exec(normalized)) !== null) {
    const decoded = decodeBase64Text(m[0]);
    if (decoded) {
      decodedParts.push(decoded.slice(0, budget));
      budget -= decoded.length;
    }
  }
  if (decodedParts.length > 0)
    views.push({ text: normalizeForMatching(decodedParts.join('\n')), source: 'base64' });
  if (DECODE_HINT.test(normalized)) {
    const slice = normalized.slice(0, MAX_DECODED_CHARS);
    views.push({ text: rot13(slice), source: 'rot13' });
    views.push({ text: Array.from(slice).reverse().join(''), source: 'reversed' });
  }
  return views;
}

/** Combine independent rule weights: 1 − Π(1 − wᵢ). */
export function combineScores(weights: number[]): number {
  let keep = 1;
  for (const w of weights) keep *= 1 - Math.min(Math.max(w, 0), 1);
  return Math.round((1 - keep) * 1000) / 1000;
}

export function scoreToLevel(score: number): RiskLevel {
  if (score >= 0.95) return 'critical';
  if (score >= 0.85) return 'high';
  if (score >= 0.6) return 'medium';
  if (score >= 0.3) return 'low';
  return 'none';
}

export function resolveRules(
  options: Pick<DetectOptions, 'rules' | 'extraRules' | 'disabledRules'> = {},
): InjectionRule[] {
  const disabled = new Set(options.disabledRules ?? []);
  return [...(options.rules ?? DEFAULT_RULES), ...(options.extraRules ?? [])].filter(
    (r) => !disabled.has(r.id),
  );
}

/** Scan `text` for prompt-injection / jailbreak indicators. Pure and synchronous. */
export function detectInjection(text: string, options: DetectOptions = {}): DetectionResult {
  const { stripped, normalized } = prepareForMatching(text, options.maxScanLength);
  const rules = resolveRules(options);
  const maxPerRule = options.maxMatchesPerRule ?? 5;
  const matches: DetectionMatch[] = [];
  const weights: number[] = [];
  let smuggledPayload = '';

  const limit = options.maxScanLength ?? DEFAULT_MAX_SCAN_LENGTH;
  if (text.length > limit) {
    matches.push({
      ruleId: 'scan.truncated',
      category: 'obfuscation',
      severity: 'high',
      description: `Input is ${text.length} chars; only the first ${limit} were scanned.`,
      match: '',
      index: limit,
    });
    weights.push(SEVERITY_WEIGHT.high);
  }

  if ((options.flagInvisible ?? true) && stripped.removed > 0) {
    const smuggled =
      stripped.categories.includes('tag-character') || stripped.categories.includes('bidi-control');
    const severity: Severity = smuggled ? 'high' : 'low';
    matches.push({
      ruleId: 'unicode.invisible',
      category: 'invisible-unicode',
      severity,
      description: `Removed ${stripped.removed} invisible character(s): ${stripped.categories.join(', ')}`,
      match: stripped.decodedTagPayload ?? '',
      index: 0,
    });
    weights.push(SEVERITY_WEIGHT[severity]);
    // Smuggled tag payloads are scanned too — they are the hidden instruction.
    if (stripped.decodedTagPayload) smuggledPayload = stripped.decodedTagPayload;
  }

  const haystacks: { text: string; source: string }[] = [{ text: normalized, source: '' }];
  if (smuggledPayload)
    haystacks.push({ text: normalizeForMatching(smuggledPayload), source: 'tag-characters' });
  if (options.decode ?? true) haystacks.push(...decodedViews(normalized));
  const decodedSources = new Set<string>();

  for (const rule of rules) {
    const flags = rule.pattern.flags.replace(/[gy]/g, '') + 'g';
    const re = new RegExp(rule.pattern.source, flags);
    let count = 0;
    for (const hay of haystacks) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while (count < maxPerRule && (m = re.exec(hay.text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        const decoded = hay.source !== '' && hay.source !== 'tag-characters';
        if (decoded && rule.category !== 'obfuscation') decodedSources.add(hay.source);
        matches.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          description: decoded ? `(decoded ${hay.source}) ${rule.description}` : rule.description,
          match: m[0].trim().slice(0, 200),
          index: hay.source === '' ? m.index : -1,
        });
        count++;
      }
    }
    if (count > 0) weights.push(SEVERITY_WEIGHT[rule.severity]);
  }

  // An instruction hidden behind an encoding is itself a strong signal.
  if (decodedSources.size > 0) {
    matches.push({
      ruleId: 'obfuscation.encoded-payload',
      category: 'obfuscation',
      severity: 'high',
      description: `Injection found after decoding (${[...decodedSources].join(', ')}).`,
      match: '',
      index: -1,
    });
    weights.push(SEVERITY_WEIGHT.high);
  }

  const score = combineScores(weights);
  const level = scoreToLevel(score);
  const invisible: DetectionResult['invisible'] = {
    removed: stripped.removed,
    categories: stripped.categories,
  };
  if (stripped.decodedTagPayload) invisible.decodedTagPayload = stripped.decodedTagPayload;
  return { score, level, flagged: score >= 0.6, matches, normalized, invisible };
}
