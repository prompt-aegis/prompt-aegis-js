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
        /** Default mode here is `block` (high/critical risk → 400). */
        /** Status for blocked requests. Default 400. */
        blockStatus?: number;
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

function matchPath(pattern: string, path: string): boolean {
  const p = pattern.split('.');
  const q = path.split('.');
  if (p.length !== q.length) return false;
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
  const tarpitCfg = { delayMs: 1500, links: 6, paragraphs: 4, status: 200, ...options.tarpit };
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

  function tarpitResponse(req: AegisRequest, reason: string): AegisDecision['response'] {
    const payload = buildTarpitPayload({
      seed: `${req.path}`,
      paragraphs: tarpitCfg.paragraphs,
      ...(trapPath ? { maze: { basePath: trapPath, count: tarpitCfg.links } } : {}),
    });
    emit('tarpit', req, { reason, canary: payload.canary });
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
    const visit = (value: unknown, path: string): unknown => {
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
        return value.map((v, i) => visit(v, path ? `${path}.${i}` : String(i)));
      if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = visit(v, path ? `${path}.${k}` : k);
        return out;
      }
      return value;
    };
    const next = visit(body, '');
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
    const clientKey = req.ip ? `ip:${req.ip}` : null;

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
      if (clientKey) await store.set(clientKey, flagTtl);
      emit('trap', req, { userAgent: ua ?? null, bot: bot.name });
      reasons.push('trap-path');
      return {
        action: 'tarpit',
        reasons,
        bot,
        response: tarpitResponse(req, 'trap-path'),
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
        response: tarpitResponse(req, 'flagged-client'),
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
        response: tarpitResponse(req, `bot:${bot.name}`),
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
      const r = sanitizeBody(req.body, s);
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

  return { inspect, store, options };
}

export type AegisEngine = ReturnType<typeof createAegisEngine>;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
