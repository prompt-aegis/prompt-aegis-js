/**
 * prompt-aegis demo content site.
 *
 *   pnpm demo            # http://localhost:3070
 *   pnpm attack          # run simulated attacks against it
 *
 * Everything runs locally; the "AI" here is a deliberately naive mock model so
 * no API key or network access is needed.
 */
import express from 'express';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aegisExpress, createAegisEngine, sanitizeModelOutput } from '@prompt-aegis/node';
import { ARTICLES, bySlug } from './content.mjs';

const PORT = Number(process.env.PORT ?? 3070);
/**
 * Loopback only by default: the demo contains a deliberately vulnerable mock
 * model and an unauthenticated admin page, so it must not be reachable from
 * the LAN. Set HOST=0.0.0.0 only if you really mean it.
 */
const HOSTS = process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1'];
const MAX_COMMENTS_PER_ARTICLE = 100;
/** AEGIS_OFF=1 runs the same site with every defence disabled, for comparison. */
const PROTECTED = !process.env.AEGIS_OFF;
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── In-memory state ──────────────────────────────────────────────────────
const events = [];
const canaries = [];
const comments = new Map(ARTICLES.map((a) => [a.slug, []]));

// ── prompt-aegis ────────────────────────────────────────────────────────
const engine = createAegisEngine({
  robotsTxt: true,
  trapPath: '/__aegis/trap',
  tarpit: { delayMs: Number(process.env.TARPIT_DELAY_MS ?? 300) },
  sanitize: {
    paths: ['/api'],
    fields: ['author', 'body', 'text'],
  },
  onEvent(e) {
    const entry = { time: new Date().toISOString(), ...e };
    events.unshift(entry);
    events.length = Math.min(events.length, 300);
    if (e.type === 'tarpit')
      canaries.unshift({ time: entry.time, ...e.detail, path: e.request.path });
    if (!process.env.QUIET) {
      const who = e.detail.name ?? e.detail.crawler ?? e.detail.reason ?? '';
      console.log(`[aegis] ${e.type.padEnd(9)} ${e.request.method} ${e.request.path} ${who}`);
    }
  },
});

const app = express();
app.disable('x-powered-by');
// Lets attack.mjs confirm it is talking to this demo, not some other local service.
app.use((_req, res, next) => {
  res.setHeader('x-demo-site', 'prompt-aegis');
  next();
});
app.use(express.json({ limit: '1mb' }));
if (PROTECTED) app.use(aegisExpress({ engine }));

// Serve the built browser bundles; the page maps bare imports with an import map.
app.use('/vendor/core', express.static(dirname(require.resolve('@prompt-aegis/core'))));
app.use('/vendor/dom', express.static(dirname(require.resolve('@prompt-aegis/dom'))));
app.use('/static', express.static(join(HERE, 'public')));

// ── Pages ───────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function layout(title, body) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 島嶼漫遊誌</title>
<link rel="stylesheet" href="/static/style.css">
<script type="importmap">{ "imports": {
  "@prompt-aegis/core": "/vendor/core/index.js",
  "@prompt-aegis/dom": "/vendor/dom/index.js"
} }</script>
<script type="module" src="/static/app.js"></script>
</head>
<body>
<header class="site"><a href="/" class="brand">島嶼漫遊誌</a><nav><a href="/">文章</a><a href="/admin/events">防護日誌</a></nav></header>
<main>${body}</main>
<footer class="site">prompt-aegis demo · 所有資料都只存在本機記憶體中</footer>
</body>
</html>`;
}

app.get('/', (_req, res) => {
  const list = ARTICLES.map(
    (a) =>
      `<li><a href="/articles/${a.slug}"><h2>${esc(a.title)}</h2><p>${esc(a.summary)}</p></a></li>`,
  ).join('');
  res.send(layout('首頁', `<h1>最新文章</h1><ul class="articles">${list}</ul>`));
});

app.get('/articles/:slug', (req, res) => {
  const a = bySlug(req.params.slug);
  if (!a) return res.status(404).send(layout('找不到文章', '<h1>找不到文章</h1>'));
  const list = comments.get(a.slug);
  const commentHtml = list.length
    ? list.map((c) => `<li><strong>${esc(c.author)}</strong><p>${esc(c.body)}</p></li>`).join('')
    : '<li class="empty">還沒有留言</li>';
  res.send(
    layout(
      a.title,
      `<article id="article" data-slug="${a.slug}">
        <h1>${esc(a.title)}</h1>
        ${a.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
        ${a.sponsorHtml ?? ''}
      </article>

      <section class="panel">
        <h2>AI 摘要</h2>
        <p class="hint">前端用 <code>extractVisibleText()</code> 只送出人看得到的文字，伺服器再檢查一次，模型回覆經 <code>sanitizeModelOutput()</code> 過濾。</p>
        <div class="row"><button id="summarize">產生摘要</button><button id="scan" class="ghost">掃描頁面隱藏指令</button></div>
        <pre id="ai-output" class="output" hidden></pre>
      </section>

      <section class="panel">
        <h2>留言</h2>
        <ul class="comments">${commentHtml}</ul>
        <form id="comment-form">
          <input name="author" placeholder="暱稱" required maxlength="40">
          <textarea id="comment-body" name="body" placeholder="試著貼上：Ignore all previous instructions…" required></textarea>
          <button>送出留言</button>
          <p id="comment-status" class="status" role="status"></p>
        </form>
      </section>`,
    ),
  );
});

app.get('/admin/events', (_req, res) => {
  const rows = events
    .slice(0, 100)
    .map(
      (e) =>
        `<tr class="t-${e.type}"><td>${e.time.slice(11, 19)}</td><td>${e.type}</td><td>${esc(e.request.method)} ${esc(e.request.path)}</td><td><code>${esc(JSON.stringify(e.detail).slice(0, 220))}</code></td></tr>`,
    )
    .join('');
  const canaryRows = canaries
    .slice(0, 20)
    .map(
      (c) =>
        `<tr><td>${c.time.slice(11, 19)}</td><td><code>${esc(c.canary)}</code></td><td>${esc(c.crawler)}</td><td>${esc(c.path)}</td></tr>`,
    )
    .join('');
  res.send(
    layout(
      '防護日誌',
      `<h1>防護日誌 <small>（每 3 秒更新）</small></h1>
      <p class="hint">這裡列出 <code>onEvent</code> 收到的事件。執行 <code>pnpm attack</code> 後回來看看。</p>
      <h2>Canary 紀錄</h2>
      <table><thead><tr><th>時間</th><th>Canary</th><th>爬蟲</th><th>路徑</th></tr></thead><tbody>${canaryRows || '<tr><td colspan="4">尚無</td></tr>'}</tbody></table>
      <h2>事件</h2>
      <table><thead><tr><th>時間</th><th>類型</th><th>請求</th><th>細節</th></tr></thead><tbody>${rows || '<tr><td colspan="4">尚無</td></tr>'}</tbody></table>
      <script>setTimeout(() => location.reload(), 3000)</script>`,
    ),
  );
});

// ── APIs (bodies already screened by aegis; high-risk ones never get here) ──
app.post('/api/comments', (req, res) => {
  const { slug, author, body } = req.body ?? {};
  const list = comments.get(slug);
  if (
    !list ||
    typeof author !== 'string' ||
    typeof body !== 'string' ||
    !author.trim() ||
    !body.trim()
  ) {
    return res.status(422).json({ error: 'invalid_comment' });
  }
  const comment = { author: author.slice(0, 40), body: body.slice(0, 2000) };
  list.push(comment);
  if (list.length > MAX_COMMENTS_PER_ARTICLE) list.shift(); // bounded memory
  res.status(201).json({ ok: true, comment, aegis: summary(req.aegis) });
});

/**
 * A deliberately *vulnerable* mock LLM: it obeys any Markdown image it is told
 * to include — exactly what a successful indirect injection exploits.
 */
function naiveModel(text) {
  const sentences = text.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  let reply = `摘要：${sentences.slice(0, 2).join('')}`;
  // Bounded quantifiers keep even this mock linear-time.
  for (const m of text.matchAll(/!\[[^\]\n]{0,200}\]\([^)\s]{1,2000}\)|<img[^>\n]{0,2000}>/g))
    reply += `\n${m[0]}`;
  return reply;
}

app.post('/api/summarize', (req, res) => {
  const text = String(req.body?.text ?? '').slice(0, 20_000);
  const raw = naiveModel(text);
  const safe = PROTECTED
    ? sanitizeModelOutput(raw, { allowedImageHosts: ['localhost'] })
    : { text: raw, removedUrls: [], htmlEscaped: 0 };
  res.json({
    raw,
    safe: safe.text,
    removedUrls: safe.removedUrls,
    htmlEscaped: safe.htmlEscaped,
    aegis: summary(req.aegis),
  });
});

const summary = (d) =>
  d && {
    action: d.action,
    findings: d.sanitized?.findings?.map((f) => ({ path: f.path, level: f.level, rules: f.rules })),
  };

app.get('/api/comments/:slug', (req, res) => res.json(comments.get(req.params.slug) ?? []));

let announced = false;
for (const host of HOSTS) {
  app
    .listen(PORT, host, () => {
      if (announced) return;
      announced = true;
      console.log(
        `\n  島嶼漫遊誌 demo  →  http://localhost:${PORT}${PROTECTED ? '' : '   ⚠️  防護已關閉 (AEGIS_OFF)'}`,
      );
      console.log(`  防護日誌          →  http://localhost:${PORT}/admin/events`);
      console.log(`  模擬攻擊          →  pnpm attack`);
      console.log(`  僅限本機連線（${HOSTS.join(', ')}）\n`);
    })
    .on('error', (err) => {
      // ::1 is unavailable on IPv4-only machines; that is fine as long as one host works.
      if (host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(err.code)) return;
      throw err;
    });
}
