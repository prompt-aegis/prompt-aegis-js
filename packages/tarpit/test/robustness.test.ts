import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFtpTarpit, type FtpTarpit } from '../src/index';

/**
 * Regression tests for data-connection and command-ordering races that a real
 * FTP client (or an LLM agent driving one) can trigger but a naive test client
 * does not.
 */

let tp: FtpTarpit | undefined;
afterEach(async () => {
  await tp?.close();
  tp = undefined;
});

function raw(port: number) {
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
        rej(new Error(`timeout for ${re}; saw ${JSON.stringify(lines)}`));
      }, timeout);
      check();
    });
  return { sock, reply, write: (s: string) => sock.write(s) };
}

async function login(c: ReturnType<typeof raw>) {
  await c.reply(/^220/);
  c.write('USER anonymous\r\n');
  await c.reply(/^331/);
  c.write('PASS a@b.c\r\n');
  await c.reply(/^230/);
}

describe('data-connection timing', () => {
  it('works when the client establishes the data socket BEFORE sending LIST', async () => {
    tp = await createFtpTarpit({
      port: 0,
      filesystem: { seed: 's', dirsPerLevel: [3, 3] },
    }).listen();
    const c = raw(tp.port);
    await login(c);
    c.write('PASV\r\n');
    const m = (await c.reply(/^227/)).match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/)!;
    const dataPort = Number(m[5]) * 256 + Number(m[6]);

    // Connect the data socket and WAIT for it to be established first.
    const data = net.connect(dataPort, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      data.once('connect', () => resolve());
      data.once('error', reject);
    });
    let body = '';
    data.on('data', (d) => (body += d.toString('latin1')));
    const closed = new Promise<void>((r) => data.on('close', () => r()));

    c.write('LIST\r\n');
    expect(await c.reply(/^150/)).toMatch(/^150/);
    await closed;
    expect(await c.reply(/^226/)).toMatch(/^226/);
    expect(body.trim().split('\r\n').filter(Boolean).length).toBeGreaterThan(0);
    c.sock.destroy();
  });
});

describe('command pipelining', () => {
  it('handles PASV and LIST arriving in a single packet, in order', async () => {
    tp = await createFtpTarpit({
      port: 0,
      filesystem: { seed: 's', dirsPerLevel: [3, 3] },
    }).listen();
    const c = raw(tp.port);
    await login(c);

    // Send both commands at once — the server must not start LIST before PASV is ready.
    c.write('PASV\r\nLIST\r\n');
    const m = (await c.reply(/^227/)).match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/)!;
    const dataPort = Number(m[5]) * 256 + Number(m[6]);
    const data = net.connect(dataPort, '127.0.0.1');
    let body = '';
    data.on('data', (d) => (body += d.toString('latin1')));
    const closed = new Promise<void>((r) => data.on('close', () => r()));
    expect(await c.reply(/^150/)).toMatch(/^150/);
    await closed;
    expect(await c.reply(/^226/)).toMatch(/^226/);
    expect(body.length).toBeGreaterThan(0);
    c.sock.destroy();
  });
});

describe('resource cleanup', () => {
  it('does not leak unclaimed PASV data sockets when a session ends', async () => {
    tp = await createFtpTarpit({ port: 0, filesystem: { seed: 's' } }).listen();
    const c = raw(tp.port);
    await login(c);
    c.write('PASV\r\n');
    const m = (await c.reply(/^227/)).match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/)!;
    const dataPort = Number(m[5]) * 256 + Number(m[6]);
    // Open the data connection but never send a transfer command, then quit.
    const data = net.connect(dataPort, '127.0.0.1');
    await new Promise<void>((resolve) => data.once('connect', () => resolve()));
    const dataClosed = new Promise<void>((r) => data.on('close', () => r()));
    c.write('QUIT\r\n');
    await c.reply(/^221/);
    c.sock.destroy();
    // The orphaned data socket must be closed by the server, not left hanging.
    await Promise.race([
      dataClosed,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('data socket leaked')), 3000)),
    ]);
  });
});
