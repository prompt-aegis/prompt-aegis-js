#!/usr/bin/env node
/**
 * Threshold sweep: how many attacks would be blocked, and how many benign
 * messages falsely flagged, at each blockThreshold — on YOUR corpus.
 *
 *   pnpm build
 *   node scripts/sweep-threshold.mjs --attacks attacks.json --benign benign.json
 *
 * Each file is a JSON array (or JSON Lines) of strings, or of objects with a
 * `text` / `body` / `content` / `prompt` field. Rule scores do not depend on
 * the threshold, so detection runs once per message.
 */
import { readFileSync } from 'node:fs';
import { detectInjection } from '../packages/core/dist/index.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const attacksPath = arg('attacks');
const benignPath = arg('benign');
if (!attacksPath || !benignPath) {
  console.error('usage: sweep-threshold.mjs --attacks <file> --benign <file> [--decode false]');
  process.exit(2);
}
const decode = arg('decode') !== 'false';

function load(path) {
  const raw = readFileSync(path, 'utf8').trim();
  const items = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
  return items
    .map((x) => (typeof x === 'string' ? x : (x.text ?? x.body ?? x.content ?? x.prompt)))
    .filter((t) => typeof t === 'string');
}

const score = (texts) => texts.map((t) => detectInjection(t, { decode }).score);
const attacks = score(load(attacksPath));
const benign = score(load(benignPath));
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1).padStart(5) + '%' : '   n/a');

console.log(`attacks: ${attacks.length}   benign: ${benign.length}\n`);
console.log('threshold   attacks blocked   benign flagged (FP)');
for (const t of [0.3, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
  const blocked = attacks.filter((s) => s >= t).length;
  const fp = benign.filter((s) => s >= t).length;
  const mark = t === 0.85 ? '  ← default' : '';
  console.log(
    `  ${t.toFixed(2)}      ${pct(blocked, attacks.length)} (${String(blocked).padStart(4)})    ${pct(fp, benign.length)} (${String(fp).padStart(4)})${mark}`,
  );
}

const detectedButPassed = attacks.filter((s) => s > 0 && s < 0.85).length;
console.log(`\nDetected but below 0.85: ${detectedButPassed} attack(s).`);
console.log(
  'Pick the lowest threshold whose FP column is still acceptable, then set sanitize.blockThreshold.',
);
