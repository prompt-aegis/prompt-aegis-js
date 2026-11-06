/**
 * Invisible / deceptive Unicode handling.
 *
 * Attackers hide instructions from humans (but not from LLM tokenizers) using:
 *  - zero-width characters (ZWSP, ZWNJ, ZWJ, WJ, BOM …)
 *  - bidi override / isolate controls ("Trojan Source" style reordering)
 *  - Unicode "tag" characters U+E0000–U+E007F ("ASCII smuggling")
 *  - variation selectors, which can encode arbitrary bytes ("emoji smuggling")
 *  - other format (Cf) characters such as soft hyphen or invisible math operators
 */

export type InvisibleCategory =
  'zero-width' | 'bidi-control' | 'tag-character' | 'variation-selector' | 'format-control';

export interface InvisibleFinding {
  category: InvisibleCategory;
  /** Code point, e.g. `U+200B`. */
  codePoint: string;
  /** UTF-16 index in the original string. */
  index: number;
}

export interface StripInvisibleOptions {
  /** Categories to strip. Defaults to all. */
  categories?: InvisibleCategory[];
  /**
   * Keep ZWJ (U+200D) when it sits between two emoji/pictographs so that
   * composite emoji such as 👨‍👩‍👧 survive. Default `true`.
   */
  preserveEmojiZwj?: boolean;
  /**
   * Keep variation selectors VS15/VS16 (U+FE0E/U+FE0F) directly after a
   * pictographic character. Default `true`.
   */
  preserveEmojiPresentation?: boolean;
  /** Collect per-character findings (costs memory on large inputs). Default `true`. */
  collectFindings?: boolean;
}

export interface StripInvisibleResult {
  text: string;
  removed: number;
  categories: InvisibleCategory[];
  findings: InvisibleFinding[];
  /**
   * If tag characters were present, the ASCII text they encoded. This is often
   * the actual smuggled instruction and is useful for logging / alerting.
   */
  decodedTagPayload?: string;
}

const ALL_CATEGORIES: InvisibleCategory[] = [
  'zero-width',
  'bidi-control',
  'tag-character',
  'variation-selector',
  'format-control',
];

const ZERO_WIDTH = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e, 0x034f, 0x115f, 0x1160, 0x3164, 0xffa0,
]);
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/** Classify a single code point, or return `null` if it is visible/benign. */
export function classifyCodePoint(cp: number): InvisibleCategory | null {
  if (ZERO_WIDTH.has(cp)) return 'zero-width';
  if (
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0x200e ||
    cp === 0x200f ||
    cp === 0x061c
  ) {
    return 'bidi-control';
  }
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'tag-character';
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef))
    return 'variation-selector';
  if (
    cp === 0x00ad || // soft hyphen
    (cp >= 0x2061 && cp <= 0x2064) || // invisible math operators
    (cp >= 0x206a && cp <= 0x206f) || // deprecated format chars
    (cp >= 0xfff9 && cp <= 0xfffb) || // interlinear annotation
    (cp >= 0x1bca0 && cp <= 0x1bca3) || // shorthand format controls
    (cp >= 0x1d173 && cp <= 0x1d17a) // musical format controls
  ) {
    return 'format-control';
  }
  return null;
}

/** Fast check: does the string contain any invisible / deceptive code point? */
export function hasInvisible(text: string): boolean {
  for (const ch of text) {
    if (classifyCodePoint(ch.codePointAt(0)!) !== null) return true;
  }
  return false;
}

/** Decode Unicode tag characters (U+E0020–U+E007E) back into ASCII. */
export function decodeTagCharacters(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

/** Remove invisible / deceptive code points from `text`. */
export function stripInvisible(
  text: string,
  options: StripInvisibleOptions = {},
): StripInvisibleResult {
  const categories = new Set(options.categories ?? ALL_CATEGORIES);
  const preserveZwj = options.preserveEmojiZwj ?? true;
  const preserveVs = options.preserveEmojiPresentation ?? true;
  const collect = options.collectFindings ?? true;

  const chars = Array.from(text);
  const findings: InvisibleFinding[] = [];
  const seen = new Set<InvisibleCategory>();
  let out = '';
  let removed = 0;
  let index = 0;
  let tagPayload = '';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const cp = ch.codePointAt(0)!;
    const category = classifyCodePoint(cp);

    let keep = category === null || !categories.has(category);

    if (!keep && category === 'zero-width' && cp === 0x200d && preserveZwj) {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      if (prev && next && isPictographicOrModifier(prev) && PICTOGRAPHIC.test(next)) keep = true;
    }
    if (
      !keep &&
      category === 'variation-selector' &&
      (cp === 0xfe0e || cp === 0xfe0f) &&
      preserveVs
    ) {
      const prev = chars[i - 1];
      if (prev && (PICTOGRAPHIC.test(prev) || /[#*0-9]/.test(prev))) keep = true;
    }

    if (keep) {
      out += ch;
    } else {
      removed++;
      seen.add(category!);
      if (category === 'tag-character' && cp >= 0xe0020 && cp <= 0xe007e) {
        tagPayload += String.fromCharCode(cp - 0xe0000);
      }
      if (collect) {
        findings.push({
          category: category!,
          codePoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
          index,
        });
      }
    }
    index += ch.length;
  }

  const result: StripInvisibleResult = {
    text: out,
    removed,
    categories: [...seen],
    findings,
  };
  if (tagPayload) result.decodedTagPayload = tagPayload;
  return result;
}

function isPictographicOrModifier(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return PICTOGRAPHIC.test(ch) || (cp >= 0x1f3fb && cp <= 0x1f3ff) || cp === 0xfe0f;
}

/**
 * Normalise text so look-alike tricks collapse to canonical form before
 * pattern matching: NFKC folds full-width letters (ｉｇｎｏｒｅ → ignore),
 * ligatures, circled letters, mathematical alphanumerics, etc.
 */
export function normalizeForMatching(text: string): string {
  return text.normalize('NFKC');
}
