export * from './unicode';
export * from './rules';
export * from './detect';
export * from './sanitize';
export * from './spotlight';
export * from './bots';
export * from './tarpit';
export * from './output';
export { createRng, hashString, randomHex } from './random';

import { classifyUserAgent, type ClassifyOptions } from './bots';
import { detectInjection } from './detect';
import { sanitizeModelOutput, type SanitizeOutputOptions } from './output';
import { sanitizePrompt, type SanitizeOptions } from './sanitize';
import { spotlight, type SpotlightOptions } from './spotlight';
import { buildTarpitPayload, type TarpitOptions } from './tarpit';

export interface AegisConfig {
  sanitize?: SanitizeOptions;
  output?: SanitizeOutputOptions;
  spotlight?: SpotlightOptions;
  bots?: ClassifyOptions;
  tarpit?: TarpitOptions;
}

/** Convenience factory that binds a shared configuration to every helper. */
export function createAegis(config: AegisConfig = {}) {
  return {
    config,
    detect: (text: string) => detectInjection(text, config.sanitize),
    sanitize: (text: string, overrides?: SanitizeOptions) =>
      sanitizePrompt(text, { ...config.sanitize, ...overrides }),
    sanitizeOutput: (text: string, overrides?: SanitizeOutputOptions) =>
      sanitizeModelOutput(text, { ...config.output, ...overrides }),
    spotlight: (text: string, overrides?: SpotlightOptions) =>
      spotlight(text, { ...config.spotlight, ...overrides }),
    classifyUserAgent: (ua: string | null | undefined) => classifyUserAgent(ua, config.bots),
    tarpit: (overrides?: TarpitOptions) => buildTarpitPayload({ ...config.tarpit, ...overrides }),
  };
}

export type Aegis = ReturnType<typeof createAegis>;
