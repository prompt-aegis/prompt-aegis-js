import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from 'basic-ftp';
import { createFtpTarpit, type FtpTarpit } from '../src/index';

/**
 * Drives the tarpit with `basic-ftp`, a real, widely-used FTP client library
 * (not our hand-rolled test client). This proves the tarpit speaks correct
 * enough FTP for actual clients — the kind an LLM attack agent would use — and
 * that a real client which waits for the data connection before sending a
 * transfer command is served correctly (the data-connection race fix).
 */

let tp: FtpTarpit | undefined;
afterEach(async () => {
  await tp?.close();
  tp = undefined;
});

async function newClient(port: number): Promise<Client> {
  const client = new Client(8000);
  // client.ftp.verbose = true; // uncomment to see the raw protocol
  await client.access({
    host: '127.0.0.1',
    port,
    user: 'anonymous',
    password: 'trap@test.com',
    secure: false,
  });
  return client;
}

describe('interop with the basic-ftp client library', () => {
  it('logs in anonymously and parses the root listing', async () => {
    tp = await createFtpTarpit({
      port: 0,
      filesystem: { seed: 's', dirsPerLevel: [6, 6], filesPerLevel: [3, 3] },
    }).listen();
    const client = await newClient(tp.port);
    try {
      const list = await client.list();
      const dirs = list.filter((f) => f.isDirectory);
      const files = list.filter((f) => f.isFile);
      expect(dirs.length).toBe(6); // our ls -l format parses correctly
      expect(files.length).toBe(3);
      expect(dirs.map((d) => d.name).join(' ')).toMatch(/backup|credential|key|secret|cert|vault/i);
      expect(files.every((f) => f.size > 0)).toBe(true);
    } finally {
      client.close();
    }
  });

  it('a real client descends five levels and never hits the bottom', async () => {
    tp = await createFtpTarpit({
      port: 0,
      filesystem: { seed: 's', dirsPerLevel: [5, 5], filesPerLevel: [1, 1] },
    }).listen();
    const client = await newClient(tp.port);
    try {
      const path: string[] = [];
      for (let i = 0; i < 5; i++) {
        const list = await client.list();
        const dir = list.find((f) => f.isDirectory);
        expect(dir, `level ${i} had no sub-directory`).toBeDefined();
        await client.cd(dir!.name);
        path.push(dir!.name);
      }
      expect(await client.pwd()).toBe('/' + path.join('/')); // five levels deep
      const deep = await client.list();
      expect(deep.filter((f) => f.isDirectory).length).toBeGreaterThan(0); // still bottomless
    } finally {
      client.close();
    }
  });

  it('downloads a fake file, capped at maxFileBytes', async () => {
    tp = await createFtpTarpit({
      port: 0,
      filesystem: { seed: 's', filesPerLevel: [3, 3] },
      maxFileBytes: 256,
    }).listen();
    const client = await newClient(tp.port);
    try {
      const file = (await client.list()).find((f) => f.isFile)!;
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      await client.downloadTo(sink, file.name);
      const body = Buffer.concat(chunks);
      expect(body.length).toBeGreaterThan(0);
      expect(body.length).toBeLessThanOrEqual(256);
    } finally {
      client.close();
    }
  });

  it('the canary file is visible to a real client', async () => {
    tp = await createFtpTarpit({
      port: 0,
      filesystem: { seed: 's', canaryRate: 1, canary: 'aegis-InteropCanary-99aa88' },
    }).listen();
    const client = await newClient(tp.port);
    try {
      const names = (await client.list()).map((f) => f.name);
      expect(names).toContain('aegis-InteropCanary-99aa88.txt');
    } finally {
      client.close();
    }
  });
});
