import { describe, expect, it } from 'vitest';
import {
  createFakeFilesystem,
  formatList,
  formatListLine,
  formatNameList,
  normalizePath,
} from '../src/index';

describe('normalizePath', () => {
  it.each([
    ['/', '/'],
    ['', '/'],
    ['/a/b/c', '/a/b/c'],
    ['/a/b/../c', '/a/c'],
    ['/a/./b', '/a/b'],
    ['/a/../..', '/'],
    ['//a///b//', '/a/b'],
    ['/a/b/../../../../c', '/c'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe('createFakeFilesystem', () => {
  it('is deterministic for a given seed and path', () => {
    const a = createFakeFilesystem({ seed: 'x' });
    const b = createFakeFilesystem({ seed: 'x' });
    expect(a.list('/db_backups/secrets')).toEqual(b.list('/db_backups/secrets'));
    // Different seed → different tree.
    const c = createFakeFilesystem({ seed: 'y' });
    expect(c.list('/').entries).not.toEqual(a.list('/').entries);
  });

  it('is bottomless — every directory has sub-directories, at any depth', () => {
    const fs = createFakeFilesystem({ seed: 's', dirsPerLevel: [3, 3], filesPerLevel: [0, 0] });
    let path = '/';
    for (let i = 0; i < 50; i++) {
      const dirs = fs.list(path).entries.filter((e) => e.type === 'dir');
      expect(dirs.length).toBeGreaterThan(0);
      path = fs.resolve(path, dirs[0]!.name);
    }
    expect(fs.depth(path)).toBe(50);
  });

  it('amplifies: dirsPerLevel controls how much fills the agent context', () => {
    const big = createFakeFilesystem({
      seed: 's',
      dirsPerLevel: [2000, 2000],
      filesPerLevel: [0, 0],
    });
    expect(big.list('/').entries.length).toBe(2000);
    const body = formatList(big.list('/').entries);
    expect(body.length).toBeGreaterThan(100_000); // ~100KB of listing per round
  });

  it('resolve handles absolute, relative, . and ..', () => {
    const fs = createFakeFilesystem({ seed: 's' });
    expect(fs.resolve('/a/b', 'c')).toBe('/a/b/c');
    expect(fs.resolve('/a/b', '/x')).toBe('/x');
    expect(fs.resolve('/a/b', '..')).toBe('/a');
    expect(fs.resolve('/a/b', '../../..')).toBe('/');
  });

  it('names look tempting and unique within a directory', () => {
    const fs = createFakeFilesystem({ seed: 's', dirsPerLevel: [20, 20] });
    const dirs = fs
      .list('/')
      .entries.filter((e) => e.type === 'dir')
      .map((e) => e.name);
    expect(new Set(dirs).size).toBe(dirs.length); // all unique
    expect(dirs.join(' ')).toMatch(
      /backup|credential|key|secret|config|cert|password|token|vault/i,
    );
  });

  it('files carry a plausible size and an extension', () => {
    const fs = createFakeFilesystem({ seed: 's', filesPerLevel: [5, 5], fileSize: [100, 200] });
    const files = fs.list('/').entries.filter((e) => e.type === 'file');
    expect(files.length).toBe(5);
    for (const f of files) {
      expect(f.name).toMatch(/\.\w+$/);
      expect(f.size).toBeGreaterThanOrEqual(100);
      expect(f.size).toBeLessThanOrEqual(200);
    }
  });

  it('isFile distinguishes generated files from directories', () => {
    const fs = createFakeFilesystem({ seed: 's', filesPerLevel: [3, 3] });
    const listing = fs.list('/');
    const file = listing.entries.find((e) => e.type === 'file')!;
    const dir = listing.entries.find((e) => e.type === 'dir')!;
    expect(fs.isFile('/' + file.name)).toBe(true);
    expect(fs.isFile('/' + dir.name)).toBe(false);
    expect(fs.isFile('/')).toBe(false);
  });

  it('plants canary files when canaryRate > 0 and exposes the token', () => {
    const fs = createFakeFilesystem({
      seed: 's',
      canaryRate: 1,
      canary: 'aegis-TESTCANARY-abc123',
    });
    expect(fs.canary).toBe('aegis-TESTCANARY-abc123');
    const listing = fs.list('/some/dir');
    expect(listing.canaryFile).toBe('aegis-TESTCANARY-abc123.txt');
    expect(listing.entries.some((e) => e.name === listing.canaryFile)).toBe(true);
  });

  it('maxDepth stops generating sub-directories past the cap (files remain)', () => {
    const fs = createFakeFilesystem({ seed: 's', maxDepth: 2, filesPerLevel: [1, 1] });
    expect(fs.list('/a').entries.some((e) => e.type === 'dir')).toBe(true); // depth 1 < 2
    const deep = fs.list('/a/b/c'); // depth 3 > 2
    expect(deep.entries.some((e) => e.type === 'dir')).toBe(false);
    expect(deep.entries.some((e) => e.type === 'file')).toBe(true);
  });
});

describe('listing format', () => {
  it('renders ls -l long format', () => {
    const line = formatListLine({
      name: 'id_rsa',
      type: 'file',
      size: 512,
      mtime: Date.UTC(2024, 0, 4, 23, 37),
    });
    expect(line).toBe('-rw-r--r-- 1 root group      512 Jan  4 23:37 id_rsa');
    const dir = formatListLine({
      name: 'secrets',
      type: 'dir',
      size: 0,
      mtime: Date.UTC(2024, 1, 12, 11, 3),
    });
    expect(dir).toMatch(/^drwxr-xr-x 1 root group +0 Feb 12 11:03 secrets$/);
  });

  it('formatList and formatNameList are CRLF-terminated', () => {
    const entries = [
      { name: 'a', type: 'dir' as const, size: 0, mtime: 0 },
      { name: 'b.txt', type: 'file' as const, size: 1, mtime: 0 },
    ];
    expect(formatNameList(entries)).toBe('a\r\nb.txt\r\n');
    expect(formatList(entries).endsWith('\r\n')).toBe(true);
    expect(formatList([])).toBe('');
  });
});
