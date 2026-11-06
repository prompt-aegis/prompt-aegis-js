/**
 * Built-in heuristic rules for prompt-injection / jailbreak detection.
 *
 * Rules run against text that has had invisible characters stripped, been
 * NFKC-normalised and had whitespace collapsed, so `ｉｇｎｏｒｅ`, `ig\u200Bnore`
 * and `ignore\n\nall` are all caught. Heuristics are a first line of defence,
 * not a guarantee — pair them with spotlighting and least-privilege tool design.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type RuleCategory =
  | 'instruction-override'
  | 'role-hijack'
  | 'jailbreak'
  | 'prompt-leak'
  | 'special-token'
  | 'delimiter-injection'
  | 'exfiltration'
  | 'obfuscation'
  | 'tool-abuse';

export interface InjectionRule {
  id: string;
  category: RuleCategory;
  severity: Severity;
  description: string;
  /** Must not use the `g` or `y` flag; the engine adds `g` itself. */
  pattern: RegExp;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  low: 0.3,
  medium: 0.6,
  high: 0.85,
  critical: 0.95,
};

const OVERRIDE_VERBS =
  '(?:ignore|disregard|forget|skip|bypass|override|neglect|discard|drop|abandon)';
const PRIOR =
  '(?:previous|prior|above|earlier|preceding|foregoing|initial|original|system|existing|old|all)';
const INSTR =
  '(?:instructions?|prompts?|rules?|directions?|directives?|guidelines?|context|messages?|commands?|constraints?|restrictions?|programming|guardrails?)';

const ZH_OVERRIDE =
  '(?:忽略|忽視|忽视|無視|无视|忘記|忘记|忘掉|跳過|跳过|不要理會|不要理会|不理會|不理会|覆蓋|覆盖|拋棄|抛弃|放棄|放弃)';
const ZH_PRIOR =
  '(?:之前|以前|先前|上面|上述|前面|原本|原來|原来|原有|所有|全部|系統|系统|預設|预设)';
const ZH_INSTR = '(?:指令|指示|提示|規則|规则|設定|设定|命令|要求|限制|約束|约束|守則|守则)';

export const DEFAULT_RULES: InjectionRule[] = [
  // ── Instruction override ────────────────────────────────────────────────
  {
    id: 'override.ignore-previous',
    category: 'instruction-override',
    severity: 'high',
    description: 'Asks the model to ignore / forget earlier instructions.',
    pattern: new RegExp(
      `\\b${OVERRIDE_VERBS}\\b[^.\\n]{0,40}?\\b${PRIOR}\\b[^.\\n]{0,30}?\\b${INSTR}`,
      'i',
    ),
  },
  {
    id: 'override.new-instructions',
    category: 'instruction-override',
    severity: 'medium',
    description: 'Declares replacement "new / real" instructions.',
    pattern:
      /\b(?:new|updated|real|actual|true|revised|override)\s+(?:system\s+)?(?:instructions?|rules|prompt|directives?)\s*(?::|are\b|is\b|follow)/i,
  },
  {
    id: 'override.from-now-on',
    category: 'instruction-override',
    severity: 'low',
    description: '"From now on you will…" style behavioural reset.',
    pattern: /\bfrom now on,?\s+(?:you|your|act|respond|always|only)\b/i,
  },
  {
    id: 'override.zh-ignore-previous',
    category: 'instruction-override',
    severity: 'high',
    description: '中文：要求忽略先前／系統指令。',
    pattern: new RegExp(`${ZH_OVERRIDE}[^。\\n]{0,15}?${ZH_PRIOR}[^。\\n]{0,15}?${ZH_INSTR}`),
  },
  // ── Role hijack / jailbreak ─────────────────────────────────────────────
  {
    id: 'role.you-are-now',
    category: 'role-hijack',
    severity: 'medium',
    description: 'Attempts to reassign the model identity ("you are now…").',
    pattern:
      /\byou\s+are\s+(?:now|no\s+longer)\b|\bpretend\s+(?:to\s+be|you\s+are)\b|\byour\s+new\s+(?:role|persona|identity)\b/i,
  },
  {
    id: 'role.unrestricted-persona',
    category: 'jailbreak',
    severity: 'high',
    description: 'Requests an unrestricted / unfiltered persona.',
    pattern:
      /\b(?:act|behave|respond|answer|roleplay|role-play)\s+(?:as|like)\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|amoral|unaligned|unbound)/i,
  },
  {
    id: 'jailbreak.known-modes',
    category: 'jailbreak',
    severity: 'high',
    description: 'Known jailbreak personas / modes (DAN, developer mode, …).',
    pattern:
      /\bdo\s+anything\s+now\b|\b(?:developer|god|jailbreak|unrestricted|sudo)\s+mode\b|\bjailbr(?:ea|o)k(?:en|ed|ing)?\b|\bDAN\s+(?:mode|prompt|\d)/i,
  },
  {
    id: 'jailbreak.no-restrictions',
    category: 'jailbreak',
    severity: 'medium',
    description: 'Asks to disable safety filters or restrictions.',
    pattern:
      /\b(?:without|no|ignore|ignoring|bypass|bypassing|remove|disable|turn\s+off|free\s+from)\s+(?:any\s+|all\s+|your\s+)?(?:ethical\s+|safety\s+|content\s+)?(?:restrictions?|filters?|filtering|limitations?|guardrails?|safety|censorship|content\s+polic(?:y|ies)|moderation|alignment)\b/i,
  },
  {
    id: 'jailbreak.zh-persona',
    category: 'jailbreak',
    severity: 'high',
    description: '中文：越獄、開發者模式或「不受限制」角色。',
    pattern:
      /(?:你現在是|你现在是|從現在開始|从现在开始|扮演|假裝|假装)[^。\n]{0,20}(?:沒有限制|没有限制|不受限制|無限制|无限制|越獄|越狱|開發者模式|开发者模式|沒有道德|没有道德)|越獄模式|越狱模式|開發者模式|开发者模式/,
  },
  {
    id: 'jailbreak.zh-no-restrictions',
    category: 'jailbreak',
    severity: 'medium',
    description: '中文：要求解除限制或安全過濾。',
    pattern:
      /(?:解除|繞過|绕过|移除|關閉|关闭|無視|无视|取消)[^。\n]{0,10}(?:限制|過濾|过滤|審查|审查|安全|規範|规范|護欄|护栏)/,
  },
  // ── Prompt leak ─────────────────────────────────────────────────────────
  {
    id: 'leak.system-prompt',
    category: 'prompt-leak',
    severity: 'high',
    description: 'Tries to extract the system / hidden prompt.',
    pattern:
      /\b(?:reveal|show|print|repeat|output|display|tell\s+me|give\s+me|leak|dump|disclose|share|what\s+(?:is|are|was|were))\b[^.\n]{0,30}?\b(?:your|the)\s+(?:full\s+|entire\s+|complete\s+)?(?:system|initial|original|hidden|secret|developer|internal)\s+(?:prompt|instructions?|message|rules|configuration)/i,
  },
  {
    id: 'leak.repeat-above',
    category: 'prompt-leak',
    severity: 'medium',
    description: '"Repeat the words above" style extraction.',
    pattern:
      /\brepeat\s+(?:all\s+|the\s+)?(?:words|text|everything|content)\s+(?:above|before)\b|\b(?:everything|all\s+text)\s+above\s+(?:this|verbatim)\b/i,
  },
  {
    id: 'leak.zh-system-prompt',
    category: 'prompt-leak',
    severity: 'high',
    description: '中文：要求顯示系統提示詞。',
    pattern:
      /(?:顯示|显示|告訴我|告诉我|輸出|输出|洩漏|泄露|泄漏|列出|重複|重复|印出|打印|給我|给我)[^。\n]{0,15}(?:系統|系统|原始|初始|隱藏|隐藏|內部|内部)(?:提示詞|提示词|提示|指令|設定|设定|prompt)/i,
  },
  // ── Special tokens / delimiter spoofing ─────────────────────────────────
  {
    id: 'token.chat-template',
    category: 'special-token',
    severity: 'critical',
    description: 'Raw chat-template control tokens (ChatML, Llama, Gemma …).',
    pattern:
      /<\|(?:im_start|im_end|im_sep|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id|begin_of_text|end_of_text|eom_id|python_tag)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?start_of_turn>|<end_of_turn>/i,
  },
  {
    id: 'delimiter.fake-role-tag',
    category: 'delimiter-injection',
    severity: 'high',
    description: 'XML-ish role tags such as </system> or <assistant>.',
    pattern: /<\/?\s*(?:system|assistant|developer|instructions?|system_prompt)\s*>/i,
  },
  {
    id: 'delimiter.fake-turn',
    category: 'delimiter-injection',
    severity: 'medium',
    description: 'Line that impersonates a conversation turn ("System:", "### Assistant").',
    pattern:
      /(?:^|\n|\s{2,})\s*(?:#{1,6}\s*|\*\*)?(?:system|assistant|developer)\s*(?:\*\*)?\s*:\s*\S/i,
  },
  // ── Exfiltration / tool abuse ──────────────────────────────────────────
  {
    id: 'exfil.markdown-image-query',
    category: 'exfiltration',
    severity: 'medium',
    description: 'Markdown image whose URL carries query data (classic exfil channel).',
    pattern: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\?[^)\s]*=[^)\s]*\)/i,
  },
  {
    id: 'exfil.send-data',
    category: 'exfiltration',
    severity: 'high',
    description: 'Instruction to send conversation / data to an external party.',
    pattern:
      /\b(?:send|post|upload|forward|transmit|exfiltrate|leak|email)\s+(?:(?:this|the|all|any|your|my|these|of|our|user'?s?)\s+){0,3}(?:[a-z]+\s+)?(?:data|conversation|chat|history|information|credentials?|secrets?|api\s+keys?|tokens?|passwords?|cookies?)\b[^.\n]{0,30}\b(?:to|into)\b/i,
  },
  {
    id: 'tool.dangerous-command',
    category: 'tool-abuse',
    severity: 'medium',
    description: 'Destructive shell / code-execution snippets aimed at tool-using agents.',
    pattern:
      /\brm\s+-rf\s+[/~]|\bcurl\s+[^|\n]{1,200}\|\s*(?:ba|z)?sh\b|\beval\s*\(\s*atob\s*\(|\bos\.system\s*\(|\bsubprocess\.(?:run|Popen|call)\s*\(/i,
  },
  // ── Obfuscation ─────────────────────────────────────────────────────────
  {
    id: 'obfuscation.base64-blob',
    category: 'obfuscation',
    severity: 'low',
    description: 'Long base64 blob that may hide encoded instructions.',
    pattern: /(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{120,}={0,2}(?![A-Za-z0-9+/])/,
  },
  {
    id: 'obfuscation.decode-and-follow',
    category: 'obfuscation',
    severity: 'medium',
    description: 'Asks the model to decode something and then obey it.',
    pattern:
      /\b(?:decode|decrypt|deobfuscate|translate|rot13|reverse)\b[^.\n]{0,40}\b(?:then|and)\s+(?:follow|execute|obey|do|run|perform)\b/i,
  },
];
