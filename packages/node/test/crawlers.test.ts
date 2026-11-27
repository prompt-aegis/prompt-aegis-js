import { describe, expect, it, vi } from 'vitest';
import { createAegisEngine, type DnsLookup } from '../src/index';

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0 Safari/537.36';
const get = (ua: string, ip?: string, extra: Record<string, string> = {}, path = '/books/1') => ({
  method: 'GET',
  path,
  headers: { 'user-agent': ua, ...extra },
  ...(ip ? { ip } : {}),
});

/** Fake DNS: real Googlebot IP 66.249.66.1 ↔ crawl-66-249-66-1.googlebot.com. */
function fakeDns(): DnsLookup & { reverse: ReturnType<typeof vi.fn> } {
  const ptr: Record<string, string[]> = {
    '66.249.66.1': ['crawl-66-249-66-1.googlebot.com.'],
    '203.0.113.9': ['crawl-1-2-3-4.googlebot.com'], // PTR lies: forward does not match
    '198.51.100.7': ['host.attacker.example'],
  };
  const forward: Record<string, string[]> = {
    'crawl-66-249-66-1.googlebot.com': ['66.249.66.1'],
    'crawl-1-2-3-4.googlebot.com': ['1.2.3.4'],
  };
  return {
    reverse: vi.fn(async (ip: string) => {
      if (!ptr[ip]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return ptr[ip]!;
    }),
    resolve: async (host: string) => forward[host] ?? [],
  };
}

describe('bots.verifySearchEngines', () => {
  it('lets a genuine Googlebot through', async () => {
    const e = createAegisEngine({ bots: { verifySearchEngines: { lookup: fakeDns() } } });
    expect((await e.inspect(get(GOOGLEBOT, '66.249.66.1'))).action).toBe('next');
  });

  it('accepts an IPv4-mapped IPv6 address', async () => {
    const e = createAegisEngine({ bots: { verifySearchEngines: { lookup: fakeDns() } } });
    expect((await e.inspect(get(GOOGLEBOT, '::ffff:66.249.66.1'))).action).toBe('next');
  });

  for (const [why, ip] of [
    ['no PTR record', '192.0.2.50'],
    ['PTR outside google domains', '198.51.100.7'],
    ['PTR does not resolve back to the IP', '203.0.113.9'],
  ] as const) {
    it(`tarpits an impostor: ${why}`, async () => {
      const e = createAegisEngine({
        tarpit: { delayMs: 0 },
        bots: { verifySearchEngines: { lookup: fakeDns() } },
      });
      const d = await e.inspect(get(GOOGLEBOT, ip));
      expect(d.action).toBe('tarpit');
      expect(d.bot.name).toBe('Googlebot-impostor');
    });
  }

  it('honours a custom action for impostors', async () => {
    const e = createAegisEngine({
      bots: { verifySearchEngines: { lookup: fakeDns(), action: 'block' } },
    });
    expect((await e.inspect(get(GOOGLEBOT, '198.51.100.7'))).response?.status).toBe(403);
  });

  it('caches per IP: repeated requests do one DNS lookup', async () => {
    const dns = fakeDns();
    const e = createAegisEngine({ bots: { verifySearchEngines: { lookup: dns } } });
    for (let i = 0; i < 5; i++) await e.inspect(get(GOOGLEBOT, '66.249.66.1'));
    expect(dns.reverse).toHaveBeenCalledTimes(1);
  });

  it('does not look up ordinary browsers or engines without a DNS scheme', async () => {
    const dns = fakeDns();
    const e = createAegisEngine({ bots: { verifySearchEngines: { lookup: dns } } });
    await e.inspect(get(BROWSER, '198.51.100.7'));
    await e.inspect(
      get('DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)', '198.51.100.7'),
    );
    expect(dns.reverse).not.toHaveBeenCalled();
  });

  it('a transient DNS failure lets the crawler through and is retried', async () => {
    vi.useFakeTimers();
    try {
      let down = true;
      const dns = fakeDns();
      const reverse = dns.reverse.getMockImplementation()!;
      dns.reverse.mockImplementation(async (ip: string) => {
        if (down) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
        return reverse(ip);
      });
      const errors: string[] = [];
      const e = createAegisEngine({
        tarpit: { delayMs: 0 },
        bots: { verifySearchEngines: { lookup: dns } },
        onEvent: (ev) => {
          if (ev.type === 'error') errors.push(String(ev.detail?.hook));
        },
      });
      expect((await e.inspect(get(GOOGLEBOT, '66.249.66.1'))).action).toBe('next');
      expect(errors).toContain('verifySearchEngines');
      down = false;
      // Remembered briefly, then looked up again.
      await e.inspect(get(GOOGLEBOT, '66.249.66.1'));
      expect(dns.reverse).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_001);
      expect((await e.inspect(get(GOOGLEBOT, '66.249.66.1'))).action).toBe('next');
      expect(dns.reverse).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hanging resolver times out instead of stalling the request', async () => {
    const e = createAegisEngine({
      bots: {
        verifySearchEngines: {
          timeoutMs: 20,
          lookup: { reverse: () => new Promise(() => {}), resolve: async () => [] },
        },
      },
    });
    expect((await e.inspect(get(GOOGLEBOT, '66.249.66.1'))).action).toBe('next');
  });

  it('concurrent requests from one IP share a single lookup', async () => {
    const dns = fakeDns();
    const e = createAegisEngine({ bots: { verifySearchEngines: { lookup: dns } } });
    await Promise.all(Array.from({ length: 20 }, () => e.inspect(get(GOOGLEBOT, '66.249.66.1'))));
    expect(dns.reverse).toHaveBeenCalledTimes(1);
  });

  it('is off by default (a Googlebot UA alone is trusted)', async () => {
    const e = createAegisEngine({});
    expect((await e.inspect(get(GOOGLEBOT, '198.51.100.7'))).action).toBe('next');
  });
});

describe('trapMode', () => {
  const crossSite = {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
  };

  it("'safe' (default): forged cross-site Fetch Metadata avoids flagging", async () => {
    const e = createAegisEngine({ tarpit: { delayMs: 0 } });
    await e.inspect(get(BROWSER, '10.0.0.5', crossSite, '/documents/archive'));
    expect((await e.inspect(get(BROWSER, '10.0.0.5'))).action).toBe('next');
  });

  it("'strict': every trap hit flags, whatever the headers claim", async () => {
    const e = createAegisEngine({ trapMode: 'strict', tarpit: { delayMs: 0 } });
    await e.inspect(get(BROWSER, '10.0.0.5', crossSite, '/documents/archive'));
    expect((await e.inspect(get(BROWSER, '10.0.0.5'))).action).toBe('tarpit');
  });
});

describe('rateLimit', () => {
  it('returns 429 with Retry-After once over the limit', async () => {
    const e = createAegisEngine({ rateLimit: { max: 3, windowMs: 60_000 } });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await e.inspect(get(BROWSER, '10.1.1.1')));
    expect(results.map((r) => r.action)).toEqual(['next', 'next', 'next', 'block', 'block']);
    expect(results[3]!.response?.status).toBe(429);
    expect(Number(results[3]!.response?.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts each client separately', async () => {
    const e = createAegisEngine({ rateLimit: { max: 1 } });
    expect((await e.inspect(get(BROWSER, '10.1.1.1'))).action).toBe('next');
    expect((await e.inspect(get(BROWSER, '10.1.1.2'))).action).toBe('next');
    expect((await e.inspect(get(BROWSER, '10.1.1.1'))).action).toBe('block');
  });

  it('resets after the window', async () => {
    vi.useFakeTimers();
    try {
      const e = createAegisEngine({ rateLimit: { max: 1, windowMs: 1000 } });
      await e.inspect(get(BROWSER, '10.1.1.1'));
      expect((await e.inspect(get(BROWSER, '10.1.1.1'))).action).toBe('block');
      vi.advanceTimersByTime(1001);
      expect((await e.inspect(get(BROWSER, '10.1.1.1'))).action).toBe('next');
    } finally {
      vi.useRealTimers();
    }
  });

  it("action 'tarpit' serves decoys instead of 429", async () => {
    const e = createAegisEngine({
      tarpit: { delayMs: 0 },
      rateLimit: { max: 1, action: 'tarpit' },
    });
    await e.inspect(get(BROWSER, '10.1.1.1'));
    expect((await e.inspect(get(BROWSER, '10.1.1.1'))).action).toBe('tarpit');
  });

  it('a key function can exempt requests', async () => {
    const e = createAegisEngine({
      rateLimit: {
        max: 1,
        key: (req) => (req.path.startsWith('/health') ? null : (req.ip ?? null)),
      },
    });
    for (let i = 0; i < 5; i++)
      expect((await e.inspect(get(BROWSER, '10.1.1.1', {}, '/health'))).action).toBe('next');
  });

  it('robots.txt is always served', async () => {
    const e = createAegisEngine({ robotsTxt: true, rateLimit: { max: 0 } });
    expect((await e.inspect(get(BROWSER, '10.1.1.1', {}, '/robots.txt'))).response?.status).toBe(
      200,
    );
  });
});
