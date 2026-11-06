# prompt-aegis-js

Framework-agnostic TypeScript toolkit for defending web apps against **LLM prompt injection** and **malicious AI scrapers**.

| Package                               | What it does                                                                                                                                                                                                                     |
| :------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@prompt-aegis/core`](packages/core) | Zero-dependency engine: invisible-Unicode stripping, injection detection (EN + 中文), sanitization, spotlighting, LLM-output exfiltration filter, AI-crawler classification, tarpit / canary generation. Runs in any JS runtime. |
| [`@prompt-aegis/dom`](packages/dom)   | Browser defenses: live input guards, form guards, invisible honeypots & maze links, honeypot form fields, hidden-injection DOM scanner, automation detection, React & Vue bindings.                                              |
| [`@prompt-aegis/node`](packages/node) | Server middleware for Express, Koa, Fastify, and Fetch-API runtimes (Hono, Next.js, Bun, Deno, Workers): body screening, bot policy, trap paths, tarpit responses, robots.txt.                                                   |

## Threat model

```
           ┌──────────── Ingress ────────────┐            ┌──────────── Egress ─────────────┐
 user ──▶  │ strip invisible / tag chars     │ ──▶ LLM ──▶│ strip exfil images / bad links  │ ──▶ render
 docs ──▶  │ detect + redact / block         │            └─────────────────────────────────┘
 web  ──▶  │ spotlight untrusted content     │
           └─────────────────────────────────┘
 AI crawler ──▶ robots.txt opt-out ──▶ (ignored?) trap path ──▶ flagged ──▶ tarpit + canary maze
```

Heuristic detection is a **first line of defence, not a guarantee**. Combine it with spotlighting, output filtering, and least-privilege tool design.

## Quick start

```bash
pnpm add @prompt-aegis/core            # any runtime
pnpm add @prompt-aegis/dom             # browser (+ react / vue optional peers)
pnpm add @prompt-aegis/node            # server
```

### Core

```ts
import { sanitizePrompt, spotlight, sanitizeModelOutput } from '@prompt-aegis/core';

// 1. Ingress: clean user input
const r = sanitizePrompt(userInput, { mode: 'block' });
if (r.blocked)
  throw new Error(`Rejected (${r.level}): ${r.detection.matches.map((m) => m.ruleId)}`);

// 2. Spotlight untrusted content (RAG docs, web pages, emails)
const doc = spotlight(retrievedPage, { source: 'web page' });
const messages = [
  { role: 'system', content: `You are a helpful assistant.\n${doc.instruction}` },
  { role: 'user', content: `Summarise this:\n${doc.content}` },
];

// 3. Egress: strip exfiltration channels before rendering model output
const safeMarkdown = sanitizeModelOutput(modelReply, { allowedImageHosts: ['*.myapp.com'] }).text;
```

`detectInjection(text)` returns `{ score, level, flagged, matches[] }`. Levels: `none | low | medium | high | critical`. Add your own rules with `extraRules`, turn built-ins off with `disabledRules`.

### Browser

```ts
import {
  guardInput,
  injectHoneypot,
  scanForHiddenInjections,
  extractVisibleText,
} from '@prompt-aegis/dom';

// Live-strip invisible characters & catch risky pastes into the chat box
guardInput(document.querySelector('#chat')!, {
  blockPasteAt: 0.85,
  onDetect: ({ result }) => console.warn('injection attempt', result.level),
});

// Invisible tarpit for scrapers (aria-hidden + inert; screen readers & keyboard users skip it)
const hp = injectHoneypot({ seed: location.pathname, trapPath: '/__aegis/trap' });
console.log('canary for this page:', hp.canary);

// Feeding the current page to an LLM? Only send what a human can see:
const pageText = extractVisibleText(document.body);
// …and audit user-generated content for hidden instructions:
const findings = scanForHiddenInjections(document.querySelector('#comments')!);
```

**React**

```tsx
import { AegisHoneypot, useAegisGuard, useSafeModelOutput } from '@prompt-aegis/dom/react';

function Chat() {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAegisGuard(ref, { onDetect: (e) => toast(e.result.level) });
  return (
    <>
      <textarea ref={ref} />
      <AegisHoneypot seed="/chat" trapPath="/__aegis/trap" />
    </>
  );
}
```

**Vue**

```ts
import { PromptAegis } from '@prompt-aegis/dom/vue';
app.use(PromptAegis);
// <textarea v-aegis-guard="{ onDetect }" />  <AegisHoneypot seed="/chat" trap-path="/__aegis/trap" />
```

### Server

```ts
import express from 'express';
import { aegisExpress } from '@prompt-aegis/node';

const app = express();
app.use(express.json());
app.use(
  aegisExpress({
    robotsTxt: true, // serve AI opt-out robots.txt (+ Disallow trap path)
    bots: { policy: { 'ai-training': 'tarpit', automation: 'allow' } },
    sanitize: { paths: ['/api/chat'], fields: ['messages.*.content'] },
    onEvent: (e) => logger.info(e),
  }),
);
```

Also available: `aegisKoa`, `aegisFastify` (`fastify.register(aegisFastify(opts))`), `aegisHono`, and `aegisFetch` for any WHATWG `Request` handler:

```ts
// Next.js route handler
const inspect = aegisFetch({ sanitize: { fields: ['prompt'] } });
export async function POST(req: Request) {
  const { response, body } = await inspect(req);
  if (response) return response;
  return callModel(body);
}
```

Default bot policy: `ai-training → tarpit`, `ai-search / ai-assistant / automation → allow`. Any client that requests the trap path (which robots.txt disallows) is flagged for `flagTtlMs` (1h) and served an endless, deterministic decoy maze. For multi-instance deployments pass a shared `store` (e.g. Redis) implementing `FlagStore`.

## Notes on responsible use

- Tarpit payloads contain decoy text, a canary, and a plain notice — **no instructions aimed at manipulating an AI assistant's user**. Keep it that way if you customise them.
- Honeypots are `aria-hidden`, `inert`, `tabindex=-1`, and `data-nosnippet`, so assistive tech and search snippets ignore them. Serving different content to search crawlers can count as cloaking; the default policy leaves search bots alone.
- User-agent checks are spoofable. Treat every signal as one input to your own risk decision.

## Development

```bash
pnpm install
pnpm build        # tsup → ESM + CJS + .d.ts for every package
pnpm test         # vitest (jsdom for DOM tests)
pnpm typecheck
pnpm lint
pnpm format
```

## License

MIT
