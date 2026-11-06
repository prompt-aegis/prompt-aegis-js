# @prompt-aegis/dom

[![npm](https://img.shields.io/npm/v/@prompt-aegis/dom)](https://www.npmjs.com/package/@prompt-aegis/dom) ![license](https://img.shields.io/badge/license-MIT-blue)

> 瀏覽器端的 LLM 防護：輸入框與表單防護、隱形蜜罐（Honeypot／Tarpit）、隱藏注入掃描、自動化偵測，並提供 React 與 Vue 綁定。

## 目錄

- [安裝](#安裝)
- [引入方式](#引入方式)
- [快速開始](#快速開始)
- [輸入防護](#輸入防護)
  - [guardInput](#guardinput)
  - [guardForm](#guardform)
- [蜜罐與 Tarpit](#蜜罐與-tarpit)
  - [injectHoneypot](#injecthoneypot)
  - [addHoneypotField](#addhoneypotfield)
  - [buildHoneypotSpec](#buildhoneypotspec)
- [頁面內容檢查](#頁面內容檢查)
  - [scanForHiddenInjections](#scanforhiddeninjections)
  - [extractVisibleText](#extractvisibletext)
  - [hiddenReasons](#hiddenreasons)
- [自動化偵測](#自動化偵測)
- [React](#react)
- [Vue](#vue)
- [CDN／無打包工具](#cdn無打包工具)
- [型別](#型別)

## 安裝

```bash
npm install @prompt-aegis/dom
# 或
pnpm add @prompt-aegis/dom
# 或
yarn add @prompt-aegis/dom
# 或
bun add @prompt-aegis/dom
```

npm 頁面：<https://www.npmjs.com/package/@prompt-aegis/dom>

`@prompt-aegis/core` 會自動安裝。`react`、`vue` 為選用的 peer dependencies，只在使用對應子路徑時需要。

## 引入方式

| 匯入路徑                  | 內容                                 |
| :------------------------ | :----------------------------------- |
| `@prompt-aegis/dom`       | 原生 DOM API（不依賴任何框架）       |
| `@prompt-aegis/dom/react` | React Hooks 與元件（需 React ≥ 17）  |
| `@prompt-aegis/dom/vue`   | Vue 指令、元件與外掛（需 Vue ≥ 3.3） |

```ts
import { guardInput, injectHoneypot } from '@prompt-aegis/dom';
import { AegisHoneypot, useAegisGuard } from '@prompt-aegis/dom/react';
import { PromptAegis } from '@prompt-aegis/dom/vue';
```

## 快速開始

```ts
import { guardInput, injectHoneypot } from '@prompt-aegis/dom';

// 步驟 1：保護送往 LLM 的輸入框
const dispose = guardInput(document.querySelector<HTMLTextAreaElement>('#chat')!, {
  blockPasteAt: 0.85,
  onDetect: ({ result }) => console.warn('偵測到注入：', result.level),
  onBlock: () => alert('貼上的內容含有可疑指令，已阻擋'),
});

// 步驟 2：在頁面加入隱形蜜罐
const honeypot = injectHoneypot({ seed: location.pathname, trapPath: '/__aegis/trap' });
saveCanary(location.pathname, honeypot.canary); // 自行記錄，日後比對外洩

// 卸載時
dispose();
honeypot.remove();
```

## 輸入防護

### guardInput

```ts
guardInput(el: HTMLInputElement | HTMLTextAreaElement | HTMLElement, options?: GuardInputOptions): () => void
```

監聽 `input`、`paste`、`drop` 事件：

- 使用者輸入時即時移除隱形字元，並盡量保持游標位置。
- 貼上或拖放時偵測注入，風險達門檻可直接取消。
- 支援 `<textarea>`、`<input type="text|search|url|email|tel">`，以及 `contenteditable`（只修改文字節點，保留格式）。
- **框架相容**：透過原生 setter 寫回內容，並重新觸發 `input` 事件，所以 React 受控元件的 state、Vue 的 `v-model` 都會拿到清理後的值。
- **輸入法相容**：注音、拼音、日文假名組字期間（`compositionstart` 到 `compositionend`）不會修改內容，組字結束後才清理。
- **選項即時生效**：每次事件都會重新讀取 `options`，可以傳入可變物件；也可用 `liveGuardOptions(() => currentOptions)` 包裝 getter。

回傳值為解除監聽的函式。

**GuardInputOptions**

| 選項             | 型別                      | 預設值 | 說明                                                |
| :--------------- | :------------------------ | :----- | :-------------------------------------------------- |
| `stripInvisible` | `boolean`                 | `true` | 輸入時即時清除隱形字元                              |
| `blockPasteAt`   | `number`                  | —      | 貼上／拖放內容的分數達此值時取消（未設定則不阻擋）  |
| `sanitize`       | `SanitizeOptions`         | —      | 轉傳給 `sanitizePrompt`（此處固定為 `detect` 模式） |
| `onDetect`       | `(e: GuardEvent) => void` | —      | 風險等級不為 `none` 時呼叫                          |
| `onBlock`        | `(e: GuardEvent) => void` | —      | 貼上被阻擋時呼叫                                    |

**GuardEvent**：`{ element, source: 'paste' | 'input' | 'drop' | 'submit', result: SanitizeResult }`

### guardForm

```ts
guardForm(form: HTMLFormElement, options?: GuardFormOptions): () => void
```

在表單送出時（capture 階段）淨化所有文字欄位。`sanitize.mode` 設為 `'block'` 時，任一欄位達阻擋門檻就會取消送出。

**GuardFormOptions**

| 選項       | 型別                      | 預設值               | 說明                     |
| :--------- | :------------------------ | :------------------- | :----------------------- |
| `sanitize` | `SanitizeOptions`         | `{ mode: 'redact' }` | 淨化設定                 |
| `fields`   | `string[]`                | 全部文字欄位         | 只檢查指定 `name` 的欄位 |
| `rewrite`  | `boolean`                 | `true`               | 將淨化後的值寫回欄位     |
| `onDetect` | `(e: GuardEvent) => void` | —                    | 偵測到風險時呼叫         |
| `onBlock`  | `(e: GuardEvent) => void` | —                    | 送出被阻擋時呼叫         |

```ts
guardForm(document.querySelector('form#ask')!, {
  sanitize: { mode: 'block' },
  fields: ['question'],
  onBlock: ({ result }) => showError(`內容被拒絕（${result.level}）`),
});
```

## 蜜罐與 Tarpit

蜜罐是人看不到、但爬蟲與 AI 代理讀得到的內容。元素會加上：

- 畫面外定位與裁切（不使用 `display:none`，因為許多爬蟲會略過它）
- `aria-hidden="true"`：螢幕閱讀器略過
- `inert`、`tabindex="-1"`：無法聚焦或點擊
- `data-nosnippet`：不出現在搜尋摘要

**搜尋引擎**：預設不會對 Googlebot、Bingbot 等搜尋引擎爬蟲顯示蜜罐（`skipSearchEngines: true`）。隱藏文字可能被搜尋引擎視為垃圾內容，而這些爬蟲本來就會遵守 robots.txt。若希望只對可疑流量放蜜罐，可以搭配 `detectAutomation()`：

```ts
if (detectAutomation().automated) injectHoneypot({ seed: location.pathname });
```

### injectHoneypot

```ts
injectHoneypot(options?: HoneypotOptions): HoneypotHandle
```

**HoneypotOptions**（另可傳入所有 core 的 `TarpitOptions`：`seed`、`paragraphs`、`sentences`、`canary`、`notice`、`maze`）

| 選項                | 型別                             | 預設值          | 說明                                                                        |
| :------------------ | :------------------------------- | :-------------- | :-------------------------------------------------------------------------- |
| `target`            | `HTMLElement`                    | `document.body` | 插入位置                                                                    |
| `position`          | `InsertPosition`                 | `'beforeend'`   | 相對於 `target` 的插入方式                                                  |
| `trapPath`          | `string`                         | —               | 陷阱連結路徑（自動產生 3 條迷宮連結）。請在 robots.txt 中 `Disallow` 此路徑 |
| `onTrap`            | `(e: HoneypotTrapEvent) => void` | —               | 陷阱連結被以程式點擊時呼叫                                                  |
| `skipSearchEngines` | `boolean`                        | `true`          | 搜尋引擎爬蟲造訪時不插入（回傳未掛載的 handle）                             |

**HoneypotHandle**：`{ element, payload, canary, remove() }`

**HoneypotTrapEvent**：`{ type: 'link-click' | 'field-filled', href?, field?, canary }`

```ts
const hp = injectHoneypot({
  seed: location.pathname, // 同一頁面每次產生相同內容
  trapPath: '/__aegis/trap',
  onTrap: (e) => navigator.sendBeacon('/api/bot-report', JSON.stringify(e)),
});
```

> 搭配 `@prompt-aegis/node` 時，伺服器會把造訪 `trapPath` 的來源標記為爬蟲並回傳 Tarpit 頁面。

### addHoneypotField

```ts
addHoneypotField(form: HTMLFormElement, options?: HoneypotFieldOptions): () => void
```

傳統的表單蜜罐：插入一個隱形欄位，真人不會填寫，但自動填表機器人與 LLM 瀏覽器代理常會填入。

| 選項            | 型別                             | 預設值      | 說明                             |
| :-------------- | :------------------------------- | :---------- | :------------------------------- |
| `name`          | `string`                         | `'website'` | 欄位名稱，建議使用具吸引力的名稱 |
| `preventSubmit` | `boolean`                        | `true`      | 欄位被填寫時取消送出             |
| `onTrap`        | `(e: HoneypotTrapEvent) => void` | —           | 觸發時呼叫                       |

```ts
addHoneypotField(document.querySelector('form#signup')!, {
  name: 'company_url',
  onTrap: () => reportBot('signup-form'),
});
```

### buildHoneypotSpec

```ts
buildHoneypotSpec(options?: TarpitOptions & { trapPath?: string }): HoneypotSpec
```

產生與框架無關的蜜罐描述 `{ attrs, style, payload }`，可用於自訂渲染（例如 Svelte、Solid、伺服器模板）。相關常數：

- `HONEYPOT_ATTR`：`'data-aegis-honeypot'`
- `HIDDEN_STYLE`：隱藏用的 CSS 屬性物件

## 頁面內容檢查

### scanForHiddenInjections

```ts
scanForHiddenInjections(root?: ParentNode, options?: ScanOptions): HiddenInjectionFinding[]
```

找出「人看不到、但 LLM 讀得到」的可疑指令，例如使用者生成內容、第三方 widget、或 webview 中的 Email 裡藏的間接注入。

偵測的隱藏手法：`display-none`、`visibility-hidden`、`opacity-zero`、`font-size-zero`、`offscreen`、`clipped`、`same-color`（文字顏色與實際背景相同，會往上查祖先元素的背景色）、`hidden-attribute`、`comment`（HTML 註解）、`attribute`（`alt`、`title` 等屬性），以及 Unicode Tag 字元夾帶。

**ScanOptions**

| 選項            | 型別            | 預設值                                                          | 說明                       |
| :-------------- | :-------------- | :-------------------------------------------------------------- | :------------------------- |
| `detect`        | `DetectOptions` | —                                                               | 轉傳給 `detectInjection`   |
| `includeClean`  | `boolean`       | `false`                                                         | 未命中規則的隱藏文字也回傳 |
| `attributes`    | `string[]`      | `['alt','title','aria-label','aria-description','placeholder']` | 要掃描的屬性               |
| `comments`      | `boolean`       | `true`                                                          | 掃描 HTML 註解             |
| `skipHoneypots` | `boolean`       | `true`                                                          | 略過本套件產生的蜜罐       |

**HiddenInjectionFinding**：`{ element, text, reasons: HiddenReason[], detection: DetectionResult }`

```ts
const findings = scanForHiddenInjections(document.querySelector('#user-comments')!);
for (const f of findings) {
  console.warn(f.reasons, f.detection.level, f.text);
  f.element.remove();
}
```

### extractVisibleText

```ts
extractVisibleText(root?: Element): string
```

只擷取使用者實際看得到的文字（排除隱藏元素、蜜罐、`script`／`style`，並清除隱形字元）。要把目前頁面內容交給 LLM 摘要或問答時，請使用它，而不是 `innerText` 或 `textContent`。

```ts
const pageText = extractVisibleText(document.querySelector('main')!);
await askLLM(`請摘要以下頁面：\n${pageText}`);
```

### hiddenReasons

```ts
hiddenReasons(el: Element): HiddenReason[]
```

回傳元素對人眼隱藏的原因（會檢查祖先元素），空陣列表示可見。

## 自動化偵測

```ts
detectAutomation(win?: Window): { automated: boolean; signals: string[] }
```

盡力偵測 Selenium、Puppeteer、Playwright、PhantomJS、無頭 Chrome 等自動化環境（LLM 瀏覽器代理多半運行在這些環境上）。檢查項目包含 `navigator.webdriver`、HeadlessChrome UA、各工具注入的全域變數、chromedriver 標記等。

> 容易被規避，請只當作多個訊號之一，不要單憑它拒絕真人使用者。

```ts
const { automated, signals } = detectAutomation();
if (automated) analytics.track('automation-detected', { signals });
```

## React

```tsx
import { useRef } from 'react';
import {
  AegisHoneypot,
  useAegisGuard,
  useAutomationDetection,
  useSafeModelOutput,
} from '@prompt-aegis/dom/react';

export function Chat({ reply }: { reply: string }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAegisGuard(inputRef, {
    blockPasteAt: 0.85,
    onDetect: (e) => console.warn(e.result.level),
  });

  const safeReply = useSafeModelOutput(reply, { allowedImageHosts: ['*.myapp.com'] });
  const { automated } = useAutomationDetection();

  return (
    <>
      <Markdown>{safeReply}</Markdown>
      <textarea ref={inputRef} />
      {automated && <p>偵測到自動化環境</p>}
      <AegisHoneypot seed="/chat" trapPath="/__aegis/trap" onTrap={(e) => report(e)} />
    </>
  );
}
```

| API                                      | 說明                                                                                                                                                                    |
| :--------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAegisGuard(ref, options?)`           | 對 ref 指向的元素套用 `guardInput`，元件卸載時自動解除；所有選項（含 `blockPasteAt`）都即時使用最新值，不會重新綁定                                                     |
| `<AegisHoneypot />`                      | 隱形蜜罐元件。props：`seed`、`trapPath`、`canary`、`paragraphs`、`notice`、`onTrap`、`skipSearchEngines`（預設 `true`，掛載後對搜尋引擎移除），以及其他 `TarpitOptions` |
| `useAutomationDetection()`               | 回傳 `{ automated, signals }`；SSR 與首次渲染時為空，掛載後更新                                                                                                         |
| `useSafeModelOutput(markdown, options?)` | 經 memo 的 `sanitizeModelOutput(...).text`                                                                                                                              |

**SSR（Next.js 等）**：`<AegisHoneypot>` 請務必傳入 `seed`（例如路由路徑），伺服器端與客戶端才會產生相同標記，避免 hydration 不一致。

## Vue

**全域註冊（外掛）**

```ts
import { createApp } from 'vue';
import { PromptAegis } from '@prompt-aegis/dom/vue';
import App from './App.vue';

createApp(App).use(PromptAegis).mount('#app');
```

```vue
<template>
  <textarea v-aegis-guard="{ blockPasteAt: 0.85, onDetect }" />
  <AegisHoneypot seed="/chat" trap-path="/__aegis/trap" @trap="onTrap" />
</template>

<script setup lang="ts">
import type { GuardEvent, HoneypotTrapEvent } from '@prompt-aegis/dom';

const onDetect = (e: GuardEvent) => console.warn(e.result.level);
const onTrap = (e: HoneypotTrapEvent) => console.warn('trap', e);
</script>
```

**區域引入**

```vue
<script setup lang="ts">
import { vAegisGuard, AegisHoneypot } from '@prompt-aegis/dom/vue';
</script>

<template>
  <textarea v-aegis-guard />
  <AegisHoneypot seed="/about" />
</template>
```

| API             | 說明                                                                                                   |
| :-------------- | :----------------------------------------------------------------------------------------------------- |
| `PromptAegis`   | 外掛，註冊 `v-aegis-guard` 指令與 `<AegisHoneypot>` 元件                                               |
| `vAegisGuard`   | 指令，值為 `GuardInputOptions`；選項即時生效，傳入行內物件也不會在每次渲染時重新綁定                   |
| `AegisHoneypot` | 元件。props：`seed`、`canary`、`trapPath`、`paragraphs`、`notice`、`skip-search-engines`；事件：`trap` |

## CDN／無打包工具

```html
<script type="module">
  import { guardInput } from 'https://cdn.jsdelivr.net/npm/@prompt-aegis/dom/+esm';
  guardInput(document.querySelector('#chat'));
</script>
```

## 型別

```ts
import type {
  GuardTarget,
  GuardEvent,
  GuardInputOptions,
  GuardFormOptions,
  HoneypotOptions,
  HoneypotHandle,
  HoneypotSpec,
  HoneypotTrapEvent,
  HoneypotFieldOptions,
  ScanOptions,
  HiddenReason,
  HiddenInjectionFinding,
  AutomationSignals,
} from '@prompt-aegis/dom';

import type { AegisHoneypotProps } from '@prompt-aegis/dom/react';
```

## 授權

MIT
