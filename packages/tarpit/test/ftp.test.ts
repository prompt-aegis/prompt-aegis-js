import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFtpTarpit, type FtpTarpit, type FtpTarpitEvent } from '../src/index';

/** Tiny FTP client over raw sockets, enough to exercise the tarpit. */
function connect(port: number) {
  const sock = net.connect(port, '127.0.0.1');
  let lines: string[] = [];
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  const reply = (re: RegExp, timeout = 4000): Promise<string> =>
    new Promise((res, rej) => {
      const check = () => {
        const idx = lines.findIndex((l) => re.test(l));
        if (idx >= 0) {
          const m = lines[idx]!;
          lines = lines.slice(idx + 1);
          clearInterval(t);
          clearTimeout(to);
          res(m);
        }
      };
      const t = setInterval(check, 5);
      const to = setTimeout(() => {
        clearInterval(t);
        rej(new Error(`timeout waiting for ${re}`));
      }, timeout);
      check();
    });
  const cmd = (s: string) => sock.write(s + '\r\n');

  return {
    sock,
    reply,
    cmd,
    async login() {
      await reply(/^220/);
      cmd('USER anonymous');
      await reply(/^331/);
      cmd('PASS a@b.c');
      await reply(/^230/);
    },
    /** Transfer the body of LIST/NLST/RETR via PASV. */
    async transfer(command: string, extended = false): Promise<string> {
      let port: number;
      if (extended) {
        cmd('EPSV');
        port = Number((await reply(/^229/)).match(/\(\|\|\|(\d+)\|\)/)![1]);
      } else {
        cmd('PASV');
        const m = (await reply(/^227/)).match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/)!;
        port = Number(m[5]) * 256 + Number(m[6]);
      }
      const data = net.connect(port, '127.0.0.1');
      let body = '';
      data.on('data', (d) => (body += d.toString('latin1')));
      const closed = new Promise<void>((r) => data.on('close', () => r()));
      cmd(command);
      await reply(/^1\d\d/);
      await closed;
      await reply(/^2\d\d/);
      return body;
    },
    close() {
      sock.destroy();
    },
  };
}

const dirNames = (listBody: string) =>
  listBody
    .trim()
    .split('\r\n')
    .filter(Boolean)
    .map((l) => ({ dir: l.startsWith('d'), name: l.split(/\s+/).slice(8).join(' ') }));

let tarpit: FtpTarpit | undefined;
async function start(options: Parameters<typeof createFtpTarpit>[0] = {}) {
  tarpit = await createFtpTarpit({ port: 0, host: '127.0.0.1', ...options }).listen();
  return tarpit;
}
afterEach(async () => {
  await tarpit?.close();
  tarpit = undefined;
});

describe('FTP tarpit', () => {
  it('accepts anonymous login and reports the current directory', async () => {
    const tp = await start({ filesystem: { seed: 's' } });
    const c = connect(tp.port);
    await c.login();
    c.cmd('PWD');
    expect(await c.reply(/^257/)).toContain('"/"');
    c.cmd('SYST');
    expect(await c.reply(/^215/)).toContain('UNIX');
    c.close();
  });

  it('serves an infinite tree: list, cd deeper, list again — forever', async () => {
    const tp = await start({
      filesystem: { seed: 's', dirsPerLevel: [4, 4], filesPerLevel: [1, 1] },
    });
    const c = connect(tp.port);
    await c.login();
    let path = '/';
    for (let i = 0; i < 12; i++) {
      const entries = dirNames(await c.transfer('LIST'));
      const dir = entries.find((e) => e.dir)!;
      expect(dir).toBeDefined();
      c.cmd('CWD ' + dir.name);
      expect(await c.reply(/^250/)).toContain(dir.name);
      path = dir.name;
    }
    c.cmd('PWD');
    const pwd = await c.reply(/^257/);
    expect(pwd).toContain(path); // 12 levels deep, still going
    c.close();
  });

  it('NLST returns bare names; EPSV works too', async () => {
    const tp = await start({
      filesystem: { seed: 's', dirsPerLevel: [3, 3], filesPerLevel: [0, 0] },
    });
    const c = connect(tp.port);
    await c.login();
    const nlst = await c.transfer('NLST', true);
    const names = nlst.trim().split('\r\n').filter(Boolean);
    expect(names.length).toBe(3);
    expect(names.every((n) => !n.includes(' '))).toBe(true); // just names, no ls -l columns
    c.close();
  });

  it('RETR returns capped junk for files and 550 for directories', async () => {
    const tp = await start({ filesystem: { seed: 's', filesPerLevel: [3, 3] }, maxFileBytes: 128 });
    const c = connect(tp.port);
    await c.login();
    const entries = dirNames(await c.transfer('LIST'));
    const file = entries.find((e) => !e.dir)!;
    const dir = entries.find((e) => e.dir)!;
    const body = await c.transfer('RETR ' + file.name);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(128); // capped — agent can't escape to inspect a huge file
    c.cmd('RETR ' + dir.name);
    expect(await c.reply(/^5\d\d/)).toMatch(/^550/);
    c.close();
  });

  it('refuses unknown commands with 502 so the agent stays on ls/cd', async () => {
    const tp = await start();
    const c = connect(tp.port);
    await c.login();
    for (const cmd of ['WGET http://x', 'EXEC ls', 'SHELL', 'FIND / -name flag']) {
      c.cmd(cmd);
      expect(await c.reply(/^5\d\d/)).toMatch(/^502/);
    }
    c.close();
  });

  it('CWD into a file fails; CDUP never climbs above root', async () => {
    const tp = await start({ filesystem: { seed: 's', filesPerLevel: [2, 2] } });
    const c = connect(tp.port);
    await c.login();
    const file = dirNames(await c.transfer('LIST')).find((e) => !e.dir)!;
    c.cmd('CWD ' + file.name);
    expect(await c.reply(/^5\d\d/)).toMatch(/^550/);
    c.cmd('CDUP');
    await c.reply(/^250/);
    c.cmd('PWD');
    expect(await c.reply(/^257/)).toContain('"/"');
    c.close();
  });

  it('requires login before any data command', async () => {
    const tp = await start();
    const c = connect(tp.port);
    await c.reply(/^220/);
    c.cmd('LIST');
    expect(await c.reply(/^5\d\d/)).toMatch(/^530/);
    c.close();
  });

  it('emits telemetry events through onEvent', async () => {
    const onEvent = vi.fn<(e: FtpTarpitEvent) => void>();
    const tp = await start({ filesystem: { seed: 's' }, onEvent });
    const c = connect(tp.port);
    await c.login();
    await c.transfer('LIST');
    c.cmd('QUIT');
    await c.reply(/^221/);
    await new Promise((r) => setTimeout(r, 50));
    const types = onEvent.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(
      expect.arrayContaining(['listening', 'connect', 'login', 'command', 'list']),
    );
    const listEvent = onEvent.mock.calls.map((c) => c[0]).find((e) => e.type === 'list')!;
    expect(listEvent.detail).toMatchObject({
      path: '/',
      entries: expect.any(Number),
      bytes: expect.any(Number),
    });
    c.close();
  });

  it('a canary planted in the filesystem surfaces in list events', async () => {
    const onEvent = vi.fn<(e: FtpTarpitEvent) => void>();
    const tp = await start({
      filesystem: { seed: 's', canaryRate: 1, canary: 'aegis-FTPCANARY-0f0f0f' },
      onEvent,
    });
    const c = connect(tp.port);
    await c.login();
    const body = await c.transfer('LIST');
    expect(body).toContain('aegis-FTPCANARY-0f0f0f.txt');
    c.close();
  });

  it('enforces maxConnections', async () => {
    const tp = await start({ maxConnections: 1 });
    const c1 = connect(tp.port);
    await c1.reply(/^220/);
    const c2 = connect(tp.port);
    expect(await c2.reply(/^421/)).toMatch(/^421/);
    c1.close();
    c2.close();
  });

  it('tracks open connection count and cleans up on close', async () => {
    const tp = await start();
    const c = connect(tp.port);
    await c.reply(/^220/);
    await vi.waitFor(() => expect(tp.connections).toBe(1));
    c.close();
    await vi.waitFor(() => expect(tp.connections).toBe(0));
  });
});
