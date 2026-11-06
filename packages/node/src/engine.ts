import {
  buildRobotsTxt,
  buildTarpitPayload,
  classifyUserAgent,
  hashString,
  renderTarpitHtml,
  sanitizePrompt,
  type BotCategory,
  type BotClassification,
  type ClassifyOptions,
  type RobotsTxtOptions,
  type SanitizeOptions,
  type SanitizeResult,
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
  type: 'bot' | 'trap' | 'injection' | 'blocked' | 'tarpit';
  request: Pick<AegisRequest, 'method' | 'path' | 'ip'>;
  detail: Record<string, unknown>;
}

export interface AegisNodeOptions {
  bots?: ClassifyOptions & {
    /** Action per bot category. Default: training → tarpit, others → allow. */
    policy?: Partial<Record<BotCategory, BotAction>>;
    /** Action when the User-Agent header is missing. Default `allow`. */
    missingUserAgent?: BotAction;
  };
  /**
   * Honeypot path prefix. Any hit marks the client as a scraper (for
   * `flagTtlMs`) and is answered with an endless maze. Add it to robots.txt
   * `Disallow` so only non-compliant crawlers fall in. `false` disables.
   * Default `/__aegis/trap`.
   */
  trapPath?: string | false;
  /** How long a trapped client keeps getting tarpitted. Default 1 hour. */
  flagTtlMs?: number;
  /**
   * Key used to remember a trapped client. Default: IP + User-Agent hash
   * (`defaultFlagKey`), so other people behind the same NAT are not affected.
   * Return `null` to skip flagging.
   */
  flagKey?: (req: AegisRequest) => string | null;
  /** Storage for flagged clients (swap for Redis in multi-instance setups). */
  store?: FlagStore;
  tarpit?: {
    /** Artificial delay before tarpit responses. Default 1500 ms. */
    delayMs?: number;
    /** Maze links per page. Default 6. */
    links?: number;
    /** Paragraphs per page. Default 4. */
    paragraphs?: number;
    /** Status code for tarpit pages. Default 200 (so scrapers keep going). */
    status?: number;
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
        /** Only screen requests whose path matches. Default: all POST/PUT/PATCH. */
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

/** Default flag key: client IP + hash of the User-Agent. */
export function defaultFlagKey(req: AegisRequest): string | null {
  if (!req.ip) return null;
  return `ip:${req.ip}|ua:${hashString(header(req, 'user-agent') ?? '').toString(36)}`;
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

function pathMatches(rules: (string | RegExp)[], path: string): boolean {
  return rules.some((r) =>
    typeof r === 'string'
      ? path === r || path.startsWith(r.endsWith('/') ? r : r + '/')
      : r.test(path),
  );
}

/**
 * Framework-neutral decision engine. Adapters translate their request objects
 * into `AegisRequest` and act on the returned `AegisDecision`.
 */
export function createAegisEngine(options: AegisNodeOptions = {}) {
  const policy = { ...DEFAULT_POLICY, ...options.bots?.policy };
  const trapPath =
    options.trapPath === false ? null : (options.trapPath ?? '/__aegis/trap').replace(/\/+$/, '');
  const store = options.store ?? new MemoryFlagStore();
  const flagTtl = options.flagTtlMs ?? 60 * 60 * 1000;
  const flagKey = options.flagKey ?? defaultFlagKey;
  const tarpitCfg = {
    delayMs: 1500,
    links: 6,
    paragraphs: 4,
    status: 200,
    maxConcurrent: 64,
    ...options.tarpit,
  };
  let activeTarpits = 0;
  const robots =
    options.robotsTxt === true
      ? buildRobotsTxt()
      : options.robotsTxt
        ? buildRobotsTxt(options.robotsTxt)
        : null;
  const robotsWithTrap =
    robots && trapPath ? `${robots}User-agent: *\nDisallow: ${trapPath}/\n` : robots;
  const emit = (type: AegisEvent['type'], req: AegisRequest, detail: Record<string, unknown>) =>
    options.onEvent?.({
      type,
      request: { method: req.method, path: req.path, ...(req.ip ? { ip: req.ip } : {}) },
      detail,
    });

  function tarpitResponse(
    req: AegisRequest,
    reason: string,
    bot: BotClassification,
  ): AegisDecision['response'] {
    // Seed = path + crawler identity + UTC day: stable for one crawler (cache
    // friendly), different across crawlers and days so a leaked canary tells
    // you who took it and roughly when.
    const who = bot.name ?? `ua${hashString(header(req, 'user-agent') ?? '').toString(36)}`;
    const day = new Date().toISOString().slice(0, 10);
    const payload = buildTarpitPayload({
      seed: `${req.path}|${who}|${day}`,
      paragraphs: tarpitCfg.paragraphs,
      ...(trapPath ? { maze: { basePath: trapPath, count: tarpitCfg.links } } : {}),
    });
    emit('tarpit', req, { reason, canary: payload.canary, crawler: who, day });
    return {
      status: tarpitCfg.status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-robots-tag': 'noindex, nofollow, noarchive',
        'cache-control': 'no-store',
      },
      body: renderTarpitHtml(payload, {
        title: `Record ${hashString(req.path).toString(36).toUpperCase()}`,
      }),
    };
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

    // Trap hit → flag client, serve maze.
    if (trapPath && (req.path === trapPath || req.path.startsWith(trapPath + '/'))) {
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
        response: tarpitResponse(req, 'trap-path', bot),
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
        response: tarpitResponse(req, 'flagged-client', bot),
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
        response: tarpitResponse(req, `bot:${bot.name}`, bot),
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
      await sleep(decision.delayMs);
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
