import {
  detectAutomation,
  extractVisibleText,
  guardInput,
  injectHoneypot,
  scanForHiddenInjections,
} from '@prompt-aegis/dom';

// 1. Invisible tarpit + trap links on every page (skipped for search engines).
const honeypot = injectHoneypot({ seed: location.pathname, trapPath: '/__aegis/trap' });
console.info('[aegis] honeypot canary for this page:', honeypot.canary);

const automation = detectAutomation();
if (automation.automated) console.warn('[aegis] automation detected:', automation.signals);

const $ = (sel) => document.querySelector(sel);
const article = $('#article');

// 2. Guard the comment box: strip invisible characters, block risky pastes.
const body = $('#comment-body');
const status = $('#comment-status');
if (body) {
  guardInput(body, {
    blockPasteAt: 0.85,
    onDetect: ({ result }) =>
      show(status, `⚠️ 偵測到可疑內容（${result.level}）：${rules(result)}`, 'warn'),
    onBlock: ({ result }) =>
      show(status, `⛔ 已阻擋貼上（${result.level}）：${rules(result)}`, 'error'),
  });
}

// 3. Submit comments; the server screens them again.
$('#comment-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  const res = await fetch('/api/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      slug: article.dataset.slug,
      author: form.get('author'),
      body: form.get('body'),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    show(status, '✅ 留言成功', 'ok');
    setTimeout(() => location.reload(), 600);
  } else {
    show(
      status,
      `⛔ 伺服器拒絕（HTTP ${res.status}）：${data.error ?? ''} ${data.fields?.join(', ') ?? ''}`,
      'error',
    );
  }
});

// 4. Scan the article for text hidden from humans but visible to AI.
$('#scan')?.addEventListener('click', () => {
  const findings = scanForHiddenInjections(article);
  output(
    findings.length
      ? findings
          .map(
            (f) => `⚠️ [${f.reasons.join(', ')}] ${f.detection.level}\n   ${f.text.slice(0, 160)}`,
          )
          .join('\n\n')
      : '✅ 沒有發現隱藏指令',
  );
});

// 5. AI summary: send only what a human can see.
$('#summarize')?.addEventListener('click', async () => {
  const res = await fetch('/api/summarize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: extractVisibleText(article) }),
  });
  const data = await res.json();
  if (!res.ok) return output(`⛔ 伺服器拒絕（HTTP ${res.status}）：${JSON.stringify(data)}`);
  output(
    `${data.safe}\n\n— 已移除 ${data.removedUrls.length} 個外部圖片${data.removedUrls.length ? '：' + data.removedUrls.join(', ') : ''}`,
  );
});

function rules(result) {
  return [...new Set(result.detection.matches.map((m) => m.ruleId))].join(', ');
}
function show(el, text, kind) {
  el.textContent = text;
  el.dataset.kind = kind;
}
function output(text) {
  const pre = $('#ai-output');
  pre.hidden = false;
  pre.textContent = text;
}
