export interface AutomationSignals {
  automated: boolean;
  signals: string[];
}

/**
 * Best-effort client-side detection of browser automation (Selenium,
 * Puppeteer, Playwright, PhantomJS, headless Chrome). LLM browser agents
 * usually run on these. Cheap to evade — use as one signal among many, never
 * as the sole reason to deny a real user.
 */
export function detectAutomation(win: Window = window): AutomationSignals {
  const signals: string[] = [];
  const nav = win.navigator as Navigator & { webdriver?: boolean };
  const w = win as unknown as Record<string, unknown>;
  if (nav.webdriver) signals.push('navigator.webdriver');
  if (/HeadlessChrome/i.test(nav.userAgent)) signals.push('headless-user-agent');
  for (const key of [
    '__playwright__binding__',
    '__pwInitScripts',
    '_phantom',
    'callPhantom',
    '__nightmare',
    'domAutomation',
    'domAutomationController',
    '__selenium_unwrapped',
    '__webdriver_evaluate',
    '__driver_evaluate',
  ]) {
    if (key in w) signals.push(`global:${key}`);
  }
  try {
    for (const key of Object.keys(win.document)) {
      if (/^\$?cdc_|^\$wdc_/.test(key)) signals.push('chromedriver-marker');
    }
  } catch {
    /* ignore */
  }
  if (nav.languages !== undefined && nav.languages.length === 0) signals.push('empty-languages');
  return { automated: signals.length > 0, signals: [...new Set(signals)] };
}
