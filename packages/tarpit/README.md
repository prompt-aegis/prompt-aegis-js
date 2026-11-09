# @prompt-aegis/tarpit

[![npm](https://img.shields.io/npm/v/@prompt-aegis/tarpit)](https://www.npmjs.com/package/@prompt-aegis/tarpit) ![license](https://img.shields.io/badge/license-MIT-blue)

> 被動式 agent-tarpit：一個協定層蜜罐（FTP），把自動化的 LLM 攻擊代理困在無限深的假檔案系統裡，耗盡它的時間與 API 預算。**純防禦**——只在你自己的機器上浪費攻擊者的資源，絕不碰對方的機器。

這是論文 **Mantis**（Pasquini et al., 2024,[arXiv:2410.20911](https://arxiv.org/abs/2410.20911)）「被動防禦（agent-tarpit）」的 TypeScript 實作。論文另有「主動反擊（hack-back／reverse shell）」部分，**本套件刻意不實作**，原因見[下方](#為什麼只有被動防禦)。

## 這是什麼、不是什麼

| 它做什麼                                        | 它不做什麼                          |
| :---------------------------------------------- | :---------------------------------- |
| 在你的機器上架一個假的 FTP 服務                 | ❌ 不連線、不傳送任何東西到對方機器 |
| 回應無限深、看起來藏有機密的假目錄              | ❌ 不在任何人的機器上執行指令       |
| 讓攻擊代理一直 `ls`／`cd`，耗掉它的回合與 token | ❌ 不是反擊工具，不是 exploit       |
| 可埋入 Canary，日後追查外洩                     | ❌ 不碰你真正的服務與資料           |

本質上就是一個**蜜罐**：你擺出假資料，浪費自動化程式的時間和金錢。它和傳統 honeypot 的差別只在於，它是針對「會自動探索、判斷、但缺乏人類常識」的 LLM 代理設計的。

## 運作原理

自動化攻擊代理攻陷一個服務後，會去「探索」檔案系統找有價值的東西。本套件利用這一點：

1. **誘餌**：假 FTP 以匿名登入吸引代理進來。
2. **無限樹**：每個目錄永遠有更多子目錄,名字都很誘人（`credentials_dump`、`root_certificates`、`db_backups`…）。代理一層層往下鑽，永遠到不了底。
3. **拒絕其他指令**：除了 `ls`／`cd` 等基本導覽，其他指令一律回 `502`，逼代理留在這個行動空間裡，無法用更強的工具逃出去。
4. **放大成本**：每層回傳大量目錄項目灌爆代理的 context；LLM 依 token 計費，成本直接上升。

人類攻擊者幾下就會發現這是死路，但實測中的 LLM 代理會**無止盡地深度優先搜尋下去**。

## 何時觸發與如何部署

這是一個**誘餌服務**，不是裝在你真實服務前面的過濾器——它不會自動分析你 app 的流量，而是等攻擊程式自己連進來上鉤。

**觸發時機**：當有東西連上這個假 FTP、登入、開始翻目錄時就觸發。典型流程是自動化代理掃描一台機器 → 發現 FTP → 嘗試匿名登入 → 登入後探索檔案系統找機密。`onEvent` 的 `connect`／`login`／`list` 事件就是「有自動化程式正在攻打」的訊號。

**部署要點**：

- 把它架在你有權掌控、且攻擊者會掃到的地方；**不要**和你真正在用的 FTP 服務混在一起。
- 一般使用者本來就不會去連一個誘餌 FTP，所以連進來的流量本身就可疑——但仍請謹慎放置，預設只綁本機（見[部署與法律](#部署與法律)）。
- 用 `onEvent` 把登入與探索事件送進你的告警系統，有人踩進來就會知道。
- 它負責的是「困住會自動攻打協定服務的攻擊代理」；你真實 app 的注入防護，交給 `@prompt-aegis/node` 與 `@prompt-aegis/dom`。

## 安裝

```bash
npm install @prompt-aegis/tarpit
# 或
pnpm add @prompt-aegis/tarpit
# 或
bun add @prompt-aegis/tarpit
```

需要 Node.js ≥ 18。零執行期依賴（只用 Node 內建的 `net`）。

## 快速開始

```ts
import { createFtpTarpit } from '@prompt-aegis/tarpit';

const tarpit = await createFtpTarpit({
  host: '127.0.0.1', // 預設只綁本機；要對外請讀下方「部署與法律」
  port: 2121,
  filesystem: {
    seed: 'my-site', // 固定種子 → 固定假樹（可重現、可快取）
    dirsPerLevel: [20, 40], // 每層目錄數；調大就更花攻擊者的錢
  },
  onEvent: (e) => console.log('[tarpit]', e.type, e.detail ?? ''),
}).listen();

console.log(`tarpit FTP on ${tarpit.host}:${tarpit.port}`);
// 結束時：await tarpit.close();
```

用任何 FTP 客戶端連進去（`ftp 127.0.0.1 2121`，帳號 `anonymous`），`ls` 和 `cd` 看看——目錄永遠不會到底。

想看它實際困住一個自動化代理：

```bash
# 在 monorepo 根目錄
pnpm trap-demo
```

> 相容真實客戶端：測試套件會用真實的 `basic-ftp` 函式庫實際登入、列目錄、往下鑽五層、下載檔案；也用系統 `curl` 的 FTP 模式驗證過。LLM 攻擊代理所用的 FTP 工具都能正常被困住。

## API

### `createFtpTarpit(options)`

啟動一個 FTP tarpit 伺服器。回傳 `FtpTarpit`，呼叫 `.listen()` 開始監聽。

| 選項             | 型別                                      | 預設                   | 說明                                                                   |
| :--------------- | :---------------------------------------- | :--------------------- | :--------------------------------------------------------------------- |
| `host`           | `string`                                  | `'127.0.0.1'`          | 綁定位址。預設只接受本機連線                                           |
| `port`           | `number`                                  | `2121`                 | 控制埠（port 21 需要權限）                                             |
| `filesystem`     | `FakeFilesystem \| FakeFilesystemOptions` | —                      | 假檔案系統，或建立它的選項                                             |
| `pasvHost`       | `string`                                  | 控制連線的本地位址     | PASV 回應中對外公告的 IPv4                                             |
| `banner`         | `string`                                  | `'220 (vsFTPd 3.0.3)'` | 招呼訊息；看起來有漏洞的 banner 更能引誘代理                           |
| `fileContent`    | `(path, size) => string \| Buffer`        | 短的決定性垃圾內容     | `RETR` 時回傳的檔案內容                                                |
| `maxFileBytes`   | `number`                                  | `4096`                 | `RETR` 實際送出的位元組上限（保持小，避免代理為了讀大檔而離開 tarpit） |
| `idleTimeoutMs`  | `number`                                  | `300000`               | 閒置超過此時間就中斷連線                                               |
| `maxConnections` | `number`                                  | `512`                  | 同時連線數上限                                                         |
| `onEvent`        | `(e: FtpTarpitEvent) => void`             | —                      | 遙測事件回呼                                                           |

**`FtpTarpit`**：`{ host, port, connections, filesystem, listen(), close() }`。

**`FtpTarpitEvent`**：`{ type, sessionId?, remoteAddress?, detail? }`，`type` 為 `listening`／`connect`／`login`／`command`／`list`／`retrieve`／`disconnect`／`error`。用它記錄誰進來、停留多久、處理了多少資料。

### `createFakeFilesystem(options)`

單獨建立假檔案系統（可用於其他協定或自訂伺服器）。

| 選項                           | 型別               | 預設           | 說明                                                         |
| :----------------------------- | :----------------- | :------------- | :----------------------------------------------------------- |
| `seed`                         | `string \| number` | 隨機           | 相同種子 → 相同的樹                                          |
| `dirsPerLevel`                 | `[number, number]` | `[8, 16]`      | 每層目錄數範圍。**這是放大攻擊者成本的主要旋鈕**，可調到數千 |
| `filesPerLevel`                | `[number, number]` | `[1, 4]`       | 每層假檔案數                                                 |
| `dirNames`                     | `string[]`         | 內建誘人清單   | 目錄名稱來源                                                 |
| `fileNames` / `fileExtensions` | `string[]`         | 內建清單       | 檔名與副檔名                                                 |
| `fileSize`                     | `[number, number]` | `[512, 65536]` | 假檔案的大小範圍                                             |
| `canaryRate`                   | `number`           | `0`            | 在約這個比例的目錄埋入 Canary 檔（0–1）                      |
| `canary`                       | `string`           | 依種子產生     | 指定 Canary 字串                                             |
| `maxDepth`                     | `number`           | `Infinity`     | 超過此深度不再產生子目錄                                     |

回傳 `FakeFilesystem`：`{ canary, list(path), resolve(cwd, arg), depth(path), isFile(path) }`。

```ts
import { createFakeFilesystem } from '@prompt-aegis/tarpit';

const fs = createFakeFilesystem({ seed: 's', dirsPerLevel: [3000, 3000] });
fs.list('/db_backups/root_certificates').entries.length; // 3000 個子目錄，灌爆 context
```

### 其他匯出

- `formatListLine` / `formatList` / `formatNameList`：把 entries 轉成 FTP `LIST`／`NLST` 用的 Unix `ls -l` 格式。
- `normalizePath`：正規化 POSIX 路徑（`..` 不會跳出根目錄）。
- `createCanary` / `findCanaries`：從 `@prompt-aegis/core` 重新匯出，方便追查外洩。

## 用 Canary 追查外洩

```ts
import { createFtpTarpit, findCanaries } from '@prompt-aegis/tarpit';

const tarpit = await createFtpTarpit({
  filesystem: { seed: 's', canaryRate: 0.3 }, // 三成目錄埋入 canary 檔
}).listen();

console.log('this tarpit’s canary:', tarpit.filesystem.canary);
// 日後若在某個 AI 的輸出、資料集或貼文裡看到這個字串：
findCanaries(suspectText, [tarpit.filesystem.canary]); // 命中 → 證明被這裡抓過
```

## 為什麼只有被動防禦

論文 Mantis 還示範了「主動反擊」：誘使攻擊方的 LLM 在**自己的機器上**開一個 reverse shell，讓防禦方反過來控制攻擊者的電腦。**本套件不實作這部分**，因為：

- 那是入侵他人系統的程式碼，不論包裝成「反擊」與否，本質如此。
- hack-back 在美國（CFAA）、台灣（刑法妨害電腦使用罪）等多數司法管轄區都違法，而且無法可靠分辨對方是真攻擊者還是被挾持的第三方機器。論文作者自己也只在完全隔離、無對外網路的沙箱裡做，並大篇幅討論法律與倫理。

被動 tarpit 沒有這些問題：它只在你自己的機器上浪費自動化程式的資源，不碰別人任何東西。

## 部署與法律

- **預設只綁 `127.0.0.1`**。要對外服務，請明確設定 `host`，並確認你**有權**在那台主機上這樣做。
- 只在**你自己擁有或獲授權**的主機上部署。把它當成一般 honeypot：它產生假資料、消耗連入的自動化程式，但不主動對外做任何事。
- 它回應的都是捏造的資料，不含任何可用來攻擊第三方或操控 AI 助理使用者的指令——請在自訂內容時維持這個原則。
- tarpit 會把連線保持一段時間（`idleTimeoutMs`）。大量並發時請用 `maxConnections` 設上限，避免耗盡自己的 socket。

## 授權

MIT
