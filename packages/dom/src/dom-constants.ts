/**
 * DOM spec constants, defined locally so the library works in any realm
 * (browser, iframes, jsdom on Node) without relying on `NodeFilter` / `Node`
 * globals. Values are fixed by the DOM standard.
 */
export const SHOW_ELEMENT = 0x1;
export const SHOW_TEXT = 0x4;
export const SHOW_COMMENT = 0x80;
export const FILTER_ACCEPT = 1;
export const FILTER_REJECT = 2;
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
