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

  const haystacks = smuggledPayload
    ? [normalized, normalizeForMatching(smuggledPayload)]
    : [normalized];

  for (const rule of rules) {
    const flags = rule.pattern.flags.replace(/[gy]/g, '') + 'g';
    const re = new RegExp(rule.pattern.source, flags);
    let count = 0;
    for (const hay of haystacks) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while (count < maxPerRule && (m = re.exec(hay)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        matches.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          description: rule.description,
          match: m[0].trim().slice(0, 200),
          index: hay === normalized ? m.index : -1,
        });
        count++;
      }
    }
    if (count > 0) weights.push(SEVERITY_WEIGHT[rule.severity]);
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
