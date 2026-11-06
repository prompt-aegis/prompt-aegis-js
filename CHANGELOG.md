# 版本紀錄

本專案的所有重要變更都會記錄在這裡。格式依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號依循 [語意化版本](https://semver.org/lang/zh-TW/)。三個套件（`@prompt-aegis/core`、`@prompt-aegis/dom`、`@prompt-aegis/node`）使用相同的版本號。

## [未發佈]

### 新增

- GitHub Actions CI：Node 18／20／22 × Ubuntu／macOS，執行建置、型別檢查、lint、格式檢查、測試與攻擊腳本，並確認攻擊腳本在關閉防護時會失敗。
- 公開 API 快照測試，避免不小心匯出內部函式。
- `examples/demo-site`：用套件保護的本機部落格，以及 `pnpm attack` 模擬攻擊腳本（42 項檢查），`pnpm attack:unprotected` 為關閉防護的對照組。示範網站只監聽本機、留言數量有上限，攻擊腳本會先確認目標是這個 demo。

### 安全性

- **core**：偵測不再只掃描前 100,000 個字元。原本在攻擊前塞入填充文字就能繞過偵測（全形字、同形字甚至不會被遮蔽）；現在預設掃描全文（上限 1,000,000 字元，`DEFAULT_MAX_SCAN_LENGTH`），超過上限時加入 high 等級的 `scan.truncated`，`block` 模式下會被阻擋。
- **node**：新增 `sanitize.maxStrings`（預設 2000）與 `sanitize.maxTotalChars`（預設 1,000,000），超過時回傳 `400 body_too_large`。原本一個含大量短字串的請求可以讓伺服器停頓數秒。
- **node**：`sanitize.fields` 的路徑改為涵蓋整個子樹。原本設定 `messages.*.content` 時，OpenAI 格式的內容陣列（`content: [{ type: 'text', text }]`）或把字串包進陣列，就能完全繞過檢查。

### 變更

- **node**：`sleep` 不再是公開 API（原本是不小心匯出的內部函式）。

### 修正

- **dom**：`scanForHiddenInjections`、`extractVisibleText`、`guardInput` 不再依賴全域的 `NodeFilter`／`Node`／`Event`／`HTMLTextAreaElement`，可以在 Node 搭配 jsdom、或 iframe 等不同 realm 中使用。

## [0.1.0] — 尚未發佈

第一個版本。

### 新增

- **core**：隱形字元清除（零寬、雙向控制、Unicode Tag、變體選擇符）；中英文注入偵測規則；`sanitizePrompt` 的 `detect`／`redact`／`block` 模式；Spotlighting（`delimit`／`datamark`／`encode`）；模型輸出過濾 `sanitizeModelOutput`；AI 爬蟲辨識與 robots.txt 產生；Tarpit 誘餌內容與 Canary。
- **dom**：`guardInput`、`guardForm`、`injectHoneypot`、`addHoneypotField`、`scanForHiddenInjections`、`extractVisibleText`、`detectAutomation`；React（`@prompt-aegis/dom/react`）與 Vue（`@prompt-aegis/dom/vue`）綁定。
- **node**：Express、Koa、Fastify、Hono、Fetch API adapter；爬蟲政策、陷阱路徑、Tarpit 回應、請求內容檢查、`onEvent` 事件。

### 安全性強化（發佈前的安全審查）

- 修正 `delimiter.fake-turn` 等規則的 ReDoS（最壞情況 O(n³)），並為所有規則加入對抗性效能測試。
- `trustProxy` 改為從 `X-Forwarded-For` 右側取值，並可指定代理層數；新增 `ipHeader`。Koa 改用 socket 位址。
- 陷阱路徑依 `Sec-Fetch-*` 判斷是否標記，跨站與子資源請求不會標記；標記鍵改為 IP + User-Agent，並可用 `flagKey` 自訂。
- `sanitizeModelOutput` 改為 fail-closed：預設跳脫原始 HTML，依 CommonMark 解析 Markdown 圖片，新增 `html: 'filter'` 模式。
- `guardInput` 修正 React 受控元件與 Vue `v-model` 的狀態不同步，並在輸入法組字期間不修改內容。
- 調整規則降低誤判；新增西里爾／希臘同形字偵測；混淆過的高風險片段也會被遮蔽；`datamark` 支援中日韓文字。
- 請求內容檢查支援 `null` 原型物件，並新增 `sanitize.maxDepth`（預設 64）。
- 新增 `tarpit.maxConcurrent`；每個爬蟲、每天的 Canary 都不同；搜尋引擎爬蟲不會看到蜜罐（`skipSearchEngines`）。
- 套件加入 `publishConfig.access: "public"` 與 `release` 指令。

### 升級注意事項（相對於開發中的早期版本）

- `sanitizeModelOutput` 預設會把原始 HTML 跳脫成文字；需要渲染 HTML 時請使用 `html: 'filter'`。
- 規則 `jailbreak.known-modes` 拆成 `jailbreak.dan`（high）與 `jailbreak.mode-switch`（medium）；`delimiter.fake-turn` 改為 low。若你在 `disabledRules` 中使用舊的 ID，請更新。
- `trustProxy: true` 改從 `X-Forwarded-For` 右側取值。
- 陷阱標記的預設鍵從 `ip:<IP>` 改為 IP + User-Agent 雜湊；若自行讀取 `FlagStore`，請改用 `defaultFlagKey()`。

[未發佈]: https://github.com/prompt-aegis/prompt-aegis-js/compare/develop-1106...HEAD
[0.1.0]: https://github.com/prompt-aegis/prompt-aegis-js/tree/develop-1106
