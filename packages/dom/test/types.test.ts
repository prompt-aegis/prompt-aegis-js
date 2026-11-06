// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Consumers resolve our type definitions with whatever `moduleResolution`
 * their tsconfig uses. Subpath imports (`@prompt-aegis/dom/vue`) rely on
 * `exports`, which the legacy `node` (node10) mode ignores — `typesVersions`
 * covers that case. Runs against the built `dist` (CI builds before testing).
 */
const pkgDir = resolve(__dirname, '..');
const built = existsSync(join(pkgDir, 'dist', 'vue.d.ts'));
let consumer = '';

beforeAll(() => {
  if (!built) return;
  consumer = mkdtempSync(join(tmpdir(), 'aegis-types-'));
  mkdirSync(join(consumer, 'node_modules', '@prompt-aegis'), { recursive: true });
  symlinkSync(pkgDir, join(consumer, 'node_modules', '@prompt-aegis', 'dom'), 'dir');
  writeFileSync(join(consumer, 'index.ts'), '');
});
afterAll(() => {
  if (consumer) rmSync(consumer, { recursive: true, force: true });
});

const MODES: [string, ts.CompilerOptions][] = [
  [
    'node (node10)',
    { moduleResolution: ts.ModuleResolutionKind.Node10, module: ts.ModuleKind.CommonJS },
  ],
  ['node16', { moduleResolution: ts.ModuleResolutionKind.Node16, module: ts.ModuleKind.Node16 }],
  [
    'nodenext',
    { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext },
  ],
  ['bundler', { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext }],
];
const IMPORTS: [string, RegExp][] = [
  ['@prompt-aegis/dom', /dist\/index\.d\.c?ts$/],
  ['@prompt-aegis/dom/vue', /dist\/vue\.d\.c?ts$/],
  ['@prompt-aegis/dom/react', /dist\/react\.d\.c?ts$/],
];

describe.skipIf(!built)('type definitions resolve under every moduleResolution', () => {
  for (const [mode, options] of MODES) {
    it.each(IMPORTS)(`[${mode}] %s`, (specifier, expected) => {
      const { resolvedModule } = ts.resolveModuleName(
        specifier,
        join(consumer, 'index.ts'),
        options,
        ts.sys,
      );
      expect(resolvedModule?.resolvedFileName.replace(/\\/g, '/')).toMatch(expected);
    });
  }
});
