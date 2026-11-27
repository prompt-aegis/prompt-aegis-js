# @prompt-aegis/node

[![npm](https://img.shields.io/npm/v/@prompt-aegis/node)](https://www.npmjs.com/package/@prompt-aegis/node) ![license](https://img.shields.io/badge/license-MIT-blue)

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
# 或
bun add @prompt-aegis/node
```

npm 頁面：<https://www.npmjs.com/package/@prompt-aegis/node>

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

| 順序 | 條件                                   | 動作                                                                                                                                                |
| :--- | :------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `GET /robots.txt` 且已啟用 `robotsTxt` | 回傳 AI 爬蟲拒絕規則（並自動 `Disallow` 陷阱路徑）                                                                                                  |
| 2    | 路徑為 `trapPath` 入口或有效簽章子連結 | 回傳 Tarpit 迷宮頁；若請求是頂層導覽或來自非瀏覽器用戶端，將該用戶端（預設 IP）標記 `flagTtlMs` 時間（見[陷阱路徑的安全設計](#陷阱路徑的安全設計)） |
| 3    | 用戶端已被標記                         | 回傳 Tarpit 頁                                                                                                                                      |
| 4    | User-Agent 屬於爬蟲                    | 依 `bots.policy`：`allow`／`block`（403）／`tarpit`                                                                                                 |
| 5    | `POST`／`PUT`／`PATCH` 且有 body       | 淨化所有（或指定）字串欄位；達阻擋門檻時回傳 400                                                                                                    |
| 6    | 其他                                   | 放行（若 body 有被淨化，會替換成淨化後的版本）                                                                                                      |

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

| 選項                      | 型別                                                                            | 預設值                      | 說明                                                                                                                                                                                                            |
| :------------------------ | :------------------------------------------------------------------------------ | :-------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trustProxy`              | `boolean \| number`                                                             | `false`                     | 從 `X-Forwarded-For` 取得 IP。`true` 表示前面有 1 層代理，數字表示代理層數；**從右邊數**，左邊的值可被用戶端偽造（見[取得真實 IP](#取得真實-ip)）                                                               |
| `ipHeader`                | `string`                                                                        | —                           | 從單一 CDN 標頭取得 IP，例如 `cf-connecting-ip`、`fly-client-ip`；優先於 `trustProxy`                                                                                                                           |
| `engine`                  | `AegisEngine`                                                                   | —                           | 共用現有引擎（多個 adapter 共用同一個標記儲存）                                                                                                                                                                 |
| `trapPath`                | `string \| false`                                                               | `'/documents/archive'`      | 陷阱路徑前綴；`false` 為停用                                                                                                                                                                                    |
| `flagTtlMs`               | `number`                                                                        | `3600000`（1 小時）         | 踩到陷阱的用戶端被標記多久                                                                                                                                                                                      |
| `flagKey`                 | `(req: AegisRequest) => string \| null`                                         | `defaultFlagKey`（IP）      | 標記用戶端的鍵；回傳 `null` 表示不標記。例如改成只用 IP：`(r) => r.ip ? \`ip:${r.ip}\` : null`                                                                                                                  |
| `store`                   | `FlagStore`                                                                     | `new MemoryFlagStore()`     | 標記儲存，多實例部署請改用共享儲存                                                                                                                                                                              |
| `robotsTxt`               | `boolean \| RobotsTxtOptions`                                                   | `false`                     | 由中介層提供 `GET /robots.txt`                                                                                                                                                                                  |
| `onEvent`                 | `(e: AegisEvent) => void`                                                       | —                           | 事件回呼                                                                                                                                                                                                        |
| `bots.policy`             | `Partial<Record<BotCategory, 'allow' \| 'block' \| 'tarpit'>>`                  | 見[預設爬蟲政策](#運作流程) | 各類爬蟲的處理方式                                                                                                                                                                                              |
| `bots.missingUserAgent`   | `'allow' \| 'block' \| 'tarpit'`                                                | `'allow'`                   | 沒有 User-Agent 時的處理                                                                                                                                                                                        |
| `bots.includeAutomation`  | `boolean`                                                                       | `true`                      | 是否辨識自動化工具                                                                                                                                                                                              |
| `bots.extraSignatures`    | `BotSignature[]`                                                                | `[]`                        | 自訂爬蟲特徵                                                                                                                                                                                                    |
| `access`                  | `{ paths: (string \| RegExp)[], verify: (req) => boolean \| Promise<boolean> }` | 關閉                        | 私有路由的伺服器驗證掛鉤，拒絕或錯誤回 403                                                                                                                                                                      |
| `tarpit.document`         | `(req) => { title, paragraphs } \| Promise<{ title, paragraphs }>`              | 內建合成內容                | 穩定的站內文件提供者，請勿提供敏感內容                                                                                                                                                                          |
| `tarpit.canaryScope`      | `'document' \| 'crawler-day'`                                                   | `'document'`                | 文件標記穩定性；後者會產生可辨識的 UA／日期差異                                                                                                                                                                 |
| `tarpit.secret`           | `string`                                                                        | 每個 engine 隨機產生金鑰    | 僅伺服器使用的 HMAC 秘密；多實例／重啟需共用以維持內容穩定，空字串會拒絕                                                                                                                                        |
| `tarpit.delayMs`          | `number`                                                                        | `1500`                      | Tarpit 回應前的延遲（消耗爬蟲時間）；實際會加 0.5×–1.5× 抖動，避免固定延遲變成指紋                                                                                                                              |
| `tarpit.links`            | `number`                                                                        | `6`                         | 每頁迷宮連結數                                                                                                                                                                                                  |
| `tarpit.leafRate`         | `number`                                                                        | `0.3`                       | 葉節點（無子連結的死路頁）比例 0–1。讓迷宮不再「一眼無限」，像真的文件樹                                                                                                                                        |
| `tarpit.paragraphs`       | `number`                                                                        | `4`                         | 每頁誘餌段落數                                                                                                                                                                                                  |
| `tarpit.canaryPrefix`     | `string`                                                                        | `'doc'`                     | canary 字首；可改成站內文件編號的字首                                                                                                                                                                           |
| `tarpit.notice`           | `boolean`                                                                       | `false`                     | 是否在誘餌頁加「這是合成誘餌」勸退聲明。對守規矩的爬蟲有用，但會讓推理型 agent 一眼認出；canary 不靠它也在內文                                                                                                  |
| `tarpit.content`          | `Partial<TarpitContent>`                                                        | 內建英文語料                | 覆寫誘餌語料池，讓內容對齊母站語言／領域（非英文站務必設定）                                                                                                                                                    |
| `tarpit.siteName`         | `string`                                                                        | `'Documents'`               | 誘餌頁頁首／頁尾顯示的站名，讓頁面像母站的一部分                                                                                                                                                                |
| `tarpit.render`           | `(payload) => string`                                                           | —                           | 完全自訂誘餌頁 HTML（例如套進母站真實版型）；設定後 `siteName` 失效                                                                                                                                             |
| `tarpit.headers`          | `Record<string, string>`                                                        | —                           | 覆寫／附加誘餌回應標頭。預設標頭刻意「不起眼」（不掛 `X-Robots-Tag`、不用 `no-store`），`noindex` 改由頁內 `<meta>` 負責                                                                                        |
| `tarpit.status`           | `number`                                                                        | `200`                       | Tarpit 回應的狀態碼                                                                                                                                                                                             |
| `tarpit.maxConcurrent`    | `number`                                                                        | `64`                        | 同時延遲中的 Tarpit 回應上限；超過時立即回應，避免慢速回應耗盡自己的連線                                                                                                                                        |
| `sanitize`                | `false \| object`                                                               | `{}`                        | 請求內容檢查；`false` 為停用                                                                                                                                                                                    |
| `sanitize.mode`           | `'detect' \| 'redact' \| 'block'`                                               | `'block'`                   | 淨化模式（伺服器端預設會阻擋）                                                                                                                                                                                  |
| `sanitize.blockThreshold` | `number`                                                                        | `0.85`                      | 阻擋門檻                                                                                                                                                                                                        |
| `sanitize.paths`          | `(string \| RegExp)[]`                                                          | 全部                        | 只檢查這些路徑；字串會比對路徑本身與其子路徑                                                                                                                                                                    |
| `sanitize.fields`         | `string[]`                                                                      | 全部字串                    | 以點路徑指定欄位，支援 `*`，例如 `['prompt', 'messages.*.content']`。**路徑會涵蓋整個子樹**：`body` 也包含 `body.0`、`body.text`；`messages.*.content` 也包含 OpenAI 格式的內容陣列 `messages.0.content.1.text` |
| `sanitize.blockStatus`    | `number`                                                                        | `400`                       | 阻擋時的狀態碼                                                                                                                                                                                                  |
| `sanitize.maxDepth`       | `number`                                                                        | `64`                        | body 最大巢狀深度；超過時以 `{"error":"body_too_deep"}` 拒絕                                                                                                                                                    |
| `sanitize.maxStrings`     | `number`                                                                        | `2000`                      | 每個 body 最多檢查的字串數（只計算 `fields` 涵蓋的字串）；超過時以 `{"error":"body_too_large"}` 拒絕。避免用大量短字串拖慢伺服器                                                                                |
| `sanitize.maxTotalChars`  | `number`                                                                        | `1000000`                   | 被檢查字串的總字元數上限；超過時以 `body_too_large` 拒絕                                                                                                                                                        |
| `sanitize.*`              | —                                                                               | —                           | 其他所有 core [`SanitizeOptions`](../core/README.md#sanitizeprompt)                                                                                                                                             |

**完整範例**

```ts
aegisExpress({
  trustProxy: true,
  trapPath: '/documents/archive',
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

| 情況                | 狀態碼          | 內容                                                                                                  |
| :------------------ | :-------------- | :---------------------------------------------------------------------------------------------------- |
| 提示詞注入          | `400`（可調整） | `{"error":"prompt_injection_detected","fields":["messages.0.content"]}`                               |
| body 巢狀過深       | `400`           | `{"error":"body_too_deep"}`                                                                           |
| body 字串過多或過長 | `400`           | `{"error":"body_too_large"}`                                                                          |
| 爬蟲被 `block`      | `403`           | `Automated access is not permitted.`                                                                  |
| Tarpit              | `200`（可調整） | 像真實文件頁的誘餌 HTML，`noindex` 由頁內 `<meta>` 負責，標頭預設不起眼（可用 `tarpit.headers` 調整） |

## 誘餌頁的隱匿性（重要）

誘餌頁預設不輸出勸退聲明，使用 `doc` canary 字首；HTML 連結不偽裝成 PDF 或試算表。這些措施降低直接暴露身分的訊號，但固定語料、隱藏 DOM 和頁面結構仍可能被辨識。

- **部署秘密**：`tarpit.secret` 使用 HMAC-SHA-256 衍生內容與 canary seed，避免只憑公開路徑／日期重建正文。請從環境變數或秘密管理服務讀入高熵隨機值（建議至少 32 隨機位元組），不要傳到瀏覽器。同一部署的多台實例應共用；省略時每個 engine 自行產生金鑰，重啟後內容會改變。內容與 canary 預設都不隨 UA／日期改變。若顯式設定 `canaryScope: 'crawler-day'`，才會逐爬蟲／UTC 日變更，代價是可透過差異比對找出標記。這不代表文字生成器具有密碼學安全性，也不能單憑 canary 證明爬蟲身分。
- **版型與語料**：請設定 `render`／`siteName`／`content` 對齊母站；非英文站只改標題不會翻譯正文句型。

  ```ts
  aegisExpress({
    tarpit: {
      secret: process.env.AEGIS_TARPIT_SECRET, // 所有實例共用，僅伺服器可見
      canaryPrefix: 'ACME', // 或任何像你站內文件編號的字首
      siteName: 'Acme Intranet', // 讓誘餌頁看起來像母站
      content: {
        // 非英文站：覆寫語料，讓內容對齊母站語言／領域
        titleKinds: ['稽核摘要', '異動紀錄', '權限審查'],
        titleSubjects: ['門禁', '帳務', '供應商'],
      },
    },
  });
  ```

- **內容只是「更貴的絆線」，不是隱形牢籠。** 誘餌內容本質是合成填充、用字會循環、也沒有真機密可找。一個有耐心、專門在找機密的 reasoning agent，爬幾頁後仍可能判斷「這區是自動生成的」。它真正的價值是：連進來的那一刻就給你 `onEvent` 訊號、canary 外洩可歸因、對便宜大量爬蟲放大成本——而不是永久困住針對性攻擊者。要再往上，就得餵更有實質、更像真文件的內容（例如接真實資料的去敏版）。

### UA 偽裝與私有資料

UA 是使用者可修改的字串，不能當作身分驗證。對登入後才可讀取的路由，可設定 `access: { paths, verify }`，其中 `verify(req)` 必須呼叫既有的伺服器 session／權杖驗證；回傳非 `true` 或拋錯時一律回 403，且不執行後續頁面處理。只保護 `paths` 匹配的路由。比對刻意比你的路由器寬鬆，避免用不同寫法繞過：不分大小寫、會百分比解碼（含雙重編碼），並正規化 `//`、`.`、`..`——所以 `/PRIVATE/secret`、`/private/%73ecret`、`/x/../private/secret` 都會觸發 `verify`；RegExp 規則也會對這些寫法逐一測試。`sanitize.paths` 用同一套比對。框架掛載位置仍需與實際路由一致，原本的應用程式授權仍應保留。未啟用驗證的公開頁面仍可被偽裝瀏覽器存取。

### 站內內容與簽發連結

設定 `tarpit.document(req)` 回傳穩定的 `{ title, paragraphs }`，可使用適合母站語言／領域的無敏感資料文件；比單純替換詞庫更能避免固定英文句型。預設生成器已降低每句都出現日期的規律，但仍是合成內容，不能保證無法辨識。`render(payload)` 仍負責版型；自訂文件的字串會由預設 renderer 進行 HTML 跳脫。

伺服器產生的子連結包含 HMAC 簽章，不需保存無限的路徑清單。只有精確入口 `trapPath` 與有效簽章子路徑會回誘餌；任意、遭竄改或其他部署簽發的子路徑不算陷阱，照一般路徑處理（交給網站自己回應，通常是網站本身的 404；已被標記或被政策誘捕的爬蟲則照常拿到誘餌頁），因此無法用 404 的長相比對出陷阱前綴。多實例需共用 `tarpit.secret`。瀏覽器只應連到入口或伺服器已產生的連結，不能在瀏覽器持有秘密。DOM 的 `trapPath` 現在產生單一入口連結；手動傳 `maze` 的連結不會自動具備簽章。

robots.txt 的 Disallow 仍會暴露候選前綴；保留它是為了讓守規矩的爬蟲避開。它不是存取控制，也不應被當作隱匿保證。

### 完整隱匿範本（經推理型 agent 實測）

以 LLM 扮演攻擊 agent 實測時，**最快露餡的不是函式庫，而是部署設定**：中文站回英文誘餌頁、誘餌連結網址含 `aegis`／`trap`、誘餌頁沒有母站外殼。下面的範本把這三點一次處理掉——誘餌頁穿上母站的版型與語言，連結看起來像一般文件庫：

```ts
aegisExpress({
  // 1. 看起來像正常內容的路徑；不要含 aegis、trap、honeypot 等字樣
  trapPath: '/archive',
  tarpit: {
    secret: process.env.AEGIS_TARPIT_SECRET, // 多實例共用，僅伺服器可見
    canaryPrefix: 'doc',
    // 2. 正文用母站語言／領域（document 會取代預設的英文句型）
    document: (req) => ({
      title: '離島潛點整理',
      paragraphs: [
        '沿途的補給點與接駁資訊都標在文末地圖，建議提早一天抵達。',
        '旺季人潮較多，清晨與傍晚的光線最適合拍照。',
      ],
    }),
    // 3. 套進母站真實版型（同一 lang、品牌、nav、CSS），並保留 noindex
    render: (p) =>
      siteLayout({
        lang: 'zh-Hant',
        title: p.title,
        head: '<meta name="robots" content="noindex,nofollow,noarchive">',
        body:
          `<article><h1>${escapeHtml(p.title)}</h1>` +
          `<p class="meta">文件編號 ${escapeHtml(p.canary)}</p>` + // canary 當成文件編號
          p.paragraphs.map((t) => `<p>${escapeHtml(t)}</p>`).join('') +
          `</article>` +
          (p.links.length
            ? `<ul>${p.links.map((l) => `<li><a href="${escapeHtml(l.href)}">相關整理</a></li>`).join('')}</ul>`
            : ''),
      }),
  },
});
```

`siteLayout` 換成你網站原本產生頁面的函式；`escapeHtml` 可從 `@prompt-aegis/core` 匯入。`render` 完全接管 HTML，所以 **`noindex` 與 HTML 跳脫要自己負責**。可執行的完整版見 [`examples/demo-site/server.mjs`](../../examples/demo-site/server.mjs)。

**上線前自我檢查**（用 AI 爬蟲 UA 請求任一頁，例如 `curl -A 'GPTBot/1.2' https://你的網站/某篇文章`）：

| 檢查項目                                                   | 應該是 |
| :--------------------------------------------------------- | :----- |
| `<html lang>` 與真實頁面相同                               | ✅     |
| 頁首、導覽、頁尾、CSS 與真實頁面相同                       | ✅     |
| 頁面與連結中沒有 `aegis`、`trap`、`decoy`、`honeypot`      | ✅     |
| 沒有「這是合成誘餌」之類的聲明（`tarpit.notice` 保持關閉） | ✅     |
| 段落沒有逐句重複                                           | ✅     |
| 仍有 `noindex` 與 canary 文件編號                          | ✅     |

**做到這些之後的剩餘訊號**：請求的網址和拿到的內容對不上（要 A 文章卻拿到 B 主題）、多頁之間語料重複、永遠找不到任何有價值的資料。這些是誘餌頁的本質限制——它讓推理型 agent 需要爬很多頁、仔細比對才起疑，而不是第一頁就識破；但不能保證永遠不被發現。

### 升級注意

預設陷阱路徑由 `/__aegis/trap` 改為 `/documents/archive`，這是保留給誘餌的路徑；若與真實路由衝突，請指定自己的 `trapPath`，並同步更新 DOM 蜜罐連結與 robots.txt。舊部署可明確指定 `trapPath: '/__aegis/trap'` 保留原行為。預設 canary 字首改為 `doc`，請同步更新監控比對，或顯式設定 `canaryPrefix: 'aegis'`。`tarpit.links: 0` 現在會完全停用迷宮連結。

robots.txt 的陷阱規則由 `Disallow: <trapPath>/` 改為 `Disallow: <trapPath>`（不加斜線）：robots 是前綴比對，舊寫法沒有涵蓋 DOM 蜜罐連到的精確入口，會讓遵守 robots 的爬蟲（搜尋引擎、內部索引器）走進陷阱並被標記。陷阱前綴下未簽發的路徑不再由引擎回 404，而是交給你的網站處理（通常就是網站自己的 404），避免引擎版 404 與網站真實 404 不同而被比對出陷阱前綴。未設定 `tarpit.secret` 時，第一次產生誘餌頁會在 console 警告一次（`NODE_ENV=test` 時不顯示）。

標記鍵預設從 IP+UA 改為 IP，請依共用 NAT 情況接入可信 `flagKey`。canary 預設由逐爬蟲／日改為固定文件代碼，監控應使用事件記錄解讀，不再宣稱從 canary 可唯一歸因到爬蟲。舊的任意子路徑入口需改連精確 `trapPath`；未知子路徑不再自動回迷宮。

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

### 企業內部系統：改用帳號身分標記

預設以 IP 標記被誘捕的用戶端。企業內網的流量常集中在少數 proxy、VPN 出口或 NAT 後面——只要其中一台被標記，**同一出口後的所有同事都會一起被送進誘餌頁**（`flagTtlMs` 預設一小時）。內部系統通常本來就要登入，請改用伺服器驗證過的帳號當標記鍵：

```ts
aegisExpress({
  // 只用伺服器端驗證過的 session／SSO 身分；未登入就不標記（回傳 null）
  flagKey: (req) => {
    const userId = verifySession(req.headers.cookie); // 你既有的驗證，不可只信任 cookie 字面值
    return userId ? `user:${userId}` : null;
  },
  // 換成需要登入的路由前綴（登入頁本身不要放進來）
  access: { paths: ['/app'], verify: (req) => verifySession(req.headers.cookie) !== null },
  tarpit: { secret: process.env.AEGIS_TARPIT_SECRET }, // 內部常有多台主機輪流服務，務必共用
});
```

- `flagKey` 回傳 `null` 時不標記，避免未登入的共用出口被連坐。
- 搭配 `access.verify`，未登入的請求在進入誘餌邏輯前就回 403。
- 內部常見遵守 robots 的程式（企業搜尋索引器、連結檢查、監控探針）不會進入陷阱入口；請確認 `robotsTxt` 已啟用。

## 陷阱路徑的安全設計

如果造訪陷阱路徑就一律封鎖，任何網站只要放一行 `<img src="https://你的網站/documents/archive/x">`，就能讓造訪者被封鎖 1 小時。因此只有下列情況會標記用戶端（`isTrapHitFlaggable()`）：

| 請求                                                                                                         | 標記？ |
| :----------------------------------------------------------------------------------------------------------- | :----- |
| 沒有 `Sec-Fetch-*` 標頭（爬蟲、HTTP 函式庫）                                                                 | ✅     |
| `Sec-Fetch-Site: same-origin` 或 `none`，且 `Sec-Fetch-Dest: document`（頂層導覽，例如 AI 代理點擊隱藏連結） | ✅     |
| `Sec-Fetch-Site: cross-site`／`same-site`（其他網站觸發）                                                    | ❌     |
| `Sec-Fetch-Dest: image`／`script`／`iframe` 等子資源（例如使用者留言中的圖片）                               | ❌     |

只有入口與有效簽章子連結會收到 Tarpit 頁；未知子路徑照一般路徑處理（通常是網站自己的 404），且不標記訪客。合法陷阱連結若因跨站／子資源條件而未標記，仍會回誘餌但不影響後續請求。標記鍵預設為 IP，換 UA 無法逃脫；同一 NAT 會共用標記。可用 `flagKey` 接已驗證的 session／帳號 ID，不能直接信任使用者自填 cookie/header。沒有可信身分且需要公開匿名存取時，無法同時保證 NAT 隔離與阻擋任意身分輪替。

## 事件與監控

`onEvent` 會收到 `{ type, request: { method, path, ip? }, detail }`：

| type        | 觸發時機            | detail                                                                                                                  |
| :---------- | :------------------ | :---------------------------------------------------------------------------------------------------------------------- |
| `bot`       | 辨識到爬蟲或缺少 UA | `{ name, category, action }`                                                                                            |
| `trap`      | 踩到陷阱路徑        | `{ userAgent, bot, flagged }`                                                                                           |
| `tarpit`    | 送出 Tarpit 頁      | `{ reason, canary, crawler, day }`：canary 預設按文件固定；crawler/day 是請求遙測，不能僅憑此 canary 判定是哪個爬蟲取得 |
| `injection` | body 中偵測到風險   | `{ findings }`                                                                                                          |
| `blocked`   | 請求被阻擋          | `{ reason, ... }`                                                                                                       |
| `error`     | 自訂 hook 拋錯      | `{ hook: 'document' \| 'render', message }`：引擎已改用內建內容／版型回應，不會變成只有被誘捕者看得到的 500             |

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
