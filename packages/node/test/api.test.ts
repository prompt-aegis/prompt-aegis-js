import { describe, expect, it } from 'vitest';
import * as core from '../../core/src/index';
import * as dom from '../../dom/src/index';
import * as domReact from '../../dom/src/react';
import * as domVue from '../../dom/src/vue';
import * as node from '../src/index';

/**
 * Public API snapshot. Anything exported is a promise to users — removing it
 * later is a breaking change. If this test fails, either the export was
 * accidental (remove it) or intentional (add it here AND document it in the
 * package README).
 */
const API = {
  core: [
    'AI_BOT_SIGNATURES',
    'AUTOMATION_SIGNATURES',
    'DEFAULT_AGENT_NOTICE',
    'DEFAULT_MAX_SCAN_LENGTH',
    'DEFAULT_RULES',
    'SEARCH_ENGINE_PATTERN',
    'SEVERITY_WEIGHT',
    'buildRobotsTxt',
    'buildTarpitPayload',
    'classifyCodePoint',
    'classifyUserAgent',
    'combineScores',
    'createAegis',
    'createCanary',
    'createRng',
    'decodeTagCharacters',
    'detectInjection',
    'escapeHtml',
    'findCanaries',
    'foldConfusables',
    'hasInvisible',
    'hashString',
    'hostAllowed',
    'isSearchEngine',
    'neutralizeSpecialTokens',
    'normalizeForMatching',
    'prepareForMatching',
    'randomHex',
    'renderTarpitHtml',
    'resolveRules',
    'sanitizeModelOutput',
    'sanitizePrompt',
    'scoreToLevel',
    'spotlight',
    'stripInvisible',
  ],
  dom: [
    'HIDDEN_STYLE',
    'HONEYPOT_ATTR',
    'addHoneypotField',
    'buildHoneypotSpec',
    'detectAutomation',
    'extractVisibleText',
    'guardForm',
    'guardInput',
    'hiddenReasons',
    'injectHoneypot',
    'liveGuardOptions',
    'scanForHiddenInjections',
  ],
  'dom/react': ['AegisHoneypot', 'useAegisGuard', 'useAutomationDetection', 'useSafeModelOutput'],
  'dom/vue': ['AegisHoneypot', 'PromptAegis', 'vAegisGuard'],
  node: [
    'MemoryFlagStore',
    'aegisExpress',
    'aegisFastify',
    'aegisFetch',
    'aegisHono',
    'aegisKoa',
    'buildRobotsTxt',
    'classifyUserAgent',
    'createAegisEngine',
    'createCanary',
    'defaultFlagKey',
    'detectInjection',
    'findCanaries',
    'isTrapHitFlaggable',
    'resolveClientIp',
    'sanitizeModelOutput',
    'sanitizePrompt',
    'spotlight',
  ],
};

describe('public API', () => {
  it.each([
    ['core', core],
    ['dom', dom],
    ['dom/react', domReact],
    ['dom/vue', domVue],
    ['node', node],
  ] as const)('%s exports exactly the documented API', (name, mod) => {
    expect(Object.keys(mod).sort()).toEqual([...API[name]].sort());
  });
});
