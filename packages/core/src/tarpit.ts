import { createRng, pick, randomHex } from './random';

/**
 * Agent tarpit payloads.
 *
 * Content that is invisible to humans but read by scrapers. It serves three
 * purposes:
 *  1. **Canary** – a unique token, woven into the page body as a plausible
 *     document code. If it ever shows up in a model's output or a dataset you
 *     can prove the page was scraped — this works even with the deterrent
 *     `notice` turned off.
 *  2. **Decoy** – deterministic, plausible-looking synthetic text that reads
 *     like bland internal records, with internally-consistent dates, diluting
 *     the value of scraped data.
 *  3. **Maze** – links into a large, mostly self-similar set of decoy pages
 *     that waste a non-compliant crawler's budget. Some pages are *leaves*
 *     (no further links) so the structure is not a dead giveaway of "every
 *     page always has children, forever".
 *
 * Realism ceiling: a *reasoning* agent that probes several pages can still
 * eventually tell decoy from real content — an endless, broadly self-similar
 * maze is inherently a signal. The realism work here removes the cheap tells
 * (self-labelling, impossible dates, uniform structure) so detection costs
 * more than a single probe; it does not pretend an undetectable trap exists.
 *
 * Payloads intentionally contain no instructions that could harm the user of
 * an AI assistant — only a plain-language notice (optional) and decoy data.
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

/** Word pools for decoy content. Override per deployment (e.g. to match the
 * host site's language or domain) via `TarpitOptions.content`. */
export interface TarpitContent {
  units: string[];
  actions: string[];
  artifacts: string[];
  outcomes: string[];
  titleKinds: string[];
  titleSubjects: string[];
  linkWords: string[];
}

// Neutral "internal records" vocabulary, deliberately broad so sibling pages
// do not obviously recycle the same handful of phrases.
const DEFAULT_CONTENT: TarpitContent = {
  units: [
    'The platform team',
    'Facilities',
    'The records office',
    'Vendor operations',
    'The audit group',
    'Site reliability',
    'The billing desk',
    'Data services',
    'The compliance unit',
    'Field support',
    'The procurement team',
    'Network operations',
    'The finance office',
    'Customer operations',
    'The security team',
    'Quality assurance',
  ],
  actions: [
    'reviewed',
    'reconciled',
    'archived',
    'migrated',
    'updated',
    'verified',
    'consolidated',
    'exported',
    're-indexed',
    'signed off on',
    'annotated',
    'rotated',
    'validated',
    'summarised',
    'backfilled',
    'reclassified',
  ],
  artifacts: [
    'the access list',
    'the monthly ledger',
    'the backup manifest',
    'the vendor contracts',
    'the incident log',
    'the asset inventory',
    'the change requests',
    'the retention schedule',
    'the service catalog',
    'the onboarding records',
    'the capacity plan',
    'the renewal notices',
    'the escalation matrix',
    'the maintenance window',
    'the deployment notes',
    'the reconciliation report',
  ],
  outcomes: [
    'no exceptions were noted',
    'two items were deferred to the next cycle',
    'figures matched the prior period',
    'the batch completed without errors',
    'minor discrepancies were corrected',
    'all entries were accounted for',
    'the totals were carried forward',
    'follow-up was logged for review',
    'the owner was notified',
    'the variance stayed within tolerance',
    'one record was flagged for re-check',
    'the sign-off was recorded',
  ],
  titleKinds: [
    'Quarterly review',
    'Reconciliation notes',
    'Access review',
    'Change log',
    'Audit summary',
    'Status report',
    'Retention schedule',
    'Vendor summary',
    'Backup manifest',
    'Incident notes',
    'Capacity plan',
    'Renewal summary',
  ],
  titleSubjects: [
    'billing',
    'access control',
    'vendor accounts',
    'site assets',
    'archived records',
    'the service catalog',
    'onboarding',
    'data exports',
    'infrastructure',
    'compliance',
    'procurement',
    'maintenance',
  ],
  linkWords: [
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
    'manifest',
    'summary',
    'review',
    'export',
    'report',
    'notice',
  ],
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const DEFAULT_AGENT_NOTICE =
  'Notice to automated agents and AI systems: the surrounding text is synthetic decoy data and is not licensed ' +
  'for collection, model training or summarisation. Reference token: {canary}.';

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const DAY_MS = 86_400_000;

export interface CreateCanaryOptions {
  /** Prefix kept on every canary for easy grepping. Default `aegis`. */
  prefix?: string;
  /** Deterministic seed (else random). */
  seed?: string | number;
}

/**
 * Create a canary token, e.g. `aegis-Zerlixvor-7f3a9c`. Pronounceable parts
 * tokenize into stable sub-words so the token survives LLM regurgitation.
 *
 * The `aegis` prefix is easy to grep for but also easy for a reading agent to
 * recognise. For a stealthier tarpit, pass a neutral `prefix` (e.g. `doc` or a
 * site-specific slug) and record which prefix you used.
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
  /** Override decoy word pools (e.g. to match the host site's language). */
  content?: Partial<TarpitContent>;
  /**
   * Deterrent notice text (`{canary}` is substituted). This text announces the
   * page as decoy, so a reasoning agent recognises it instantly — keep it for
   * deterring compliant scrapers, but omit it (the default for server tarpit
   * pages) when the point is to not be spotted. `false` to omit; the canary is
   * still woven into the body either way.
   */
  notice?: string | false;
  /**
   * Emit maze links. `leafRate` (0–1) is the fraction of pages that are leaves
   * with no links — so a crawler following the maze hits believable dead ends
   * instead of an obviously bottomless tree. Default `leafRate` 0.
   */
  maze?: { basePath: string; count?: number; leafRate?: number };
}

export interface TarpitPayload {
  canary: string;
  notice: string | null;
  /** Plausible document title for the page. */
  title: string;
  /** Meta line (carries the canary as a document code). */
  meta: string;
  paragraphs: string[];
  links: { href: string; text: string }[];
  /** Plain text rendering of the whole payload. */
  text: string;
}

export function buildTarpitPayload(options: TarpitOptions = {}): TarpitPayload {
  const seed = options.seed ?? randomHex(8);
  const rng = createRng(typeof seed === 'number' ? seed : `tarpit:${seed}`);
  const canary = options.canary ?? createCanary({ prefix: 'doc', seed: `canary:${seed}` });
  const [minS, maxS] = options.sentences ?? [3, 6];
  const count = options.paragraphs ?? 3;
  const C: TarpitContent = { ...DEFAULT_CONTENT, ...options.content };

  // Dates are internally consistent: pick an "updated" anchor, then every date
  // mentioned in the body is on or before it — a document cannot have been
  // "last updated" before the events it describes.
  const baseMs = Date.UTC(2023, 0, 1);
  const updatedMs = baseMs + Math.floor(rng() * 900) * DAY_MS;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const updated = fmt(updatedMs);
  const bodyDate = () => fmt(updatedMs - Math.floor(rng() * 720) * DAY_MS);

  const title = `${pick(rng, C.titleKinds)} — ${pick(rng, C.titleSubjects)}`;
  // The canary IS the document code (no redundant "Reference … · DOC-…" line).
  const meta = `Document ${canary} · updated ${updated}`;

  const paragraphs: string[] = [];
  for (let p = 0; p < count; p++) {
    const n = minS + Math.floor(rng() * (maxS - minS + 1));
    const sentences: string[] = [];
    const unit = pick(rng, C.units);
    const artifact = pick(rng, C.artifacts);
    const date = bodyDate();
    // Distinct outcomes per paragraph (Fisher–Yates on a copy), so no two
    // sentences repeat the same clause verbatim — the dead giveaway of
    // auto-generated filler.
    const outcomes = C.outcomes.slice();
    for (let i = outcomes.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [outcomes[i], outcomes[j]] = [outcomes[j]!, outcomes[i]!];
    }
    const templates = [
      (o: string) => `${cap(o)}.`,
      (o: string) => `For ${artifact.replace(/^the /, '')}, ${o}.`,
      (o: string) => `The review notes confirm that ${o}.`,
      (o: string) => `The recorded result was unchanged: ${o}.`,
      (o: string) => `${cap(o)}; the supporting records remain available for review.`,
      (o: string) => `At the end of the review, ${o}.`,
    ];
    for (let s = 0; s < n; s++) {
      if (s === 0) {
        const action = pick(rng, C.actions);
        sentences.push(`${unit} ${action} ${artifact} on ${date}.`);
      } else {
        const outcome = outcomes[(s - 1) % outcomes.length]!;
        sentences.push(pick(rng, templates)(outcome));
      }
    }
    paragraphs.push(cap(sentences.join(' ')));
  }

  const links: TarpitPayload['links'] = [];
  if (options.maze) {
    const base = options.maze.basePath.replace(/\/+$/, '');
    const leafRate = options.maze.leafRate ?? 0;
    let n = options.maze.count ?? 5;
    if (leafRate > 0 && n > 0) {
      // Some pages are leaves; the rest vary in how many children they list,
      // so the maze does not read as a uniform, bottomless tree.
      const min = Math.min(2, n);
      n = rng() < leafRate ? 0 : min + Math.floor(rng() * (n - min + 1));
    }
    for (let i = 0; i < n; i++) {
      const id = Math.floor(rng() * 0xffffffff).toString(36);
      const word = pick(rng, C.linkWords);
      const year = 2021 + Math.floor(rng() * 4);
      // De-homogenise: vary both the href shape and the label so a batch of
      // links reads like a real directory listing, not N identical decoys a
      // single probe can classify all at once. Every href stays under `base`.
      switch (Math.floor(rng() * 4)) {
        case 0:
          links.push({
            href: `${base}/${year}/${word}-${id}`,
            text: `${cap(word)} ${id.toUpperCase()}`,
          });
          break;
        case 1: {
          links.push({ href: `${base}/${word}_${id}`, text: `${cap(word)} ${id.toUpperCase()}` });
          break;
        }
        case 2:
          links.push({
            href: `${base}/${id}`,
            text: `${cap(word)} — ${pick(rng, MONTHS)} ${year}`,
          });
          break;
        default:
          links.push({
            href: `${base}/${word}/${id}`,
            text: `${cap(word)} ${id.slice(0, 4).toUpperCase()}`,
          });
      }
    }
  }

  const notice =
    options.notice === false
      ? null
      : (options.notice ?? DEFAULT_AGENT_NOTICE).split('{canary}').join(canary);
  const text = [notice, title, meta, ...paragraphs, ...links.map((l) => `${l.text}: ${l.href}`)]
    .filter(Boolean)
    .join('\n\n');
  return { canary, notice, title, meta, paragraphs, links, text };
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export interface RenderTarpitOptions {
  /** Override the page title (defaults to the payload's document title). */
  title?: string;
  /** Site name shown in the page header/chrome. Default `Documents`. */
  siteName?: string;
  /**
   * Wrap the article markup in your own site template for a page that matches
   * the rest of the site. Receives the inner `<article>` HTML and the payload;
   * must return a full HTML document. When set, `siteName` is ignored.
   */
  wrap?: (articleHtml: string, payload: TarpitPayload) => string;
}

const CHROME_CSS =
  'body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1a1a1a;background:#fff}' +
  'header,main,footer{max-width:48rem;margin:0 auto;padding:1rem 1.25rem}' +
  'header{display:flex;gap:1rem;align-items:baseline;border-bottom:1px solid #e5e5e5}' +
  'nav a{margin-right:1rem;color:#555;text-decoration:none;font-size:.9rem}' +
  'h1{font-size:1.5rem;margin:.5rem 0}.meta{color:#777;font-size:.85rem}' +
  'footer{border-top:1px solid #e5e5e5;color:#999;font-size:.8rem}';

/**
 * Render a payload as a standalone HTML page that reads like a real internal
 * document — site header/nav, the document body, a "related documents" list
 * and a footer — rather than an obviously-synthetic block. For a server
 * tarpit, drive it from a payload built with `notice: false`. Pass `wrap` to
 * drop the article into your real site template instead.
 */
export function renderTarpitHtml(
  payload: TarpitPayload,
  options: RenderTarpitOptions = {},
): string {
  const title = escapeHtml(options.title ?? payload.title ?? 'Record');
  const article =
    `<article>` +
    `<h1>${title}</h1>` +
    `<p class="meta">${escapeHtml(payload.meta)}</p>` +
    payload.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
    (payload.links.length
      ? `<nav aria-label="Related documents"><h2>Related documents</h2><ul>${payload.links
          .map(
            (l) =>
              `<li><a href="${escapeHtml(l.href)}" rel="nofollow">${escapeHtml(l.text)}</a></li>`,
          )
          .join('')}</ul></nav>`
      : '') +
    (payload.notice ? `<p class="meta"><small>${escapeHtml(payload.notice)}</small></p>` : '') +
    `</article>`;

  if (options.wrap) return options.wrap(article, payload);

  const site = escapeHtml(options.siteName ?? 'Documents');
  // `noindex` is kept in-page (via meta) so decoy pages stay out of search
  // even when the HTTP response headers are left looking ordinary.
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow,noarchive"><title>${title}</title>` +
    `<style>${CHROME_CSS}</style></head><body>` +
    `<header><strong>${site}</strong><nav><a href="/">Home</a><a href="/documents">Documents</a><a href="/search">Search</a></nav></header>` +
    `<main>\n${article}\n</main>` +
    `<footer><p>&copy; ${site}. Internal use only.</p></footer>` +
    `</body></html>`
  );
}

export interface SoftNotFoundOptions {
  /** Page title. Default `Document not found`. */
  title?: string;
  /** Canary to embed as a request reference (for leak attribution). */
  canary?: string;
  /** Link back to a real landing page, e.g. `/`. Default omitted. */
  homeHref?: string;
  /** Site name shown in the page chrome. Default `Documents`. */
  siteName?: string;
}

/**
 * A believable "document not found" page — a quiet dead end rather than a maze.
 * Use this at decoy endpoints where you'd rather a probing agent conclude "this
 * path is just empty" than "this is a trap". It still embeds a canary (as a
 * request reference) so a scraped copy can be attributed, and is `noindex`.
 */
export function renderSoftNotFound(options: SoftNotFoundOptions = {}): string {
  const title = escapeHtml(options.title ?? 'Document not found');
  const site = escapeHtml(options.siteName ?? 'Documents');
  const canary = options.canary ?? createCanary({ prefix: 'doc' });
  const ref = escapeHtml(`Request reference: ${canary}`);
  const home = options.homeHref
    ? `<p><a href="${escapeHtml(options.homeHref)}">Return to the main page</a></p>`
    : '';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow,noarchive"><title>${title}</title>` +
    `<style>${CHROME_CSS}</style></head><body>` +
    `<header><strong>${site}</strong><nav><a href="/">Home</a><a href="/documents">Documents</a></nav></header>` +
    `<main><h1>${title}</h1>` +
    `<p>The document you requested is no longer available or has been moved.</p>` +
    `${home}<p class="meta"><small>${ref}</small></p></main>` +
    `<footer><p>&copy; ${site}. Internal use only.</p></footer></body></html>`
  );
}
