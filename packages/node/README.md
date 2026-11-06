# @prompt-aegis/node

> 伺服器端 LLM 防護中介層：檢查並淨化送往 LLM 的請求內容、依政策處理 AI 爬蟲、陷阱路徑標記、Tarpit 誘捕回應、robots.txt。支援 Express、Koa、Fastify、Hono，以及任何使用 Fetch API `Request` 的環境（Next.js、Bun、Deno、Cloudflare Workers）。

## 目錄

- [安裝](#安裝)
- [引入方式](#引入方式)
- [運作流程](#運作流程)
- [框架整合](#框架整合)
  - [Express](#express)
  - [Koa](#koa)
  - [Fastify](#fastify)
  - [Hono](#hono)
  - [Next.js（App Router）](#nextjsapp-router)
  - [Fetch API（Bun／Deno／Workers）](#fetch-apibundenoworkers)
- [設定選項](#設定選項)
- [決策結果](#決策結果)
- [取得真實 IP](#取得真實-ip)
- [陷阱路徑的安全設計](#陷阱路徑的安全設計)
- [事件與監控](#事件與監控)
- [多實例部署](#多實例部署)
- [直接使用引擎](#直接使用引擎)
- [型別](#型別)

## 安裝

```bash
npm install @prompt-aegis/node
# 或
pnpm add @prompt-aegis/node
# 或
yarn add @prompt-aegis/node
```

需要 Node.js ≥ 18。本套件不依賴任何框架，各框架只需自行安裝。

## 引入方式

```ts
// ES Modules
import { aegisExpress, aegisKoa, aegisFastify, aegisHono, aegisFetch } from '@prompt-aegis/node';

// CommonJS
const { aegisExpress } = require('@prompt-aegis/node');
```

為了方便使用，本套件也重新匯出 core 的常用函式：`sanitizePrompt`、`sanitizeModelOutput`、`spotlight`、`detectInjection`、`classifyUserAgent`、`buildRobotsTxt`、`createCanary`、`findCanaries`。

## 運作流程

每個請求依序判斷，命中即回應：

| 順序 | 條件                                   | 動作                                                                                                                                                        |
| :--- | :------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `GET /robots.txt` 且已啟用 `robotsTxt` | 回傳 AI 爬蟲拒絕規則（並自動 `Disallow` 陷阱路徑）                                                                                                          |
| 2    | 路徑位於 `trapPath` 之下               | 回傳 Tarpit 迷宮頁；若請求是頂層導覽或來自非瀏覽器用戶端，將該用戶端（IP + User-Agent）標記 `flagTtlMs` 時間（見[陷阱路徑的安全設計](#陷阱路徑的安全設計)） |
| 3    | 用戶端已被標記                         | 回傳 Tarpit 頁                                                                                                                                              |
| 4    | User-Agent 屬於爬蟲                    | 依 `bots.policy`：`allow`／`block`（403）／`tarpit`                                                                                                         |
| 5    | `POST`／`PUT`／`PATCH` 且有 body       | 淨化所有（或指定）字串欄位；達阻擋門檻時回傳 400                                                                                                            |
| 6    | 其他                                   | 放行（若 body 有被淨化，會替換成淨化後的版本）                                                                                                              |

**預設爬蟲政策**

| 類別                                                   | 預設動作 |
| :----------------------------------------------------- | :------- |
| `ai-training`（GPTBot、ClaudeBot、CCBot…）             | `tarpit` |
| `ai-search`（OAI-SearchBot、PerplexityBot…）           | `allow`  |
| `ai-assistant`（ChatGPT-User、Claude-User…）           | `allow`  |
| `automation`（curl、python-requests、HeadlessChrome…） | `allow`  |

## 框架整合

### Express

```ts
import express from 'express';
import { aegisExpress } from '@prompt-aegis/node';

const app = express();

app.use(express.json()); // 1. 必須先掛 body parser
app.use(
  // 2. 再掛 aegis
  aegisExpress({
    robotsTxt: true,
    sanitize: {
      paths: ['/api/chat'],
      fields: ['messages.*.content'],
    },
    onEvent: (e) => console.log('[aegis]', e.type, e.detail),
  }),
);

app.post('/api/chat', (req, res) => {
  // req.body 已是淨化後的內容；決策結果在 req.aegis
  res.json({ ok: true, risk: req.aegis?.sanitized?.score });
});

app.listen(3000);
```

- 淨化後的 body 會寫回 `req.body`。
- 決策結果放在 `req.aegis`。
- 部署在反向代理之後時，請參考[取得真實 IP](#取得真實-ip)。如果已經設定了 Express 的 `app.set('trust proxy', …)`，可以不設定 `trustProxy`，本套件會直接使用 `req.ip`。

### Koa

```ts
import Koa from 'koa';
import { bodyParser } from '@koa/bodyparser';
import { aegisKoa } from '@prompt-aegis/node';

const app = new Koa();
app.use(bodyParser());
app.use(aegisKoa({ robotsTxt: true }));

app.use(async (ctx) => {
  ctx.body = { decision: ctx.state.aegis };
});
```

- 淨化後的 body 會寫回 `ctx.request.body`。
- 決策結果放在 `ctx.state.aegis`。

### Fastify

```ts
import Fastify from 'fastify';
import { aegisFastify } from '@prompt-aegis/node';

const app = Fastify();
await app.register(aegisFastify({ robotsTxt: true }));

app.post('/api/chat', async (req) => {
  return { risk: (req as any).aegis?.sanitized?.score };
});

await app.listen({ port: 3000 });
```

- 以 `preHandler` hook 執行（此時 body 已解析），並設定 `skip-override`，所以會套用到整個 app。
- 淨化後的 body 會寫回 `request.body`，決策結果放在 `request.aegis`。

### Hono

```ts
import { Hono } from 'hono';
import { aegisHono } from '@prompt-aegis/node';

const app = new Hono();
app.use('*', aegisHono({ robotsTxt: true, sanitize: { fields: ['prompt'] } }));

app.post('/api/chat', (c) => {
  const body = c.get('aegisBody'); // 淨化後的 body
  const decision = c.get('aegis'); // 決策結果
  return c.json({ body, risk: decision.sanitized?.score });
});

export default app;
```

> Hono 的原始 body 只能讀取一次，請使用 `c.get('aegisBody')` 取得淨化後的內容。
>
> 取得用戶端 IP：在 Cloudflare Workers 上設定 `ipHeader: 'cf-connecting-ip'`；在 Node 上可傳入 `getIp`：
>
> ```ts
> import { getConnInfo } from '@hono/node-server/conninfo';
> app.use('*', aegisHono({ getIp: (c) => getConnInfo(c).remote.address }));
> ```

### Next.js（App Router）

```ts
// app/api/chat/route.ts
import { aegisFetch } from '@prompt-aegis/node';

const inspect = aegisFetch({
  sanitize: { fields: ['messages.*.content'] },
  tarpit: { delayMs: 0 },
});

export async function POST(req: Request) {
  const { response, body } = await inspect(req);
  if (response) return response; // 被阻擋或被導入 Tarpit

  const reply = await callLLM(body);
  return Response.json(reply);
}
```

### Fetch API（Bun／Deno／Workers）

```ts
import { aegisFetch } from '@prompt-aegis/node';

// Cloudflare Workers：IP 由 Cloudflare 設定的標頭提供
const inspect = aegisFetch({ robotsTxt: true, ipHeader: 'cf-connecting-ip' });

export default {
  async fetch(request: Request): Promise<Response> {
    const { response, body } = await inspect(request);
    if (response) return response;
    return handle(request, body);
  },
};
```

`aegisFetch(options)` 回傳 `inspect(request, ctx?)`：

| 參數／回傳      | 說明                                                                    |
| :-------------- | :---------------------------------------------------------------------- |
| `request`       | WHATWG `Request`。body 從 clone 讀取，原始請求仍可再讀                  |
| `ctx.ip`        | 用戶端 IP（選用）                                                       |
| 回傳 `decision` | [決策結果](#決策結果)                                                   |
| 回傳 `response` | 存在時直接回傳它並結束處理                                              |
| 回傳 `body`     | 解析後（並已淨化）的 body，支援 JSON、`x-www-form-urlencoded`、`text/*` |

## 設定選項

所有 adapter 都接受相同的選項（`AdapterOptions`）。

| 選項                      | 型別                                                           | 預設值                                   | 說明                                                                                                                                              |
| :------------------------ | :------------------------------------------------------------- | :--------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trustProxy`              | `boolean \| number`                                            | `false`                                  | 從 `X-Forwarded-For` 取得 IP。`true` 表示前面有 1 層代理，數字表示代理層數；**從右邊數**，左邊的值可被用戶端偽造（見[取得真實 IP](#取得真實-ip)） |
| `ipHeader`                | `string`                                                       | —                                        | 從單一 CDN 標頭取得 IP，例如 `cf-connecting-ip`、`fly-client-ip`；優先於 `trustProxy`                                                             |
| `engine`                  | `AegisEngine`                                                  | —                                        | 共用現有引擎（多個 adapter 共用同一個標記儲存）                                                                                                   |
| `trapPath`                | `string \| false`                                              | `'/__aegis/trap'`                        | 陷阱路徑前綴；`false` 為停用                                                                                                                      |
| `flagTtlMs`               | `number`                                                       | `3600000`（1 小時）                      | 踩到陷阱的用戶端被標記多久                                                                                                                        |
| `flagKey`                 | `(req: AegisRequest) => string \| null`                        | `defaultFlagKey`（IP + User-Agent 雜湊） | 標記用戶端的鍵；回傳 `null` 表示不標記。例如改成只用 IP：`(r) => r.ip ? \`ip:${r.ip}\` : null`                                                    |
| `store`                   | `FlagStore`                                                    | `new MemoryFlagStore()`                  | 標記儲存，多實例部署請改用共享儲存                                                                                                                |
| `robotsTxt`               | `boolean \| RobotsTxtOptions`                                  | `false`                                  | 由中介層提供 `GET /robots.txt`                                                                                                                    |
| `onEvent`                 | `(e: AegisEvent) => void`                                      | —                                        | 事件回呼                                                                                                                                          |
| `bots.policy`             | `Partial<Record<BotCategory, 'allow' \| 'block' \| 'tarpit'>>` | 見[預設爬蟲政策](#運作流程)              | 各類爬蟲的處理方式                                                                                                                                |
| `bots.missingUserAgent`   | `'allow' \| 'block' \| 'tarpit'`                               | `'allow'`                                | 沒有 User-Agent 時的處理                                                                                                                          |
| `bots.includeAutomation`  | `boolean`                                                      | `true`                                   | 是否辨識自動化工具                                                                                                                                |
| `bots.extraSignatures`    | `BotSignature[]`                                               | `[]`                                     | 自訂爬蟲特徵                                                                                                                                      |
| `tarpit.delayMs`          | `number`                                                       | `1500`                                   | Tarpit 回應前的延遲（消耗爬蟲時間）                                                                                                               |
| `tarpit.links`            | `number`                                                       | `6`                                      | 每頁迷宮連結數                                                                                                                                    |
| `tarpit.paragraphs`       | `number`                                                       | `4`                                      | 每頁誘餌段落數                                                                                                                                    |
| `tarpit.status`           | `number`                                                       | `200`                                    | Tarpit 回應的狀態碼                                                                                                                               |
| `tarpit.maxConcurrent`    | `number`                                                       | `64`                                     | 同時延遲中的 Tarpit 回應上限；超過時立即回應，避免慢速回應耗盡自己的連線                                                                          |
| `sanitize`                | `false \| object`                                              | `{}`                                     | 請求內容檢查；`false` 為停用                                                                                                                      |
| `sanitize.mode`           | `'detect' \| 'redact' \| 'block'`                              | `'block'`                                | 淨化模式（伺服器端預設會阻擋）                                                                                                                    |
| `sanitize.blockThreshold` | `number`                                                       | `0.85`                                   | 阻擋門檻                                                                                                                                          |
| `sanitize.paths`          | `(string \| RegExp)[]`                                         | 全部                                     | 只檢查這些路徑；字串會比對路徑本身與其子路徑                                                                                                      |
| `sanitize.fields`         | `string[]`                                                     | 全部字串                                 | 以點路徑指定欄位，支援 `*`，例如 `['prompt', 'messages.*.content']`                                                                               |
| `sanitize.blockStatus`    | `number`                                                       | `400`                                    | 阻擋時的狀態碼                                                                                                                                    |
| `sanitize.maxDepth`       | `number`                                                       | `64`                                     | body 最大巢狀深度；超過時以 `{"error":"body_too_deep"}` 拒絕                                                                                      |
| `sanitize.*`              | —                                                              | —                                        | 其他所有 core [`SanitizeOptions`](../core/README.md#sanitizeprompt)                                                                               |

**完整範例**

```ts
aegisExpress({
  trustProxy: true,
  trapPath: '/__aegis/trap',
  flagTtlMs: 6 * 60 * 60 * 1000,
  robotsTxt: { disallow: ['ai-training'], append: 'Sitemap: https://example.com/sitemap.xml' },
  bots: {
    policy: { 'ai-training': 'tarpit', 'ai-search': 'allow', automation: 'block' },
    missingUserAgent: 'block',
  },
  tarpit: { delayMs: 3000, links: 8 },
  sanitize: {
    paths: ['/api/chat', /^\/api\/agents\/.+/],
    fields: ['prompt', 'messages.*.content'],
    mode: 'block',
    blockThreshold: 0.85,
    extraRules: [],
  },
  onEvent: (e) => logger.warn(e),
});
```

**阻擋時的回應**

| 情況           | 狀態碼          | 內容                                                                        |
| :------------- | :-------------- | :-------------------------------------------------------------------------- |
| 提示詞注入     | `400`（可調整） | `{"error":"prompt_injection_detected","fields":["messages.0.content"]}`     |
| body 巢狀過深  | `400`           | `{"error":"body_too_deep"}`                                                 |
| 爬蟲被 `block` | `403`           | `Automated access is not permitted.`                                        |
| Tarpit         | `200`（可調整） | 含 `noindex` 的誘餌 HTML，標頭 `X-Robots-Tag: noindex, nofollow, noarchive` |

## 決策結果

```ts
interface AegisDecision {
  action: 'next' | 'block' | 'tarpit' | 'respond';
  reasons: string[]; // 例如 ['trap-path']、['bot:GPTBot']、['prompt-injection']
  bot: BotClassification;
  sanitized?: {
    body: unknown; // 淨化後的 body
    changed: boolean;
    score: number; // 所有欄位中的最高分數
    findings: FieldFinding[]; // { path, level, score, rules, actions }
  };
  response?: { status: number; headers: Record<string, string>; body: string };
  delayMs?: number;
}
```

## 取得真實 IP

陷阱標記以用戶端 IP 為基礎，IP 取得錯誤會讓攻擊者能「嫁禍」他人或逃過標記。

| 部署方式                                   | 設定                                              |
| :----------------------------------------- | :------------------------------------------------ |
| 直接對外（沒有代理）                       | 不需設定，使用 socket 位址                        |
| 前面有 1 層反向代理（Nginx、負載平衡器）   | `trustProxy: true`                                |
| 前面有 N 層代理（例如 CDN → 負載平衡器）   | `trustProxy: N`                                   |
| Cloudflare／Fly.io 等會設定專用標頭的平台  | `ipHeader: 'cf-connecting-ip'`／`'fly-client-ip'` |
| Express 已設定 `app.set('trust proxy', …)` | 不需設定，直接使用 `req.ip`                       |

`X-Forwarded-For` 的格式是 `用戶端自填, …, 代理看到的位址`。最左邊的值可由用戶端任意偽造，所以本套件**從右邊數** `trustProxy` 層取值。Koa 的 `ctx.ip` 在 `app.proxy = true` 時會取最左邊的值，因此 Koa adapter 改用原始 socket 位址，再套用 `trustProxy`。

也可以直接使用 `resolveClientIp(headers, socketAddress, { trustProxy, ipHeader })`。

## 陷阱路徑的安全設計

如果造訪陷阱路徑就一律封鎖，任何網站只要放一行 `<img src="https://你的網站/__aegis/trap/x">`，就能讓造訪者被封鎖 1 小時。因此只有下列情況會標記用戶端（`isTrapHitFlaggable()`）：

| 請求                                                                                                         | 標記？ |
| :----------------------------------------------------------------------------------------------------------- | :----- |
| 沒有 `Sec-Fetch-*` 標頭（爬蟲、HTTP 函式庫）                                                                 | ✅     |
| `Sec-Fetch-Site: same-origin` 或 `none`，且 `Sec-Fetch-Dest: document`（頂層導覽，例如 AI 代理點擊隱藏連結） | ✅     |
| `Sec-Fetch-Site: cross-site`／`same-site`（其他網站觸發）                                                    | ❌     |
| `Sec-Fetch-Dest: image`／`script`／`iframe` 等子資源（例如使用者留言中的圖片）                               | ❌     |

未標記的請求仍會收到 Tarpit 頁，只是不會影響後續請求。標記的鍵預設是 IP + User-Agent，同一個 NAT 後面的其他使用者不受影響；可用 `flagKey` 自訂。

## 事件與監控

`onEvent` 會收到 `{ type, request: { method, path, ip? }, detail }`：

| type        | 觸發時機            | detail                                                                               |
| :---------- | :------------------ | :----------------------------------------------------------------------------------- |
| `bot`       | 辨識到爬蟲或缺少 UA | `{ name, category, action }`                                                         |
| `trap`      | 踩到陷阱路徑        | `{ userAgent, bot, flagged }`                                                        |
| `tarpit`    | 送出 Tarpit 頁      | `{ reason, canary, crawler, day }`：每個爬蟲、每天的 Canary 都不同，外洩時可追溯來源 |
| `injection` | body 中偵測到風險   | `{ findings }`                                                                       |
| `blocked`   | 請求被阻擋          | `{ reason, ... }`                                                                    |

```ts
aegisExpress({
  onEvent: ({ type, request, detail }) => {
    metrics.increment(`aegis.${type}`);
    if (type === 'tarpit') canaryLog.save(request.path, detail.canary);
  },
});
```

## 多實例部署

預設的 `MemoryFlagStore` 只存在單一程序中。多台機器或 serverless 環境請實作 `FlagStore`：

```ts
import type { FlagStore } from '@prompt-aegis/node';
import { createClient } from 'redis';

const redis = createClient();
await redis.connect();

const redisStore: FlagStore = {
  async has(key) {
    return (await redis.exists(`aegis:${key}`)) === 1;
  },
  async set(key, ttlMs) {
    await redis.set(`aegis:${key}`, '1', { PX: ttlMs });
  },
  async delete(key) {
    await redis.del(`aegis:${key}`);
  },
};

app.use(aegisExpress({ store: redisStore }));
```

`MemoryFlagStore(maxEntries = 50000)` 支援 TTL 過期，超過上限時淘汰最舊的項目。

## 直接使用引擎

需要自訂整合（例如 WebSocket、gRPC、佇列處理）時：

```ts
import { createAegisEngine } from '@prompt-aegis/node';

const engine = createAegisEngine({ sanitize: { fields: ['text'] } });

const decision = await engine.inspect({
  method: 'POST',
  path: '/ws/message',
  headers: { 'user-agent': ua },
  ip: socket.remoteAddress,
  body: { text: incomingMessage },
});

if (decision.action === 'block') socket.close(1008, 'policy violation');
else forward(decision.sanitized?.body ?? { text: incomingMessage });
```

若要自行送出 Tarpit 回應，請先呼叫 `await engine.hold(decision)`。它會依 `tarpit.delayMs` 延遲，並遵守 `tarpit.maxConcurrent` 上限。目前延遲中的數量可從 `engine.activeTarpits` 取得。

其他可單獨使用的函式：`resolveClientIp()`、`defaultFlagKey()`、`isTrapHitFlaggable()`。

多個 adapter 也可以共用同一個引擎：

```ts
const engine = createAegisEngine({ robotsTxt: true });
app.use(aegisExpress({ engine }));
```

## 型別

```ts
import type {
  AegisNodeOptions,
  AdapterOptions,
  AegisEngine,
  AegisRequest,
  AegisResponse,
  AegisDecision,
  AegisEvent,
  BotAction,
  FieldFinding,
  FlagStore,
  FetchResult,
} from '@prompt-aegis/node';
```

## 授權

MIT
