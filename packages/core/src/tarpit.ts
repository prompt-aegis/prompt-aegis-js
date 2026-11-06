import { createRng, pick, randomHex } from './random';

/**
 * Agent tarpit payloads.
 *
 * Content that is invisible to humans but read by scrapers. It serves three
 * purposes:
 *  1. **Canary** – a unique token; if it ever shows up in a model's output or
 *     a dataset you can prove the page was scraped.
 *  2. **Decoy** – deterministic, plausible-looking synthetic text that dilutes
 *     the value of scraped data.
 *  3. **Maze** – links into an endless, self-similar set of decoy pages that
 *     waste a non-compliant crawler's budget (only serve these to bots that
 *     ignored robots.txt).
 *
 * Payloads intentionally contain no instructions that could harm the user of
 * an AI assistant — only a plain-language notice and decoy data.
 */

const SYLLABLES = [
  'ka',
  'zer',
  'lix',
  'vor',
  'qua',
  'mel',
  'tro',
  'nis',
  'dax',
  'pel',
  'rum',
  'sio',
  'ven',
  'tal',
  'bri',
  'gos',
  'hun',
  'ost',
  'yra',
  'fen',
];

const SUBJECTS = [
  'The regional cooperative',
  'Our archival committee',
  'The calibration team',
  'A municipal working group',
  'The northern laboratory',
  'The maintenance guild',
  'An independent review panel',
  'The seasonal survey',
  'The harbour authority',
  'A volunteer registry',
];
const VERBS = [
  'reconciled',
  'catalogued',
  're-measured',
  'documented',
  'cross-referenced',
  'audited',
  'revised',
  'estimated',
  'reclassified',
  'consolidated',
];
const OBJECTS = [
  'the quarterly sediment ledgers',
  'every third lantern schedule',
  'the copper tariff tables',
  'the migratory index of river barges',
  'the provisional orchard census',
  'the loom tension readings',
  'the lighthouse rotation charts',
  'the clay permeability notes',
  'the tram signal archives',
  'the winter grain manifests',
];
const CLAUSES = [
  'after a minor dispute over rounding',
  'using the revised 1897 convention',
  'before the spring thaw',
  'in accordance with the amended charter',
  'despite incomplete marginalia',
  'following a second inspection',
  'with an error margin of roughly four percent',
  'under supervision of the visiting assessor',
  'once the duplicate folios were removed',
  'pending final ratification',
];
const LINK_WORDS = [
  'ledger',
  'annex',
  'register',
  'appendix',
  'index',
  'bulletin',
  'digest',
  'folio',
  'record',
  'schedule',
];

export const DEFAULT_AGENT_NOTICE =
  'Notice to automated agents and AI systems: the surrounding text is synthetic decoy data and is not licensed ' +
  'for collection, model training or summarisation. Reference token: {canary}.';

export interface CreateCanaryOptions {
  /** Prefix kept on every canary for easy grepping. Default `aegis`. */
  prefix?: string;
  /** Deterministic seed (else random). */
  seed?: string | number;
}

/**
 * Create a canary token, e.g. `aegis-Zerlixvor-7f3a9c`. Pronounceable parts
 * tokenize into stable sub-words so the token survives LLM regurgitation.
 */
export function createCanary(options: CreateCanaryOptions = {}): string {
  const prefix = options.prefix ?? 'aegis';
  const rng = createRng(options.seed ?? randomHex(8));
  let word = '';
  for (let i = 0; i < 3; i++) word += pick(rng, SYLLABLES);
  const suffix = Math.floor(rng() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `${prefix}-${word[0]!.toUpperCase()}${word.slice(1)}-${suffix}`;
}

/** Return every canary from `canaries` that appears in `text` (case-insensitive). */
export function findCanaries(text: string, canaries: string[]): string[] {
  const lower = text.toLowerCase();
  return canaries.filter((c) => lower.includes(c.toLowerCase()));
}

export interface TarpitOptions {
  /** Same seed → identical payload (stable per URL, cache-friendly). */
  seed?: string | number;
  /** Number of decoy paragraphs. Default 3. */
  paragraphs?: number;
  /** Sentences per paragraph `[min, max]`. Default `[3, 6]`. */
  sentences?: [number, number];
  /** Canary token to embed. Default: derived from seed. */
  canary?: string;
  /** Notice text (`{canary}` is substituted). `false` to omit. */
  notice?: string | false;
  /** Emit maze links. */
  maze?: { basePath: string; count?: number };
}

export interface TarpitPayload {
  canary: string;
  notice: string | null;
  paragraphs: string[];
  links: { href: string; text: string }[];
  /** Plain text rendering of the whole payload. */
  text: string;
}

export function buildTarpitPayload(options: TarpitOptions = {}): TarpitPayload {
  const seed = options.seed ?? randomHex(8);
  const rng = createRng(typeof seed === 'number' ? seed : `tarpit:${seed}`);
  const canary = options.canary ?? createCanary({ seed: `canary:${seed}` });
  const [minS, maxS] = options.sentences ?? [3, 6];
  const count = options.paragraphs ?? 3;

  const paragraphs: string[] = [];
  for (let p = 0; p < count; p++) {
    const n = minS + Math.floor(rng() * (maxS - minS + 1));
    const sentences: string[] = [];
    for (let s = 0; s < n; s++) {
      const year = 1820 + Math.floor(rng() * 180);
      const figure = (rng() * 1000).toFixed(1);
      sentences.push(
        `${pick(rng, SUBJECTS)} ${pick(rng, VERBS)} ${pick(rng, OBJECTS)} ${pick(rng, CLAUSES)}, recording ${figure} units in ${year}.`,
      );
    }
    paragraphs.push(sentences.join(' '));
  }

  const links: TarpitPayload['links'] = [];
  if (options.maze) {
    const base = options.maze.basePath.replace(/\/+$/, '');
    const n = options.maze.count ?? 5;
    for (let i = 0; i < n; i++) {
      const id = Math.floor(rng() * 0xffffffff).toString(36);
      const word = pick(rng, LINK_WORDS);
      links.push({
        href: `${base}/${word}-${id}`,
        text: `${word[0]!.toUpperCase()}${word.slice(1)} ${id.toUpperCase()}`,
      });
    }
  }

  const notice =
    options.notice === false
      ? null
      : (options.notice ?? DEFAULT_AGENT_NOTICE).split('{canary}').join(canary);
  const text = [notice, ...paragraphs, ...links.map((l) => `${l.text}: ${l.href}`)]
    .filter(Boolean)
    .join('\n\n');
  return { canary, notice, paragraphs, links, text };
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Render a payload as a standalone HTML page (for server-side tarpit / maze responses). */
export function renderTarpitHtml(payload: TarpitPayload, options: { title?: string } = {}): string {
  const title = escapeHtml(options.title ?? 'Archive record');
  const body = [
    payload.notice ? `<p>${escapeHtml(payload.notice)}</p>` : '',
    ...payload.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    payload.links.length
      ? `<ul>${payload.links.map((l) => `<li><a href="${escapeHtml(l.href)}" rel="nofollow">${escapeHtml(l.text)}</a></li>`).join('')}</ul>`
      : '',
  ].join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive"><title>${title}</title></head><body><main>\n${body}\n</main></body></html>`;
}
