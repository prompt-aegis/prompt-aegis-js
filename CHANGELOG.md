# 版本紀錄

本專案的所有重要變更都會記錄在這裡。格式依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號依循 [語意化版本](https://semver.org/lang/zh-TW/)。三個套件（`@prompt-aegis/core`、`@prompt-aegis/dom`、`@prompt-aegis/node`）使用相同的版本號。

## [未發佈]

## [0.1.0] — 2026-11-06

第一個公開版本。

### 新增

- **core**：隱形字元清除（零寬、雙向控制、Unicode Tag、變體選擇符）；中英文提示詞注入偵測規則（含全形字與西里爾／希臘同形字）；`sanitizePrompt` 的 `detect`／`redact`／`block` 模式；Spotlighting（`delimit`／`datamark`／`encode`，`datamark` 支援中日韓文字）；模型輸出過濾 `sanitizeModelOutput`（fail-closed，預設跳脫原始 HTML，另有 `html: 'filter'` 模式）；AI 爬蟲辨識與 robots.txt 產生；Tarpit 誘餌內容與 Canary。
- **dom**：`guardInput`、`guardForm`、`injectHoneypot`、`addHoneypotField`、`scanForHiddenInjections`、`extractVisibleText`、`detectAutomation`；React（`@prompt-aegis/dom/react`）與 Vue（`@prompt-aegis/dom/vue`）綁定。支援 React 受控元件、Vue `v-model` 與輸入法組字；可在 iframe、jsdom 等不同 realm 中使用。
- **node**：Express、Koa、Fastify、Hono、Fetch API（Next.js、Bun、Deno、Workers）adapter；爬蟲政策、陷阱路徑、Tarpit 回應、請求內容檢查、`onEvent` 事件。
- `examples/demo-site`：用套件保護的本機部落格，以及 `pnpm attack` 模擬攻擊腳本（42 項檢查）與 `pnpm attack:unprotected` 對照組。
- GitHub Actions CI：Node 18／20／22 × Ubuntu／macOS。

### 安全性

發佈前經過兩輪安全審查，以下行為都有測試保護：

- 所有偵測規則都是線性時間，並以對抗性輸入測試 ReDoS。
- 偵測掃描全文（上限 1,000,000 字元，`DEFAULT_MAX_SCAN_LENGTH`）；超過上限時以 high 等級的 `scan.truncated` 標記，不會因為填充文字而放行。
- 請求內容檢查限制巢狀深度（`maxDepth`）、字串數（`maxStrings`）與總字元數（`maxTotalChars`）；`fields` 路徑涵蓋整個子樹，包含 OpenAI 格式的內容陣列。
- `trustProxy` 從 `X-Forwarded-For` 右側取值，可指定代理層數；另有 `ipHeader`。
- 陷阱路徑依 `Sec-Fetch-*` 判斷是否標記，跨站與子資源請求不會連累真人訪客；標記鍵為 IP + User-Agent。
- Tarpit 有同時延遲上限（`tarpit.maxConcurrent`）；每個爬蟲、每天的 Canary 都不同；搜尋引擎爬蟲不會看到蜜罐。

[未發佈]: https://github.com/prompt-aegis/prompt-aegis-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/prompt-aegis/prompt-aegis-js/releases/tag/v0.1.0
