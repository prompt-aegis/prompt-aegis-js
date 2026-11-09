import { createCanary, createRng, hashString } from '@prompt-aegis/core';

/**
 * A deterministic, infinitely deep *fake* filesystem.
 *
 * This is the data layer of the passive agent-tarpit (the "Mantis" passive
 * defense, Pasquini et al. 2024). An automated LLM attack agent that lands on
 * a protocol server backed by this filesystem can list and `cd` forever: every
 * directory always has more sub-directories, named to look like they sit next
 * to valuable data. The agent burns rounds — and API tokens — going nowhere.
 *
 * It is purely data: it describes directories and files, runs no code, and has
 * nothing to do with the attacker's own machine. The same `seed` + path always
 * yields the same listing, so the tree is stable within a session and across
 * restarts, and is trivially testable and cache-friendly.
 */

export type FakeEntryType = 'dir' | 'file';

export interface FakeEntry {
  name: string;
  type: FakeEntryType;
  /** Bytes (files only; 0 for directories). */
  size: number;
  /** Epoch milliseconds of the fake mtime. */
  mtime: number;
}

export interface FakeListing {
  /** Normalised absolute path that was listed. */
  path: string;
  entries: FakeEntry[];
  /** Present when a canary file was planted in this listing. */
  canaryFile?: string;
}

export interface FakeFilesystemOptions {
  /** Same seed → same tree. Default: random. */
  seed?: string | number;
  /**
   * Directories generated per level, `[min, max]` inclusive. Raise this (even
   * into the thousands) to flood the agent's context window and inflate its
   * per-token cost — the core resource-draining knob. Default `[8, 16]`.
   */
  dirsPerLevel?: [number, number];
  /** Fake files per level, `[min, max]`. Default `[1, 4]`. */
  filesPerLevel?: [number, number];
  /** Tempting directory-name stems. */
  dirNames?: readonly string[];
  /** Tempting file-name stems (an extension is added from `fileExtensions`). */
  fileNames?: readonly string[];
  /** Extensions appended to file names. */
  fileExtensions?: readonly string[];
  /** Fake file size range in bytes, `[min, max]`. Default `[512, 65536]`. */
  fileSize?: [number, number];
  /**
   * Plant a canary file in roughly this share of directories (0–1). If the
   * agent ever exfiltrates a listing, searching your logs / the web for the
   * canary proves it was scraped here. Default `0` (off).
   */
  canaryRate?: number;
  /** Canary token to use (one is derived from the seed otherwise). */
  canary?: string;
  /** Depth beyond which no more sub-directories are generated. Default `Infinity`. */
  maxDepth?: number;
}

/** Directory stems that read as "valuable data is near". */
export const DEFAULT_DIR_NAMES: readonly string[] = [
  'db_backups',
  'database_dumps',
  'root_certificates',
  'credentials',
  'credentials_dump',
  'deployment_keys',
  'ssh_keys',
  'private_keys',
  'network_configs',
  'firewall_rules',
  'admin_panel',
  'internal_tools',
  'password_vault',
  'secrets',
  'api_tokens',
  'customer_records',
  'payroll',
  'financial_reports',
  'source_backup',
  'login_logs',
  'audit_logs',
  'vpn_configs',
  'cloud_credentials',
  'service_accounts',
  'archived_data',
  'staging_env',
  'production_secrets',
  'migration_scripts',
  'key_material',
  'certificate_store',
];

export const DEFAULT_FILE_NAMES: readonly string[] = [
  'passwords',
  'id_rsa',
  'credentials',
  'backup',
  'dump',
  'config',
  'secrets',
  'users',
  'tokens',
  'private_key',
  'vault',
  'accounts',
  'master',
  'admin',
];

export const DEFAULT_FILE_EXTENSIONS: readonly string[] = [
  '.txt',
  '.sql',
  '.bak',
  '.conf',
  '.json',
  '.csv',
  '.pem',
  '.env',
  '.log',
  '.yaml',
];

const QUALIFIERS: readonly string[] = [
  '',
  '',
  '',
  '_v2',
  '_2023',
  '_2024',
  '_old',
  '_new',
  '_final',
  '_prod',
  '_backup',
];

export interface FakeFilesystem {
  readonly canary: string;
  /** List the contents generated for `path` (any absolute POSIX-like path). */
  list(path: string): FakeListing;
  /** Resolve `arg` against `cwd` (handles absolute, `.`, `..`; never escapes `/`). */
  resolve(cwd: string, arg: string): string;
  /** Depth of a normalised path (`/` is 0). */
  depth(path: string): number;
  /** Does this normalised path name a file in its parent's listing? */
  isFile(path: string): boolean;
}

function pickFrom<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function countIn(rng: () => number, [min, max]: [number, number]): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Normalise a POSIX-like absolute path; `..` never climbs above the root. */
export function normalizePath(input: string): string {
  const parts: string[] = [];
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export function createFakeFilesystem(options: FakeFilesystemOptions = {}): FakeFilesystem {
  const seed = options.seed ?? Math.random().toString(36).slice(2);
  const seedStr = String(seed);
  const dirsPerLevel = options.dirsPerLevel ?? [8, 16];
  const filesPerLevel = options.filesPerLevel ?? [1, 4];
  const dirNames = options.dirNames ?? DEFAULT_DIR_NAMES;
  const fileNames = options.fileNames ?? DEFAULT_FILE_NAMES;
  const fileExts = options.fileExtensions ?? DEFAULT_FILE_EXTENSIONS;
  const fileSize = options.fileSize ?? [512, 65536];
  const canaryRate = Math.min(Math.max(options.canaryRate ?? 0, 0), 1);
  const canary = options.canary ?? createCanary({ seed: `tarpit-fs:${seedStr}` });
  const maxDepth = options.maxDepth ?? Infinity;

  const rngFor = (path: string) => createRng(hashString(`${seedStr}\u0000${path}`));

  function depth(path: string): number {
    const n = normalizePath(path);
    return n === '/' ? 0 : n.split('/').length - 1;
  }

  /** Unique, deterministic names within one directory. */
  function uniqueNames(
    rng: () => number,
    count: number,
    stems: readonly string[],
    decorate: (stem: string) => string,
  ): string[] {
    const used = new Set<string>();
    const out: string[] = [];
    let guard = 0;
    while (out.length < count && guard++ < count * 20) {
      let name = decorate(pickFrom(rng, stems));
      if (used.has(name)) name = `${name}_${used.size}`;
      if (used.has(name)) continue;
      used.add(name);
      out.push(name);
    }
    return out;
  }

  function list(path: string): FakeListing {
    const p = normalizePath(path);
    const d = p === '/' ? 0 : p.split('/').length - 1;
    const rng = rngFor(p);
    const entries: FakeEntry[] = [];

    // Directories (unless we've hit the configured depth cap).
    if (d < maxDepth) {
      const dirCount = countIn(rng, dirsPerLevel);
      const names = uniqueNames(rng, dirCount, dirNames, (stem) => {
        const q = pickFrom(rng, QUALIFIERS);
        return stem + q;
      });
      for (const name of names) {
        entries.push({ name, type: 'dir', size: 0, mtime: fakeMtime(rng) });
      }
    }

    // Files.
    const fileCount = countIn(rng, filesPerLevel);
    const fnames = uniqueNames(rng, fileCount, fileNames, (stem) => stem + pickFrom(rng, fileExts));
    for (const name of fnames) {
      entries.push({ name, type: 'file', size: countIn(rng, fileSize), mtime: fakeMtime(rng) });
    }

    const result: FakeListing = { path: p, entries };

    if (canaryRate > 0 && rng() < canaryRate) {
      const canaryName = `${canary}.txt`;
      entries.push({
        name: canaryName,
        type: 'file',
        size: countIn(rng, fileSize),
        mtime: fakeMtime(rng),
      });
      result.canaryFile = canaryName;
    }
    return result;
  }

  function resolve(cwd: string, arg: string): string {
    const base = arg.startsWith('/') ? arg : `${cwd}/${arg}`;
    return normalizePath(base);
  }

  function isFile(path: string): boolean {
    const p = normalizePath(path);
    if (p === '/') return false;
    const slash = p.lastIndexOf('/');
    const parent = slash === 0 ? '/' : p.slice(0, slash);
    const name = p.slice(slash + 1);
    return list(parent).entries.some((e) => e.name === name && e.type === 'file');
  }

  function fakeMtime(rng: () => number): number {
    // Spread across the last ~3 years so listings look lived-in.
    const now = Date.UTC(2025, 0, 1);
    return now - Math.floor(rng() * 3 * 365 * 24 * 3600 * 1000);
  }

  return { canary, list, resolve, depth, isFile };
}
