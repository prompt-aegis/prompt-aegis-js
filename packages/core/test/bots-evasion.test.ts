import { describe, expect, it } from 'vitest';
import { classifyUserAgent, isSearchEngine } from '../src/index';

const wrap = (token: string) => `Mozilla/5.0 (compatible; ${token}/1.0; +https://example.com/bot)`;

describe('classifyUserAgent — disguised AI crawler names', () => {
  const variants: Record<string, string> = {
    'inserted space': 'GPT Bot',
    underscore: 'GPT_Bot',
    'dots and dash': 'G.P.T-Bot',
    'zero-width space': 'GPTB​ot',
    'zero-width joiner': 'Claude‍Bot',
    'Greek omicron': 'GPTBοt',
    'Cyrillic а': 'ClаudeBot',
    'full-width': 'ＧＰＴＢｏｔ',
    'mixed case + suffix': 'gptBOT-crawler',
    'soft hyphen': 'CC­Bot',
  };
  for (const [name, token] of Object.entries(variants)) {
    it(name, () => {
      const r = classifyUserAgent(wrap(token));
      expect(r.isBot, token).toBe(true);
      expect(r.category).toBe('ai-training');
    });
  }
});

describe('classifyUserAgent — newly listed crawlers', () => {
  const bots: [string, string][] = [
    ['DeepSeekBot', 'ai-training'],
    ['Brightbot', 'ai-training'],
    ['TikTokSpider', 'ai-training'],
    ['Cotoyogi', 'ai-training'],
    ['ICC-Crawler', 'ai-training'],
    ['PhindBot', 'ai-search'],
    ['LinerBot', 'ai-search'],
    ['Gemini-Deep-Research', 'ai-assistant'],
    ['NovaAct', 'ai-assistant'],
    ['FirecrawlAgent', 'automation'],
  ];
  for (const [name, category] of bots) {
    it(name, () => {
      const r = classifyUserAgent(wrap(name));
      expect(r.name).toBe(name);
      expect(r.category).toBe(category);
    });
  }

  it('multi-word names tolerate missing spaces', () => {
    expect(classifyUserAgent('Sidetrade indexer bot').name).toBe('Sidetrade indexer bot');
    expect(classifyUserAgent('SidetradeIndexerBot/1.0').name).toBe('Sidetrade indexer bot');
  });
});

describe('classifyUserAgent — no false positives on real clients', () => {
  const real = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]',
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 Line/14.10.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
  ];
  for (const ua of real) {
    it(ua.slice(0, 70), () => expect(classifyUserAgent(ua).isBot).toBe(false));
  }

  it('search engines are not AI crawlers', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    ]) {
      expect(classifyUserAgent(ua).isBot).toBe(false);
      expect(isSearchEngine(ua)).toBe(true);
    }
  });
});
