import {
  buildRobotsTxt,
  buildTarpitPayload,
  classifyUserAgent,
  createCanary,
  hashString,
  renderTarpitHtml,
  sanitizePrompt,
  type BotCategory,
  type BotClassification,
  type ClassifyOptions,
  type RobotsTxtOptions,
  type SanitizeOptions,
  type SanitizeResult,
  type TarpitContent,
  type TarpitPayload,
} from '@prompt-aegis/core';
import { MemoryFlagStore, type FlagStore } from './store';

export type BotAction = 'allow' | 'block' | 'tarpit';

export interface AegisRequest {
  method: string;
  /** Path without query string. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Client IP (adapters fill this in). */
  ip?: string;
  /** Parsed body, if any. */
  body?: unknown;
}

export interface AegisResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AegisDecision {
  action: 'next' | 'block' | 'tarpit' | 'respond';
  reasons: string[];
  bot: BotClassification;
  /** Present when body sanitization ran. */
  sanitized?: { body: unknown; changed: boolean; score: number; findings: FieldFinding[] };
  /** Ready-to-send response for `block`, `tarpit` and `respond`. */
  response?: AegisResponse;
  /** Milliseconds the adapter should wait before sending a tarpit response. */
  delayMs?: number;
}

export interface FieldFinding {
  path: string;
  level: SanitizeResult['level'];
  score: number;
  rules: string[];
  actions: string[];
}

export interface AegisEvent {
  /** `error`: a user hook (`tarpit.document` / `tarpit.render`) threw; the engine
   * fell back to its built-in output so the response stays indistinguishable. */
  type: 'bot' | 'trap' | 'injection' | 'blocked' | 'tarpit' | 'error';
  request: Pick<AegisRequest, 'method' | 'path' | 'ip'>;
  detail: Record<string, unknown>;
}

export interface AegisNodeOptions {
  /** Optional server-side access check for private routes, independent of User-Agent.
   * Verify a session/token with your authentication system; never trust a client
   * header claiming to be human. False or an exception fails closed with 403.
   */
  access?: {
    /**
     * Protected route prefixes. Matching is deliberately broad so it is never
     * narrower than your router: case-insensitive, percent-decoded, with `//`,
     * `.` and `..` normalised. RegExps are tested against every such variant.
     */
    paths: (string | RegExp)[];
    verify: (req: AegisRequest) => boolean | Promise<boolean>;
  };
  bots?: ClassifyOptions & {
    /** Action per bot category. Default: training → tarpit, others → allow. */
    policy?: Partial<Record<BotCategory, BotAction>>;
    /** Action when the User-Agent header is missing. Default `allow`. */
    missingUserAgent?: BotAction;
  };
  /**
   * Honeypot entry path. The entry and signed child links mark the client
   * for `flagTtlMs`; unknown descendants return 404 without flagging. Add it to robots.txt
   * `Disallow` so only non-compliant crawlers fall in. `false` disables.
   * Default `/documents/archive`.
   */
  trapPath?: string | false;
  /** How long a trapped client keeps getting tarpitted. Default 1 hour. */
  flagTtlMs?: number;
  /**
   * Key used to remember a trapped client. Default: IP, unaffected by UA rotation.
   * Shared NATs share flags; prefer a verified session/account ID when available.
   * Never use an unverified cookie/header as identity.
   * Return `null` to skip flagging.
   */
  flagKey?: (req: AegisRequest) => string | null;
  /** Storage for flagged clients (swap for Redis in multi-instance setups). */
  store?: FlagStore;
  tarpit?: {
    /**
     * Server-only secret used to derive document content and canaries with HMAC.
     * Set the same high-entropy secret on every instance to keep pages stable
     * across workers and restarts. Omitted: a random key per engine instance.
     * Never send this value to the browser.
     */
    secret?: string;
    /** Artificial delay before tarpit responses. Default 1500 ms. */
    delayMs?: number;
    /** Maze links per page. Default 6. */
    links?: number;
    /**
     * Fraction of tarpit pages (0–1) that are leaves with no onward links, so
     * a crawler hits believable dead ends instead of an obviously bottomless
     * tree. Default 0.3.
     */
    leafRate?: number;
    /** Paragraphs per page. Default 4. */
    paragraphs?: number;
    /**
     * Override decoy word pools so the content matches the host site's
     * language / domain instead of the default English "internal records".
     */
    content?: Partial<TarpitContent>;
    /** Optional curated document content for this URL, in the site's own language.
     * Return stable, non-sensitive content. Canary and signed links are preserved.
     */
    document?: (
      req: AegisRequest,
    ) => { title: string; paragraphs: string[] } | Promise<{ title: string; paragraphs: string[] }>;
    /** Site name shown in the tarpit page header/footer. Default `Documents`. */
    siteName?: string;
    /**
     * Fully customise the tarpit page HTML (e.g. render inside your real site
     * template). Receives the payload; return the complete HTML document. When
     * set, `siteName` is ignored.
     */
    render?: (payload: TarpitPayload) => string;
    /**
     * Extra / overriding HTTP headers for tarpit responses. By default tarpit
     * pages send ordinary-looking headers (no `X-Robots-Tag`, no `no-store`) so
     * they don't stand out — `noindex` is carried in the page `<meta>` instead.
     * Re-add `{ 'x-robots-tag': 'noindex, nofollow' }` here if you'd rather be
     * explicit at the header level.
     */
    headers?: Record<string, string>;
    /** Status code for tarpit pages. Default 200 (so scrapers keep going). */
    status?: number;
    /**
     * Include the deterrent "this is synthetic decoy data" notice on tarpit
     * pages. It announces the page as a decoy, so a reasoning agent recognises
     * it instantly — off by default so the page reads like a real document.
     * The canary is woven into the page body regardless, so leak attribution
     * still works. Default `false`.
     */
    notice?: boolean;
    /**
     * Prefix for the canary woven into tarpit pages. Default `doc`.
     * Set a site-specific prefix to match your document codes. The complete
     * canary is reported in the `tarpit` event for attribution.
     */
    canaryPrefix?: string;
    /** Stable per document by default. `crawler-day` opts into visible UA/day
     * differences for attribution, at the cost of easy differential detection. */
    canaryScope?: 'document' | 'crawler-day';
    /**
     * Max tarpit responses held open at once. Beyond this, tarpit pages are
     * sent without delay so slow responses cannot exhaust your own sockets.
     * Default 64.
     */
    maxConcurrent?: number;
  };
  /** Prompt-injection screening of JSON / form bodies. `false` disables. */
  sanitize?:
    | false
    | (SanitizeOptions & {
        /** Only screen requests whose path matches. Default: all POST/PUT/PATCH.
         * Same broad matching as `access.paths` (case-insensitive, decoded,
         * normalised), so `/API/chat` cannot skip a `/api` rule. */
        paths?: (string | RegExp)[];
        /**
         * Body fields to screen, as dot paths with `*` wildcards, e.g.
         * `['prompt', 'messages.*.content']`. Default: every string.
         */
        fields?: string[];
        /** Status for blocked requests. Default 400. (Default `mode` here is `block`.) */
        blockStatus?: number;
        /** Bodies nested deeper than this are rejected. Default 64. */
        maxDepth?: number;
        /**
         * Max number of string values screened per body. Each string runs the
         * full rule set, so an unbounded count lets a small JSON body (many
         * tiny strings) stall the event loop. Default 2000.
         */
        maxStrings?: number;
        /** Max total characters across all screened strings. Default 1 000 000. */
        maxTotalChars?: number;
      });
  /** Serve `GET /robots.txt` with AI opt-out rules. Default off. */
  robotsTxt?: boolean | RobotsTxtOptions;
  /** Telemetry hook. */
  onEvent?: (event: AegisEvent) => void;
}

const DEFAULT_POLICY: Record<BotCategory, BotAction> = {
  'ai-training': 'tarpit',
  'ai-search': 'allow',
  'ai-assistant': 'allow',
  automation: 'allow',
};

function header(req: AegisRequest, name: string): string | undefined {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Default flag key: client IP, so a new User-Agent cannot reset the flag. */
export function defaultFlagKey(req: AegisRequest): string | null {
  if (!req.ip) return null;
  return `ip:${req.ip}`;
}

/**
 * Should a hit on the trap path mark the client as a scraper?
 *
 * Browsers send Fetch Metadata (`Sec-Fetch-*`) headers. A request that a
 * *different* site caused (`<img src>` on evil.example) or a same-origin
 * sub-resource (an image in a user comment) must not flag the visitor —
 * otherwise anyone could get real users tarpitted. Only top-level
 * navigations, or clients that send no Fetch Metadata at all (scrapers,
 * HTTP libraries), are flagged.
 */
export function isTrapHitFlaggable(req: AegisRequest): boolean {
  const site = header(req, 'sec-fetch-site');
  const dest = header(req, 'sec-fetch-dest');
  if (site === undefined && dest === undefined) return true;
  if (site === 'cross-site' || site === 'same-site') return false;
  return dest === undefined || dest === 'document';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

class BodyLimitError extends Error {
  constructor(readonly code: 'body_too_deep' | 'body_too_large') {
    super(code);
  }
}

/**
 * Cheap pre-pass: count strings / characters / depth without running any
 * detection, so oversized bodies are rejected before the expensive work.
 * Iterative, so hostile nesting cannot overflow the stack.
 */
function measureBody(
  body: unknown,
  limits: { maxDepth: number; maxStrings: number; maxTotalChars: number; fields?: string[] },
): void {
  let strings = 0;
  let chars = 0;
  const { fields } = limits;
  const stack: [unknown, number, string][] = [[body, 0, '']];
  while (stack.length) {
    const [value, depth, path] = stack.pop()!;
    if (depth > limits.maxDepth) throw new BodyLimitError('body_too_deep');
    if (typeof value === 'string') {
      // Only strings that will actually be screened count toward the budget.
      if (fields && !fields.some((f) => matchPath(f, path))) continue;
      strings++;
      chars += value.length;
      if (strings > limits.maxStrings || chars > limits.maxTotalChars) {
        throw new BodyLimitError('body_too_large');
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) =>
        stack.push([v, depth + 1, fields ? (path ? `${path}.${i}` : String(i)) : '']),
      );
    } else if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value))
        stack.push([v, depth + 1, fields ? (path ? `${path}.${k}` : k) : '']);
    }
  }
}

/**
 * Does `path` fall under the field `pattern`? A pattern covers its whole
 * subtree: `body` matches `body`, `body.0`, `body.text`; `messages.*.content`
 * also matches OpenAI-style `messages.0.content.1.text` content-part arrays.
 * (Exact matching let attackers bypass screening by wrapping text in an array.)
 */
function matchPath(pattern: string, path: string): boolean {
  const p = pattern.split('.');
  const q = path.split('.');
  if (q.length < p.length) return false;
  return p.every((seg, i) => seg === '*' || seg === q[i]);
}

/** Collapse empty / `.` segments and resolve `..`, keeping a trailing slash. */
function normalizeSegments(path: string): string {
  const stack: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return '/' + stack.join('/') + (stack.length && path.endsWith('/') ? '/' : '');
}

/**
 * Every spelling a router might treat as the same route. Frameworks differ —
 * Express routes case-insensitively and decodes parameters, others decode the
 * whole path or collapse `//` and `..`. If rule matching is narrower than the
 * app's router, a request can skip `access` / `sanitize` yet still reach the
 * handler (e.g. `/PRIVATE/secret`, `/private/%73ecret`, `/API/comments`).
 * Matching any variant only ever checks *more* paths, so it fails safe.
 */
function pathVariants(path: string): string[] {
  const out = new Set<string>();
  let current = path;
  // Decode repeatedly (bounded) so double-encoding cannot hide a segment.
  for (let i = 0; i < 3; i++) {
    out.add(current);
    out.add(normalizeSegments(current));
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break; // malformed encoding: keep what we have
    }
    if (next === current) break;
    current = next;
  }
  for (const v of [...out]) out.add(v.toLowerCase());
  return [...out];
}

function pathMatches(rules: (string | RegExp)[], path: string): boolean {
  const variants = pathVariants(path);
  return rules.some((r) => {
    if (typeof r !== 'string') return variants.some((v) => ((r.lastIndex = 0), r.test(v)));
    const rule = r.toLowerCase();
    const prefix = rule.endsWith('/') ? rule : rule + '/';
    return variants.some((v) => v === rule || v.startsWith(prefix));
  });
}

/**
 * Framework-neutral decision engine. Adapters translate their request objects
 * into `AegisRequest` and act on the returned `AegisDecision`.
 */
export function createAegisEngine(options: AegisNodeOptions = {}) {
  const policy = { ...DEFAULT_POLICY, ...options.bots?.policy };
  const trapPath =
    options.trapPath === false
      ? null
      : (options.trapPath ?? '/documents/archive').replace(/\/+$/, '');
  const store = options.store ?? new MemoryFlagStore();
  const flagTtl = options.flagTtlMs ?? 60 * 60 * 1000;
  const flagKey = options.flagKey ?? defaultFlagKey;
  const tarpitCfg = {
    delayMs: 1500,
    links: 6,
    leafRate: 0.3,
    paragraphs: 4,
    status: 200,
    notice: false,
    maxConcurrent: 64,
    ...options.tarpit,
  };
  if (tarpitCfg.secret !== undefined && tarpitCfg.secret.length === 0) {
    throw new Error('tarpit.secret must not be empty');
  }
  // Lazy Web Crypto initialization keeps Fetch runtimes usable without Node
  // built-ins; Node 18 environments without global crypto use its native API.
  let signer: Promise<{ subtle: SubtleCrypto; key: CryptoKey }> | undefined;
  async function deriveSeed(parts: string[]): Promise<string> {
    signer ??= (async () => {
      const crypto = globalThis.crypto ?? (await import('node:crypto')).webcrypto;
      const subtle = crypto.subtle as SubtleCrypto;
      const algorithm: HmacKeyGenParams = { name: 'HMAC', hash: 'SHA-256' };
      if (tarpitCfg.secret === undefined) warnMissingSecret();
      const key =
        tarpitCfg.secret === undefined
          ? await subtle.generateKey(algorithm, false, ['sign'])
          : await subtle.importKey(
              'raw',
              new TextEncoder().encode(tarpitCfg.secret),
              algorithm,
              false,
              ['sign'],
            );
      return { subtle, key };
    })();
    const { subtle, key } = await signer;
    const signature = await subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(JSON.stringify(parts)),
    );
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  }
  let activeTarpits = 0;
  const robots =
    options.robotsTxt === true
      ? buildRobotsTxt()
      : options.robotsTxt
        ? buildRobotsTxt(options.robotsTxt)
        : null;
  // No trailing slash: robots.txt rules are prefix matches, so `/documents/archive`
  // covers both the exact entry (what the DOM honeypot links to) and its signed
  // children. `/documents/archive/` would leave the entry open, letting compliant
  // crawlers (search engines, intranet indexers) walk in and get their IP flagged.
  const robotsWithTrap =
    robots && trapPath ? `${robots}User-agent: *\nDisallow: ${trapPath}\n` : robots;
  const emit = (type: AegisEvent['type'], req: AegisRequest, detail: Record<string, unknown>) =>
    options.onEvent?.({
      type,
      request: { method: req.method, path: req.path, ...(req.ip ? { ip: req.ip } : {}) },
      detail,
    });

  async function tarpitResponse(
    req: AegisRequest,
    reason: string,
    bot: BotClassification,
  ): Promise<AegisDecision['response']> {
    const who = bot.name ?? `ua${hashString(header(req, 'user-agent') ?? '').toString(36)}`;
    const day = new Date().toISOString().slice(0, 10);
    // Content and document identity stay stable across UAs and dates by default.
    const [contentSeed, canarySeed] = await Promise.all([
      deriveSeed(['content', req.path]),
      deriveSeed(
        tarpitCfg.canaryScope === 'crawler-day'
          ? ['canary', req.path, who, day]
          : ['canary', req.path],
      ),
    ]);
    const canary = createCanary({
      prefix: tarpitCfg.canaryPrefix ?? 'doc',
      seed: canarySeed,
    });
    const payload = buildTarpitPayload({
      seed: contentSeed,
      canary,
      paragraphs: tarpitCfg.paragraphs,
      ...(tarpitCfg.content ? { content: tarpitCfg.content } : {}),
      // Decoy pages should not announce themselves; the canary still rides in
      // the body. Opt back in with `tarpit.notice` to deter compliant scrapers.
      ...(tarpitCfg.notice ? {} : { notice: false as const }),
      ...(trapPath
        ? { maze: { basePath: trapPath, count: tarpitCfg.links, leafRate: tarpitCfg.leafRate } }
        : {}),
    });
    if (tarpitCfg.document) {
      // A failing hook must not turn into a 500 that only trapped clients see
      // (that alone would reveal the trap). Fall back to generated content.
      try {
        const document = await tarpitCfg.document(req);
        payload.title = document.title;
        payload.paragraphs = [...document.paragraphs];
      } catch (err) {
        emit('error', req, { hook: 'document', message: errorMessage(err) });
      }
    }
    payload.links = await Promise.all(
      payload.links.map(async (link) => ({
        ...link,
        href: `${link.href}-${(await deriveSeed(['link', link.href])).slice(0, 24)}`,
      })),
    );
    payload.text = [
      payload.notice,
      payload.title,
      payload.meta,
      ...payload.paragraphs,
      ...payload.links.map((link) => `${link.text}: ${link.href}`),
    ]
      .filter(Boolean)
      .join('\n\n');
    emit('tarpit', req, { reason, canary: payload.canary, crawler: who, day });
    return {
      status: tarpitCfg.status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Ordinary-looking caching; `noindex` lives in the page <meta> so the
        // headers don't flag the page as special. Override via `tarpit.headers`.
        'cache-control': 'private, max-age=0',
        ...tarpitCfg.headers,
      },
      // A custom renderer wins; otherwise (or if it throws) render a realistic document page.
      body: renderBody(req, payload),
    };
  }

  function renderBody(req: AegisRequest, payload: TarpitPayload): string {
    if (tarpitCfg.render) {
      try {
        return tarpitCfg.render(payload);
      } catch (err) {
        emit('error', req, { hook: 'render', message: errorMessage(err) });
      }
    }
    return renderTarpitHtml(payload, { siteName: tarpitCfg.siteName });
  }

  function sanitizeBody(
    body: unknown,
    opts: Exclude<AegisNodeOptions['sanitize'], false | undefined>,
  ) {
    const findings: FieldFinding[] = [];
    const scores: number[] = [];
    let blocked = false;
    let changed = false;
    measureBody(body, {
      maxDepth: opts.maxDepth ?? 64,
      maxStrings: opts.maxStrings ?? 2000,
      maxTotalChars: opts.maxTotalChars ?? 1_000_000,
      ...(opts.fields ? { fields: opts.fields } : {}),
    });
    const visit = (value: unknown, path: string, depth: number): unknown => {
      if (typeof value === 'string') {
        if (opts.fields && !opts.fields.some((f) => matchPath(f, path))) return value;
        const r = sanitizePrompt(value, { mode: 'block', ...opts });
        if (r.level !== 'none' || r.changed) {
          findings.push({
            path,
            level: r.level,
            score: r.score,
            rules: r.detection.matches.map((m) => m.ruleId),
            actions: r.actions,
          });
        }
        scores.push(r.score);
        if (r.blocked) blocked = true;
        if (r.changed) changed = true;
        return r.text;
      }
      if (Array.isArray(value))
        return value.map((v, i) => visit(v, path ? `${path}.${i}` : String(i), depth + 1));
      if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value))
          out[k] = visit(v, path ? `${path}.${k}` : k, depth + 1);
        return out;
      }
      return value;
    };
    const next = visit(body, '', 0);
    return {
      body: next,
      changed,
      blocked,
      findings,
      score: scores.reduce((a, b) => Math.max(a, b), 0),
    };
  }

  async function inspect(req: AegisRequest): Promise<AegisDecision> {
    const reasons: string[] = [];
    const ua = header(req, 'user-agent');
    const bot = classifyUserAgent(ua, options.bots);
    const clientKey = flagKey(req);

    // robots.txt
    if (robotsWithTrap && req.method === 'GET' && req.path === '/robots.txt') {
      return {
        action: 'respond',
        reasons: ['robots.txt'],
        bot,
        response: {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: robotsWithTrap,
        },
      };
    }

    // A reserved prefix is not evidence that an arbitrary URL is a document.
    // Only the explicit entry and server-issued child links are traps. Anything
    // else under the prefix is treated like any other path — it falls through
    // to the app, which renders its *own* 404. (An engine-made 404 would differ
    // from the site's real one and let a prober locate the trap prefix.)
    let isTrap = false;
    if (trapPath) {
      if (req.path === trapPath) isTrap = true;
      else if (req.path.startsWith(trapPath + '/')) {
        const match = req.path.match(/^(.*)-([0-9a-f]{24})$/);
        if (match) {
          const expected = (await deriveSeed(['link', match[1]!])).slice(0, 24);
          let difference = 0;
          for (let i = 0; i < expected.length; i++)
            difference |= expected.charCodeAt(i) ^ match[2]!.charCodeAt(i);
          isTrap = difference === 0;
        }
        if (!isTrap) reasons.push('trap-prefix:unknown');
      }
    }

    if (options.access && pathMatches(options.access.paths, req.path)) {
      let allowed = false;
      try {
        allowed = (await options.access.verify(req)) === true;
      } catch {
        /* fail closed */
      }
      if (!allowed) {
        emit('blocked', req, { reason: 'access-denied' });
        return {
          action: 'block',
          reasons: ['access-denied'],
          bot,
          response: {
            status: 403,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'private, no-store',
            },
            body: 'Access denied.',
          },
        };
      }
    }

    // Trap hit → flag client, serve maze.
    if (isTrap) {
      const flaggable = isTrapHitFlaggable(req);
      if (clientKey && flaggable) await store.set(clientKey, flagTtl);
      emit('trap', req, {
        userAgent: ua ?? null,
        bot: bot.name,
        flagged: Boolean(clientKey && flaggable),
      });
      reasons.push(flaggable ? 'trap-path' : 'trap-path:not-flagged');
      return {
        action: 'tarpit',
        reasons,
        bot,
        response: await tarpitResponse(req, 'trap-path', bot),
        delayMs: tarpitCfg.delayMs,
      };
    }

    // Previously trapped client.
    if (clientKey && (await store.has(clientKey))) {
      reasons.push('flagged-client');
      return {
        action: 'tarpit',
        reasons,
        bot,
        response: await tarpitResponse(req, 'flagged-client', bot),
        delayMs: tarpitCfg.delayMs,
      };
    }

    // Bot policy.
    const action: BotAction =
      bot.isBot && bot.category
        ? policy[bot.category]
        : bot.missingUserAgent
          ? (options.bots?.missingUserAgent ?? 'allow')
          : 'allow';
    if (bot.isBot || bot.missingUserAgent)
      emit('bot', req, { name: bot.name, category: bot.category, action });
    if (action === 'block') {
      reasons.push(`bot:${bot.name ?? 'missing-ua'}`);
      emit('blocked', req, { reason: 'bot', name: bot.name });
      return {
        action: 'block',
        reasons,
        bot,
        response: {
          status: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: 'Automated access is not permitted.',
        },
      };
    }
    if (action === 'tarpit') {
      reasons.push(`bot:${bot.name ?? 'missing-ua'}`);
      return {
        action: 'tarpit',
        reasons,
        bot,
        response: await tarpitResponse(req, `bot:${bot.name}`, bot),
        delayMs: tarpitCfg.delayMs,
      };
    }

    // Body screening.
    const s = options.sanitize === false ? null : (options.sanitize ?? {});
    const isWrite = /^(?:POST|PUT|PATCH)$/i.test(req.method);
    if (
      s &&
      isWrite &&
      req.body !== undefined &&
      req.body !== null &&
      (!s.paths || pathMatches(s.paths, req.path))
    ) {
      let r: ReturnType<typeof sanitizeBody>;
      try {
        r = sanitizeBody(req.body, s);
      } catch (err) {
        if (!(err instanceof BodyLimitError)) throw err;
        const reason = err.code === 'body_too_deep' ? 'body-too-deep' : 'body-too-large';
        reasons.push(reason);
        emit('blocked', req, { reason });
        return {
          action: 'block',
          reasons,
          bot,
          response: {
            status: s.blockStatus ?? 400,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ error: err.code }),
          },
        };
      }
      const decision: AegisDecision = {
        action: 'next',
        reasons,
        bot,
        sanitized: { body: r.body, changed: r.changed, score: r.score, findings: r.findings },
      };
      if (r.findings.some((f) => f.level !== 'none'))
        emit('injection', req, { findings: r.findings });
      if (r.blocked) {
        reasons.push('prompt-injection');
        emit('blocked', req, { reason: 'prompt-injection', findings: r.findings });
        decision.action = 'block';
        decision.response = {
          status: s.blockStatus ?? 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            error: 'prompt_injection_detected',
            fields: r.findings.filter((f) => f.level !== 'none').map((f) => f.path),
          }),
        };
      }
      return decision;
    }

    return { action: 'next', reasons, bot };
  }

  /**
   * Wait out a decision's tarpit delay, respecting `tarpit.maxConcurrent`.
   * Adapters call this before sending `decision.response`.
   */
  async function hold(decision: AegisDecision): Promise<void> {
    if (!decision.delayMs || activeTarpits >= tarpitCfg.maxConcurrent) return;
    activeTarpits++;
    try {
      // Jitter the delay (0.5×–1.5×) so tarpit responses don't share one
      // fixed, fingerprintable latency that marks them out from real pages.
      await sleep(Math.round(decision.delayMs * (0.5 + Math.random())));
    } finally {
      activeTarpits--;
    }
  }

  return {
    inspect,
    hold,
    store,
    options,
    /** Number of tarpit responses currently being delayed. */
    get activeTarpits() {
      return activeTarpits;
    },
  };
}

export type AegisEngine = ReturnType<typeof createAegisEngine>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Without `tarpit.secret` each engine signs with its own random key: links
 * issued by one instance 404 on another and every restart invalidates them.
 * That is silent breakage behind a load balancer, so say it once. Skipped in
 * test runs to keep output clean.
 */
function warnMissingSecret(): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (env?.NODE_ENV === 'test') return;
  console.warn(
    '[prompt-aegis] tarpit.secret is not set: using a random per-instance key. ' +
      'Signed tarpit links will 404 on other instances and after restarts. ' +
      'Set the same high-entropy tarpit.secret on every instance (e.g. from an env var).',
  );
}
