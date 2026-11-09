import net from 'node:net';
import {
  createFakeFilesystem,
  type FakeFilesystem,
  type FakeFilesystemOptions,
} from './filesystem';
import { formatList, formatNameList } from './format';

/**
 * A minimal, zero-dependency FTP server that is nothing but a tarpit.
 *
 * It speaks just enough of the protocol to keep an FTP client — or, crucially,
 * an LLM attack agent driving one — logged in and navigating an infinite fake
 * filesystem. Every directory is bottomless and full of tempting names, so the
 * agent lists and `cd`s forever, draining its rounds and API budget. Unknown
 * commands are refused so the agent falls back to plain `ls`/`cd` and cannot
 * escape with richer tooling.
 *
 * It is **passive and local**: it serves fabricated data from your own machine
 * and never sends anything to, or runs anything on, whoever connects. It is a
 * honeypot, not a counterattack.
 *
 * Deploy it only on a host you control, bound (by default) to loopback. See the
 * package README for the legal and exposure notes.
 */

export type FtpTarpitEventType =
  'listening' | 'connect' | 'login' | 'command' | 'list' | 'retrieve' | 'disconnect' | 'error';

export interface FtpTarpitEvent {
  type: FtpTarpitEventType;
  sessionId?: number;
  remoteAddress?: string;
  detail?: Record<string, unknown>;
}

export interface FtpTarpitOptions {
  /** An existing fake filesystem, or options to build one. */
  filesystem?: FakeFilesystem | FakeFilesystemOptions;
  /** Bind address. Default `127.0.0.1` (loopback — change only deliberately). */
  host?: string;
  /** Control port. Default `2121` (port 21 needs elevated privileges). */
  port?: number;
  /** IPv4 advertised in PASV replies. Default: the control socket's local address, else `127.0.0.1`. */
  pasvHost?: string;
  /** Greeting banner (220). A vulnerable-looking banner lures agents in. */
  banner?: string;
  /** Build the body returned by RETR. Default: short deterministic junk. */
  fileContent?: (path: string, size: number) => string | Buffer;
  /** Hard cap on RETR bytes actually sent (small, so the agent cannot escape to inspect a big file). Default 4096. */
  maxFileBytes?: number;
  /** Drop a connection idle this long. Default 300000 (5 min). */
  idleTimeoutMs?: number;
  /** Max simultaneous connections. Default 512. */
  maxConnections?: number;
  onEvent?: (e: FtpTarpitEvent) => void;
}

export interface FtpTarpit {
  readonly filesystem: FakeFilesystem;
  /** Actual bound port (valid after `listen()`). */
  readonly port: number;
  readonly host: string;
  /** Current open control connections. */
  readonly connections: number;
  listen(): Promise<FtpTarpit>;
  close(): Promise<void>;
}

const isIpv4 = (a: string | undefined): a is string => !!a && /^\d{1,3}(\.\d{1,3}){3}$/.test(a);

export function createFtpTarpit(options: FtpTarpitOptions = {}): FtpTarpit {
  const fs: FakeFilesystem =
    options.filesystem && 'list' in options.filesystem
      ? options.filesystem
      : createFakeFilesystem(options.filesystem as FakeFilesystemOptions | undefined);

  const host = options.host ?? '127.0.0.1';
  const wantPort = options.port ?? 2121;
  const banner = options.banner ?? '220 (vsFTPd 3.0.3)';
  const maxFileBytes = options.maxFileBytes ?? 4096;
  const idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
  const maxConnections = options.maxConnections ?? 512;
  const fileContent = options.fileContent ?? ((_p, size) => deterministicJunk(size));
  const emit = (e: FtpTarpitEvent) => options.onEvent?.(e);

  let nextSessionId = 1;
  let open = 0;
  const server = net.createServer();

  server.on('connection', (socket) => {
    if (open >= maxConnections) {
      socket.end('421 Too many connections.\r\n');
      return;
    }
    open++;
    new FtpSession(nextSessionId++, socket).run();
  });

  class FtpSession {
    cwd = '/';
    private buffer = '';
    private authed = false;
    private pasv: {
      server: net.Server;
      port: number;
      /** Transfer commands waiting for a data socket. */
      waiters: ((s: net.Socket | null) => void)[];
      /** Data sockets that connected before their transfer command arrived. */
      ready: net.Socket[];
    } | null = null;
    private closed = false;
    /** Serialises command handling so e.g. LIST never runs before its PASV finishes. */
    private queue: Promise<void> = Promise.resolve();

    constructor(
      readonly id: number,
      readonly socket: net.Socket,
    ) {}

    run(): void {
      const remoteAddress = this.socket.remoteAddress ?? undefined;
      emit({ type: 'connect', sessionId: this.id, remoteAddress });
      this.socket.setTimeout(idleTimeoutMs);
      this.socket.on('timeout', () => this.socket.destroy());
      this.socket.on('data', (chunk) => this.onData(chunk, remoteAddress));
      this.socket.on('error', () => {});
      this.socket.on('close', () => {
        if (this.closed) return;
        this.closed = true;
        open--;
        this.teardownPasv();
        emit({ type: 'disconnect', sessionId: this.id, remoteAddress });
      });
      this.reply(banner);
    }

    private reply(line: string): void {
      if (!this.socket.destroyed) this.socket.write(line.endsWith('\r\n') ? line : line + '\r\n');
    }

    private onData(chunk: Buffer, remoteAddress: string | undefined): void {
      this.buffer += chunk.toString('latin1');
      if (this.buffer.length > 8192) this.buffer = this.buffer.slice(-8192); // flood guard
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const raw = this.buffer.slice(0, idx).replace(/\r$/, '');
        this.buffer = this.buffer.slice(idx + 1);
        if (raw.length) {
          const line = raw;
          this.queue = this.queue.then(() => this.handle(line, remoteAddress)).catch(() => {});
        }
      }
    }

    private async handle(raw: string, remoteAddress: string | undefined): Promise<void> {
      const sp = raw.indexOf(' ');
      const cmd = (sp < 0 ? raw : raw.slice(0, sp)).toUpperCase();
      const arg = sp < 0 ? '' : raw.slice(sp + 1);
      emit({ type: 'command', sessionId: this.id, remoteAddress, detail: { cmd, arg } });

      switch (cmd) {
        case 'USER':
          this.reply('331 Please specify the password.');
          return;
        case 'PASS':
          this.authed = true;
          emit({ type: 'login', sessionId: this.id, remoteAddress, detail: { user: 'anonymous' } });
          this.reply('230 Login successful.');
          return;
        case 'ACCT':
          this.reply('230 Login successful.');
          return;
        case 'SYST':
          this.reply('215 UNIX Type: L8');
          return;
        case 'FEAT':
          this.reply('211-Features:\r\n PASV\r\n EPSV\r\n UTF8\r\n211 End');
          return;
        case 'OPTS':
          this.reply('200 OK.');
          return;
        case 'NOOP':
          this.reply('200 NOOP ok.');
          return;
        case 'TYPE':
          this.reply(
            '200 Switching to ' +
              (arg.toUpperCase().startsWith('A') ? 'ASCII' : 'Binary') +
              ' mode.',
          );
          return;
        case 'PWD':
        case 'XPWD':
          this.reply(`257 "${this.cwd}" is the current directory`);
          return;
      }

      if (!this.authed) {
        this.reply('530 Please login with USER and PASS.');
        return;
      }

      switch (cmd) {
        case 'CWD':
        case 'XCWD': {
          const target = fs.resolve(this.cwd, arg || '/');
          if (fs.isFile(target)) {
            this.reply('550 Not a directory.');
          } else {
            this.cwd = target;
            this.reply(`250 Directory successfully changed to "${this.cwd}".`);
          }
          return;
        }
        case 'CDUP':
        case 'XCUP':
          this.cwd = fs.resolve(this.cwd, '..');
          this.reply('250 Directory successfully changed.');
          return;
        case 'PASV':
          await this.openPasv(remoteAddress, false);
          return;
        case 'EPSV':
          await this.openPasv(remoteAddress, true);
          return;
        case 'LIST':
        case 'NLST': {
          const target = arg && !arg.startsWith('-') ? fs.resolve(this.cwd, arg) : this.cwd;
          const listing = fs.list(target);
          const body =
            cmd === 'NLST' ? formatNameList(listing.entries) : formatList(listing.entries);
          emit({
            type: 'list',
            sessionId: this.id,
            remoteAddress,
            detail: {
              path: target,
              entries: listing.entries.length,
              bytes: body.length,
              canary: listing.canaryFile,
            },
          });
          await this.sendData(body, 'ASCII');
          return;
        }
        case 'RETR': {
          const target = fs.resolve(this.cwd, arg);
          const want = fs.isFile(target);
          const body = want
            ? toBuffer(fileContent(target, maxFileBytes)).subarray(0, maxFileBytes)
            : Buffer.alloc(0);
          emit({
            type: 'retrieve',
            sessionId: this.id,
            remoteAddress,
            detail: { path: target, bytes: body.length, exists: want },
          });
          if (!want) {
            this.reply('550 Failed to open file.');
            return;
          }
          await this.sendData(body, 'binary');
          return;
        }
        case 'SIZE': {
          const target = fs.resolve(this.cwd, arg);
          const parent = fs.list(fs.resolve(target, '..'));
          const name = target.slice(target.lastIndexOf('/') + 1);
          const file = parent.entries.find((e) => e.name === name && e.type === 'file');
          this.reply(
            file ? `213 ${Math.min(file.size, maxFileBytes)}` : '550 Could not get file size.',
          );
          return;
        }
        case 'MDTM':
          this.reply('213 20240101000000');
          return;
        case 'QUIT':
          this.reply('221 Goodbye.');
          this.socket.end();
          return;
        case 'ABOR':
          this.reply('226 ABOR successful.');
          return;
        default:
          // Refuse everything else so the agent stays on ls/cd and cannot escape.
          this.reply('502 Command not implemented.');
          return;
      }
    }

    /** Open a passive data listener and reply 227/229. */
    private async openPasv(remoteAddress: string | undefined, extended: boolean): Promise<void> {
      this.teardownPasv();
      const dataServer = net.createServer();
      const waiters: ((s: net.Socket | null) => void)[] = [];
      const ready: net.Socket[] = [];
      dataServer.on('connection', (s) => {
        s.on('error', () => {});
        const w = waiters.shift();
        // Deliver to a waiting transfer, or park it until one arrives (the
        // client may connect the data socket before sending LIST/RETR).
        if (w) w(s);
        else ready.push(s);
      });
      await new Promise<void>((resolve) => dataServer.listen(0, host, resolve));
      const port = (dataServer.address() as net.AddressInfo).port;
      this.pasv = { server: dataServer, port, waiters, ready };

      if (extended) {
        this.reply(`229 Entering Extended Passive Mode (|||${port}|)`);
      } else {
        const adv =
          options.pasvHost ??
          (isIpv4(this.socket.localAddress) ? this.socket.localAddress : '127.0.0.1');
        const [a, b, c, d] = adv.split('.');
        this.reply(`227 Entering Passive Mode (${a},${b},${c},${d},${port >> 8},${port & 0xff})`);
      }
    }

    private teardownPasv(): void {
      if (!this.pasv) return;
      const { server, ready, waiters } = this.pasv;
      this.pasv = null;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      for (const s of ready) s.destroy(); // don't leak unclaimed data sockets
      for (const w of waiters) w(null); // unblock any pending transfer → 425
    }

    /** Wait for the client's data connection, send the body, then reply 226. */
    private async sendData(body: string | Buffer, kind: string): Promise<void> {
      if (!this.pasv) {
        this.reply('425 Use PASV or EPSV first.');
        return;
      }
      this.reply(`150 Here comes the ${kind} data.`);
      const pasv = this.pasv;
      // Use a socket that already connected, else wait for one.
      const dataSocket =
        pasv.ready.shift() ??
        (await new Promise<net.Socket | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 10_000);
          pasv.waiters.push((s) => {
            clearTimeout(timer);
            resolve(s);
          });
        }));
      this.teardownPasv();
      if (!dataSocket) {
        this.reply('425 Failed to establish data connection.');
        return;
      }
      await new Promise<void>((resolve) => dataSocket.end(toBuffer(body), () => resolve()));
      this.reply('226 Transfer complete.');
    }
  }

  const api: FtpTarpit = {
    filesystem: fs,
    get port() {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : wantPort;
    },
    host,
    get connections() {
      return open;
    },
    listen() {
      return new Promise<FtpTarpit>((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantPort, host, () => {
          server.off('error', reject);
          server.on('error', (err) => emit({ type: 'error', detail: { message: err.message } }));
          emit({ type: 'listening', detail: { host, port: api.port } });
          resolve(api);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}

function toBuffer(x: string | Buffer): Buffer {
  return Buffer.isBuffer(x) ? x : Buffer.from(x, 'utf8');
}

/** Small, boring, deterministic content for RETR — enough to look real, useless to read. */
function deterministicJunk(size: number): Buffer {
  const n = Math.max(0, Math.min(size, 4096));
  const line = '# archived record - contents redacted pending review\n';
  let out = '';
  while (out.length < n) out += line;
  return Buffer.from(out.slice(0, n), 'utf8');
}
