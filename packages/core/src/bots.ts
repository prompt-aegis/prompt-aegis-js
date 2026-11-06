/**
 * User-agent based classification of AI crawlers and generic scrapers.
 *
 * User agents are trivially spoofable — treat this as a cheap first signal and
 * combine it with honeypot hits, rate limits and (for verified bots) reverse
 * DNS / published IP ranges.
 */

export type BotCategory =
  /** Collects data to train models. */
  | 'ai-training'
  /** Indexes content for AI search / answer engines. */
  | 'ai-search'
  /** Fetches on behalf of a live user request inside an assistant. */
  | 'ai-assistant'
  /** HTTP libraries, headless browsers, scraping frameworks. */
  | 'automation';

export interface BotSignature {
  name: string;
  operator: string;
  category: BotCategory;
  /** Case-insensitive substring/regex matched against the UA. */
  pattern: RegExp;
  /** Token to use in robots.txt (if the operator honours one). */
  robotsToken?: string;
}

export const AI_BOT_SIGNATURES: BotSignature[] = [
  // OpenAI
  {
    name: 'GPTBot',
    operator: 'OpenAI',
    category: 'ai-training',
    pattern: /GPTBot/i,
    robotsToken: 'GPTBot',
  },
  {
    name: 'OAI-SearchBot',
    operator: 'OpenAI',
    category: 'ai-search',
    pattern: /OAI-SearchBot/i,
    robotsToken: 'OAI-SearchBot',
  },
  {
    name: 'ChatGPT-User',
    operator: 'OpenAI',
    category: 'ai-assistant',
    pattern: /ChatGPT-User/i,
    robotsToken: 'ChatGPT-User',
  },
  // Anthropic
  {
    name: 'ClaudeBot',
    operator: 'Anthropic',
    category: 'ai-training',
    pattern: /ClaudeBot/i,
    robotsToken: 'ClaudeBot',
  },
  {
    name: 'Claude-SearchBot',
    operator: 'Anthropic',
    category: 'ai-search',
    pattern: /Claude-SearchBot/i,
    robotsToken: 'Claude-SearchBot',
  },
  {
    name: 'Claude-User',
    operator: 'Anthropic',
    category: 'ai-assistant',
    pattern: /Claude-User|Claude-Web/i,
    robotsToken: 'Claude-User',
  },
  {
    name: 'anthropic-ai',
    operator: 'Anthropic',
    category: 'ai-training',
    pattern: /anthropic-ai/i,
    robotsToken: 'anthropic-ai',
  },
  // Google (Google-Extended is a robots token only; GoogleOther / Vertex are real UAs)
  {
    name: 'GoogleOther',
    operator: 'Google',
    category: 'ai-training',
    pattern: /GoogleOther/i,
    robotsToken: 'GoogleOther',
  },
  {
    name: 'Google-CloudVertexBot',
    operator: 'Google',
    category: 'ai-assistant',
    pattern: /Google-CloudVertexBot/i,
    robotsToken: 'Google-CloudVertexBot',
  },
  // Meta
  {
    name: 'meta-externalagent',
    operator: 'Meta',
    category: 'ai-training',
    pattern: /meta-externalagent/i,
    robotsToken: 'meta-externalagent',
  },
  {
    name: 'meta-externalfetcher',
    operator: 'Meta',
    category: 'ai-assistant',
    pattern: /meta-externalfetcher/i,
    robotsToken: 'meta-externalfetcher',
  },
  {
    name: 'FacebookBot',
    operator: 'Meta',
    category: 'ai-training',
    pattern: /FacebookBot/i,
    robotsToken: 'FacebookBot',
  },
  // Perplexity
  {
    name: 'PerplexityBot',
    operator: 'Perplexity',
    category: 'ai-search',
    pattern: /PerplexityBot/i,
    robotsToken: 'PerplexityBot',
  },
  {
    name: 'Perplexity-User',
    operator: 'Perplexity',
    category: 'ai-assistant',
    pattern: /Perplexity-User/i,
    robotsToken: 'Perplexity-User',
  },
  // Others
  {
    name: 'CCBot',
    operator: 'Common Crawl',
    category: 'ai-training',
    pattern: /CCBot/i,
    robotsToken: 'CCBot',
  },
  {
    name: 'Bytespider',
    operator: 'ByteDance',
    category: 'ai-training',
    pattern: /Bytespider/i,
    robotsToken: 'Bytespider',
  },
  {
    name: 'Amazonbot',
    operator: 'Amazon',
    category: 'ai-search',
    pattern: /Amazonbot/i,
    robotsToken: 'Amazonbot',
  },
  {
    name: 'Applebot-Extended',
    operator: 'Apple',
    category: 'ai-training',
    pattern: /Applebot-Extended/i,
    robotsToken: 'Applebot-Extended',
  },
  {
    name: 'cohere-ai',
    operator: 'Cohere',
    category: 'ai-assistant',
    pattern: /cohere-ai/i,
    robotsToken: 'cohere-ai',
  },
  {
    name: 'cohere-training-data-crawler',
    operator: 'Cohere',
    category: 'ai-training',
    pattern: /cohere-training-data-crawler/i,
    robotsToken: 'cohere-training-data-crawler',
  },
  {
    name: 'MistralAI-User',
    operator: 'Mistral',
    category: 'ai-assistant',
    pattern: /MistralAI-User/i,
    robotsToken: 'MistralAI-User',
  },
  {
    name: 'DuckAssistBot',
    operator: 'DuckDuckGo',
    category: 'ai-assistant',
    pattern: /DuckAssistBot/i,
    robotsToken: 'DuckAssistBot',
  },
  {
    name: 'YouBot',
    operator: 'You.com',
    category: 'ai-search',
    pattern: /YouBot/i,
    robotsToken: 'YouBot',
  },
  {
    name: 'AI2Bot',
    operator: 'Allen Institute',
    category: 'ai-training',
    pattern: /AI2Bot|Ai2Bot-Dolma/i,
    robotsToken: 'AI2Bot',
  },
  {
    name: 'Diffbot',
    operator: 'Diffbot',
    category: 'ai-training',
    pattern: /Diffbot/i,
    robotsToken: 'Diffbot',
  },
  {
    name: 'ImagesiftBot',
    operator: 'Hive',
    category: 'ai-training',
    pattern: /ImagesiftBot/i,
    robotsToken: 'ImagesiftBot',
  },
  {
    name: 'Omgilibot',
    operator: 'Webz.io',
    category: 'ai-training',
    pattern: /Omgilibot|omgili/i,
    robotsToken: 'Omgilibot',
  },
  {
    name: 'Timpibot',
    operator: 'Timpi',
    category: 'ai-training',
    pattern: /Timpibot/i,
    robotsToken: 'Timpibot',
  },
  {
    name: 'PanguBot',
    operator: 'Huawei',
    category: 'ai-training',
    pattern: /PanguBot/i,
    robotsToken: 'PanguBot',
  },
  {
    name: 'Kangaroo Bot',
    operator: 'Kangaroo LLM',
    category: 'ai-training',
    pattern: /Kangaroo Bot/i,
    robotsToken: 'Kangaroo Bot',
  },
  {
    name: 'img2dataset',
    operator: 'img2dataset',
    category: 'ai-training',
    pattern: /img2dataset/i,
    robotsToken: 'img2dataset',
  },
  {
    name: 'iaskspider',
    operator: 'iAsk',
    category: 'ai-search',
    pattern: /iaskspider/i,
    robotsToken: 'iaskspider',
  },
];

export const AUTOMATION_SIGNATURES: BotSignature[] = [
  {
    name: 'HeadlessChrome',
    operator: 'headless browser',
    category: 'automation',
    pattern: /HeadlessChrome/i,
  },
  {
    name: 'PhantomJS',
    operator: 'headless browser',
    category: 'automation',
    pattern: /PhantomJS/i,
  },
  { name: 'Scrapy', operator: 'scraping framework', category: 'automation', pattern: /Scrapy/i },
  {
    name: 'python-requests',
    operator: 'http library',
    category: 'automation',
    pattern: /python-requests|python-urllib|aiohttp|httpx|python-httpx/i,
  },
  {
    name: 'Go-http-client',
    operator: 'http library',
    category: 'automation',
    pattern: /Go-http-client/i,
  },
  { name: 'curl', operator: 'http library', category: 'automation', pattern: /^curl\/|\bWget\//i },
  {
    name: 'node-fetch',
    operator: 'http library',
    category: 'automation',
    pattern: /node-fetch|axios\/|undici|^node$/i,
  },
  {
    name: 'java',
    operator: 'http library',
    category: 'automation',
    pattern: /^Java\/|okhttp|Apache-HttpClient/i,
  },
  {
    name: 'libwww-perl',
    operator: 'http library',
    category: 'automation',
    pattern: /libwww-perl|^Ruby$|Faraday/i,
  },
];

export interface BotClassification {
  isBot: boolean;
  category: BotCategory | null;
  name: string | null;
  operator: string | null;
  /** True when the UA header is missing or empty (itself suspicious for browsers). */
  missingUserAgent: boolean;
}

export interface ClassifyOptions {
  /** Include automation libraries / headless browsers. Default `true`. */
  includeAutomation?: boolean;
  extraSignatures?: BotSignature[];
}

export function classifyUserAgent(
  userAgent: string | null | undefined,
  options: ClassifyOptions = {},
): BotClassification {
  const ua = (userAgent ?? '').trim();
  if (!ua)
    return { isBot: false, category: null, name: null, operator: null, missingUserAgent: true };
  const sigs = [
    ...(options.extraSignatures ?? []),
    ...AI_BOT_SIGNATURES,
    ...((options.includeAutomation ?? true) ? AUTOMATION_SIGNATURES : []),
  ];
  for (const s of sigs) {
    if (s.pattern.test(ua)) {
      return {
        isBot: true,
        category: s.category,
        name: s.name,
        operator: s.operator,
        missingUserAgent: false,
      };
    }
  }
  return { isBot: false, category: null, name: null, operator: null, missingUserAgent: false };
}

export interface RobotsTxtOptions {
  /** Categories of AI bots to disallow. Default: `['ai-training']`. */
  disallow?: BotCategory[];
  /** Paths to disallow for those bots. Default `['/']`. */
  paths?: string[];
  /** Also emit `Google-Extended` (opt-out of Gemini training). Default `true` when `ai-training` is disallowed. */
  googleExtended?: boolean;
  /** Extra raw lines appended verbatim (e.g. your existing rules, Sitemap). */
  append?: string;
}

/** Build a robots.txt block that opts out of AI crawling for compliant bots. */
export function buildRobotsTxt(options: RobotsTxtOptions = {}): string {
  const categories = new Set(options.disallow ?? ['ai-training']);
  const paths = options.paths ?? ['/'];
  const tokens = new Set<string>();
  for (const s of AI_BOT_SIGNATURES)
    if (categories.has(s.category) && s.robotsToken) tokens.add(s.robotsToken);
  if ((options.googleExtended ?? categories.has('ai-training')) && categories.has('ai-training')) {
    tokens.add('Google-Extended');
  }
  const lines = ['# Generated by @prompt-aegis/core'];
  for (const t of tokens) {
    lines.push(`User-agent: ${t}`);
    for (const p of paths) lines.push(`Disallow: ${p}`);
    lines.push('');
  }
  if (options.append) lines.push(options.append.trim(), '');
  return lines.join('\n');
}
