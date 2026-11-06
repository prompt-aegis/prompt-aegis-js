import {
  createAegisEngine,
  type AegisDecision,
  type AegisEngine,
  type AegisNodeOptions,
} from './engine';

/*
 * Adapters use minimal structural types so this package has zero runtime or
 * type dependencies on Express, Koa, Fastify or Hono.
 */

export interface AdapterOptions extends AegisNodeOptions {
  /** Reuse an existing engine (shares flag store between adapters). */
  engine?: AegisEngine;
  /**
   * Derive the client IP from `X-Forwarded-For`. Only enable behind proxies
   * you control. `true` = one proxy hop; a number = that many trusted hops.
   * The IP is taken counting from the **right** (entries on the left are
   * client-controlled and spoofable). Default `false` (socket address).
   */
  trustProxy?: boolean | number;
  /**
   * Read the client IP from a single header set by your CDN / edge, e.g.
   * `cf-connecting-ip` (Cloudflare) or `fly-client-ip`. Takes precedence over
   * `trustProxy`. Only use when every request passes through that CDN.
   */
  ipHeader?: string;
}

function engineFor(options: AdapterOptions): AegisEngine {
  return options.engine ?? createAegisEngine(options);
}

const headerValue = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v);

/** Resolve the client IP. Exported for custom integrations and tests. */
export function resolveClientIp(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  options: Pick<AdapterOptions, 'trustProxy' | 'ipHeader'> = {},
): string | undefined {
  if (options.ipHeader) {
    const v = headerValue(headers[options.ipHeader.toLowerCase()])?.split(',')[0]?.trim();
    if (v) return v;
  }
  if (options.trustProxy) {
    const hops = options.trustProxy === true ? 1 : Math.max(1, Math.floor(options.trustProxy));
    const list = (headerValue(headers['x-forwarded-for']) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) return list[Math.max(0, list.length - hops)];
  }
  return socketAddress;
}

const stripQuery = (url: string) => url.split('?')[0] || '/';

// ─── Express / Connect ────────────────────────────────────────────────────

interface ExpressReq {
  method: string;
  url: string;
  path?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  body?: unknown;
  aegis?: AegisDecision;
}
interface ExpressRes {
  status(code: number): ExpressRes;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}

/**
 * Express / Connect middleware. Mount **after** your body parser
 * (`express.json()`) so request bodies can be screened.
 */
export function aegisExpress(options: AdapterOptions = {}) {
  const engine = engineFor(options);
  return async function aegisMiddleware(
    req: ExpressReq,
    res: ExpressRes,
    next: (err?: unknown) => void,
  ) {
    try {
      const decision = await engine.inspect({
        method: req.method,
        path: req.path ?? stripQuery(req.originalUrl ?? req.url),
        headers: req.headers,
        ip: resolveClientIp(req.headers, req.ip ?? req.socket?.remoteAddress, options),
        body: req.body,
      });
      req.aegis = decision;
      if (decision.response) {
        await engine.hold(decision);
        res.status(decision.response.status);
        for (const [k, v] of Object.entries(decision.response.headers)) res.setHeader(k, v);
        res.send(decision.response.body);
        return;
      }
      if (decision.sanitized?.changed) req.body = decision.sanitized.body;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ─── Koa ──────────────────────────────────────────────────────────────────

interface KoaCtx {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  req?: { socket?: { remoteAddress?: string } };
  request: { body?: unknown };
  status: number;
  body: unknown;
  set(name: string, value: string): void;
  state: Record<string, unknown>;
}

/** Koa middleware. Mount after `koa-bodyparser` / `@koa/bodyparser`. */
export function aegisKoa(options: AdapterOptions = {}) {
  const engine = engineFor(options);
  return async function aegisMiddleware(ctx: KoaCtx, next: () => Promise<unknown>) {
    const decision = await engine.inspect({
      method: ctx.method,
      path: ctx.path,
      headers: ctx.headers,
      // Koa's ctx.ip uses the left-most (spoofable) X-Forwarded-For entry when
      // app.proxy is on, so prefer the raw socket address.
      ip: resolveClientIp(ctx.headers, ctx.req?.socket?.remoteAddress ?? ctx.ip, options),
      body: ctx.request.body,
    });
    ctx.state.aegis = decision;
    if (decision.response) {
      await engine.hold(decision);
      ctx.status = decision.response.status;
      for (const [k, v] of Object.entries(decision.response.headers)) ctx.set(k, v);
      ctx.body = decision.response.body;
      return;
    }
    if (decision.sanitized?.changed) ctx.request.body = decision.sanitized.body;
    await next();
  };
}

// ─── Fastify ──────────────────────────────────────────────────────────────

interface FastifyReq {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  body?: unknown;
  routeOptions?: { url?: string };
  aegis?: AegisDecision;
}
interface FastifyReply {
  code(status: number): FastifyReply;
  header(name: string, value: string): FastifyReply;
  send(body: string): unknown;
}
interface FastifyInstance {
  addHook(
    name: 'preHandler',
    hook: (req: FastifyReq, reply: FastifyReply) => Promise<unknown>,
  ): unknown;
  decorateRequest?(name: string, value: unknown): unknown;
}

/**
 * Fastify plugin (works with `fastify.register`). Runs as a `preHandler`
 * hook, so bodies are already parsed. Applies to the whole app (skip-override).
 */
export function aegisFastify(options: AdapterOptions = {}) {
  const engine = engineFor(options);
  const plugin = async function aegisPlugin(fastify: FastifyInstance) {
    fastify.decorateRequest?.('aegis', null);
    fastify.addHook('preHandler', async (req, reply) => {
      const decision = await engine.inspect({
        method: req.method,
        path: stripQuery(req.url),
        headers: req.headers,
        ip: resolveClientIp(req.headers, req.ip, options),
        body: req.body,
      });
      req.aegis = decision;
      if (decision.response) {
        await engine.hold(decision);
        reply.code(decision.response.status);
        for (const [k, v] of Object.entries(decision.response.headers)) reply.header(k, v);
        return reply.send(decision.response.body);
      }
      if (decision.sanitized?.changed) req.body = decision.sanitized.body;
      return undefined;
    });
  };
  (plugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
  (plugin as unknown as Record<symbol, unknown>)[Symbol.for('fastify.display-name')] =
    'prompt-aegis';
  return plugin;
}

// ─── Fetch API (Hono, Next.js route handlers, Bun, Deno, Workers) ─────────

export interface FetchResult {
  decision: AegisDecision;
  /** Send this and stop, when present. */
  response?: Response;
  /** Parsed (and possibly sanitized) JSON body, when the request had one. */
  body?: unknown;
}

/**
 * Inspect a WHATWG `Request`. The body is read from a clone, so the original
 * request stays readable.
 */
export function aegisFetch(options: AdapterOptions = {}) {
  const engine = engineFor(options);
  return async function inspectRequest(
    request: Request,
    ctx: { ip?: string } = {},
  ): Promise<FetchResult> {
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    let body: unknown;
    if (/^(?:POST|PUT|PATCH)$/i.test(request.method)) {
      const type = request.headers.get('content-type') ?? '';
      try {
        if (type.includes('application/json')) body = await request.clone().json();
        else if (type.includes('application/x-www-form-urlencoded'))
          body = Object.fromEntries(new URLSearchParams(await request.clone().text()));
        else if (type.startsWith('text/')) body = await request.clone().text();
      } catch {
        body = undefined;
      }
    }
    const decision = await engine.inspect({
      method: request.method,
      path: new URL(request.url).pathname,
      headers,
      ip: resolveClientIp(headers, ctx.ip, options),
      body,
    });
    const result: FetchResult = { decision };
    const finalBody = decision.sanitized ? decision.sanitized.body : body;
    if (finalBody !== undefined) result.body = finalBody;
    if (decision.response) {
      await engine.hold(decision);
      result.response = new Response(decision.response.body, {
        status: decision.response.status,
        headers: decision.response.headers,
      });
    }
    return result;
  };
}

interface HonoCtx {
  req: { raw: Request; header(name: string): string | undefined };
  set(key: string, value: unknown): void;
  env?: unknown;
}

/**
 * Hono middleware. Sanitized body is available as `c.get('aegisBody')`,
 * the decision as `c.get('aegis')`.
 */
export function aegisHono(
  options: AdapterOptions & {
    /** Socket address of the client, e.g. `(c) => getConnInfo(c).remote.address`. */
    getIp?: (c: HonoCtx) => string | undefined;
  } = {},
) {
  const inspect = aegisFetch(options);
  return async function aegisMiddleware(
    c: HonoCtx,
    next: () => Promise<void>,
  ): Promise<Response | void> {
    // `ipHeader` / `trustProxy` are applied inside aegisFetch; `getIp` supplies
    // the socket address (e.g. via `getConnInfo` from hono/<runtime>).
    const ip = options.getIp?.(c);
    const r = await inspect(c.req.raw, ip ? { ip } : {});
    c.set('aegis', r.decision);
    if (r.body !== undefined) c.set('aegisBody', r.body);
    if (r.response) return r.response;
    await next();
  };
}
