# 版本紀錄

本專案的所有重要變更都會記錄在這裡。格式依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號依循 [語意化版本](https://semver.org/lang/zh-TW/)。各套件（`@prompt-aegis/core`、`@prompt-aegis/dom`、`@prompt-aegis/node`、`@prompt-aegis/tarpit`）各自維護版本號。

## [未發佈]

## [0.2.0] — 2026-11-27

`@prompt-aegis/core`、`@prompt-aegis/node`、`@prompt-aegis/dom` 0.2.0。`@prompt-aegis/tarpit` 未變更，維持 0.1.0。

> **含破壞性變更**：預設陷阱路徑（`/documents/archive`）、canary 字首（`doc`）、標記鍵（IP）、DOM 蜜罐標記屬性（`data-cref`）與 robots.txt 規則都改變了。升級前請讀 `@prompt-aegis/node` README 的「升級注意」。

### 新增

- **誘餌隱匿性硬化（`core` 0.2.0、`node` 0.2.0、`dom` 0.2.0）**：讓 server 端誘餌頁不易被推理型 agent 一眼識破。
  - **core**：誘餌頁改成像真實文件索引（站名/頁首/頁尾、擬真標題、內部一致的日期）；canary 織進內文當文件代碼，關掉 `notice` 也能歸因；`TarpitOptions` 新增 `content`（覆寫語料以對齊母站語言）與 `maze.leafRate`（死路葉節點，打破「一眼無限」）；`renderTarpitHtml` 新增 `siteName`／`wrap`；新增 `renderSoftNotFound`、`TarpitContent` 型別。
  - **node**：`tarpit` 新增 `canaryPrefix`（預設 `doc`）、`notice`、`leafRate`、`content`、`siteName`、`render`、`headers`。
  - **dom**：蜜罐可傳入中性字首 canary 以隱匿。

### 對抗測試後的強化

- **node**：預設 IP 標記不再受 UA 輪替影響；共用 NAT 請接入可信 session／帳號 `flagKey`。新增私有路由 `access` 驗證掛鉤，驗證失敗或拋錯回 403；未設定時不宣稱能區分正常瀏覽器與 UA 偽裝者。
- **node**：canary 預設按文件固定，`canaryScope: 'crawler-day'` 可明確恢復可辨識的逐爬蟲／日模式。子連結採 HMAC 簽章，只有精確入口與有效簽章子頁回誘餌；未知或竄改路徑不標記訪客，並照一般路徑交給網站自己回應（見下方「修正」）。
- **core/node/dom**：預設段落降低逐句日期重複，新增 `tarpit.document` 站內文件提供者；DOM `trapPath` 改連精確入口。隱藏屬性與 robots 規則保留，其可辨識性仍列入 LIMIT 測試。

### 安全性

- **node**：`access.paths` 與 `sanitize.paths` 可被路徑的不同寫法繞過。比對原本只看原始路徑、區分大小寫、不解碼，但 Express 預設不分大小寫且會解碼路由參數，所以 `/PRIVATE/secret`、`/private/%73ecret` 會跳過 `access.verify` 卻仍抵達私有路由；`/API/comments` 會跳過提示詞注入檢查而把惡意留言存進資料庫。現在比對會同時檢查原始、百分比解碼（含雙重編碼）、`//`／`.`／`..` 正規化與不分大小寫的各種寫法，任一命中即套用規則（只會多檢查、不會漏檢查）。RegExp 規則同樣對所有寫法測試。新增 `examples/demo-site/attack-access.mjs` 與回歸測試 R5／R5b／R6。

### 修正

- **core**：HTML 迷宮連結不再使用 PDF／Office／CSV 副檔名；`leafRate` 不再讓連結數超過 `count`，`count: 0` 保持零連結。payload 與 soft-not-found 的預設 canary 字首改為 `doc`；`createCanary()` 的預設不變。
- **node**：新增伺服器專用 `tarpit.secret`，以 HMAC 衍生內容與 canary seed；省略則每個 engine 產生隨機金鑰。共用秘密可維持多實例／重啟一致，正文不再每日重抽。預設路徑改為 `/documents/archive`，預設 canary 字首改為 `doc`；升級需同步 DOM 連結、robots.txt 與監控規則，也可明確設定舊值。
- **dom**：預設不輸出勸退聲明，仍可透過 `notice` 明確啟用；保留無障礙與互動隔離。
- **node**：robots.txt 的陷阱規則由 `Disallow: <trapPath>/` 改為 `Disallow: <trapPath>`。robots 是前綴比對，舊寫法沒有涵蓋 DOM 蜜罐連到的精確入口，遵守 robots 的爬蟲（搜尋引擎、企業內部索引器、連結檢查）會走進陷阱並被以 IP 標記，之後整站都拿到誘餌頁。
- **node**：陷阱前綴下未簽發的路徑不再由引擎回自製的 `<h1>Not found</h1>`（加 `no-store`），改為照一般路徑處理、交給網站自己回應。自製 404 與網站真實 404 不同，可被用來比對出陷阱前綴。
- **node**：`tarpit.document`／`tarpit.render` 拋錯時不再讓請求失敗（Express 會變成只有被誘捕者看得到的 500），改用內建內容／版型回應，並發出新的 `error` 事件 `{ hook, message }`。
- **node**：未設定 `tarpit.secret` 時，第一次產生誘餌頁會在 console 警告一次（多實例或重啟後簽章連結會失效）；`NODE_ENV=test` 時不顯示。
- **core**：預設段落產生器在同一段內不再重複抽到相同結果句（不重複抽樣），消除「no exceptions were noted … no exceptions were noted」這類逐字重複的合成痕跡。
- **examples/demo-site**：前端蜜罐的 `trapPath` 與伺服器的陷阱路徑對齊（先前不一致，AI 瀏覽器代理點擊隱藏連結不會被標記）；示範改用不顯眼的 `/archive` 路徑，誘餌頁套用網站真實的 zh-Hant 版型與中文內容。

### 文件

- **node**：README 新增「完整隱匿範本（經推理型 agent 實測）」與上線前自我檢查表，以及「企業內部系統：改用帳號身分標記」——內網流量常集中在少數 proxy／NAT 出口，預設以 IP 標記會讓整個出口一起被誘捕，建議以伺服器驗證過的 session／SSO 帳號作為 `flagKey`。

### 變更

- **node**：tarpit 回應預設標頭放寬（不再掛 `X-Robots-Tag`/`no-store`，`noindex` 改由頁內 `<meta>`）；誘餌內容不再隨 User-Agent 變動（避免成為指紋），但 canary 預設也按文件固定，避免 UA 差異比對；tarpit 延遲加入 0.5×–1.5× 抖動。
- **dom**：蜜罐標記屬性由 `data-aegis-honeypot` 改為中性的 `data-cref`，且不再把 canary 放進屬性（避免被採集）；canary 改置於隱藏區塊的文字中。若你的程式碼以 `[data-aegis-honeypot]` 選取蜜罐，請改用 `HONEYPOT_ATTR` 常數。

## [tarpit 0.1.0] — 2026-11-09

### 新增

- **`@prompt-aegis/tarpit`（新套件，0.1.0）**：被動式 agent-tarpit，實作 Mantis 論文（[arXiv:2410.20911](https://arxiv.org/abs/2410.20911)）的被動防禦。
  - `createFakeFilesystem`：決定性、無限深的假檔案系統產生器，目錄名誘人，`dirsPerLevel` 可調到數千以放大攻擊者的 token 成本，支援 Canary。
  - `createFtpTarpit`：零依賴的 FTP 蜜罐伺服器，把自動化 LLM 攻擊代理困在假檔案系統裡無止盡探索；未知指令一律回 `502` 逼代理留在基本導覽；內建事件遙測，預設只綁本機。
  - 刻意**不**實作論文的「主動反擊（hack-back／reverse shell）」——那是入侵他人機器的程式碼，且在多數司法管轄區違法。
- `examples/agent-trap`：`pnpm trap-demo` 示範一個貪婪的自動化代理如何被困住、燒掉回合與頻寬。

## [0.1.1] — 2026-11-06

### 修正

- **dom**：使用 `"moduleResolution": "node"`（TypeScript 5 的 `node10`）的專案，找不到 `@prompt-aegis/dom/vue` 與 `@prompt-aegis/dom/react` 的型別（`TS2307`）。現在透過 `typesVersions` 支援，並新增測試確認在 `node`、`node16`、`nodenext`、`bundler` 下都能解析。

### 文件

- README 新增完整的安裝方法（npm／pnpm／yarn／Bun、TypeScript 設定、CDN）與六種使用情境（Express、Next.js、Vue 3、React、純 HTML、自己串接 LLM），所有範例都經過實際安裝與執行驗證。
- 各套件 README 加入 Bun 安裝方式與 npm 連結。

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

[未發佈]: https://github.com/prompt-aegis/prompt-aegis-js/compare/core-v0.2.0...HEAD
[0.2.0]: https://github.com/prompt-aegis/prompt-aegis-js/compare/v0.1.1...core-v0.2.0
[tarpit 0.1.0]: https://github.com/prompt-aegis/prompt-aegis-js/releases/tag/tarpit-v0.1.0
[0.1.1]: https://github.com/prompt-aegis/prompt-aegis-js/releases/tag/v0.1.1
[0.1.0]: https://github.com/prompt-aegis/prompt-aegis-js/releases/tag/v0.1.0
