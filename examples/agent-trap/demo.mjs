/**
 * Demonstrates the passive agent-tarpit: a naive "attack agent" that greedily
 * explores an FTP server looking for secrets gets trapped forever, burning
 * rounds and (as a proxy for LLM cost) bytes it must process each round.
 *
 *   node examples/agent-trap/demo.mjs
 *
 * Everything runs on 127.0.0.1. Nothing is sent to any other machine.
 */
import net from 'node:net';
import { createFtpTarpit } from '@prompt-aegis/tarpit';

const ROUNDS = Number(process.env.ROUNDS ?? 40);

// A tempting tree with big listings, to show how fast cost piles up.
const tarpit = await createFtpTarpit({
  port: 0,
  filesystem: { seed: 'agent-trap', dirsPerLevel: [25, 40], filesPerLevel: [2, 5] },
}).listen();

// ---- A deliberately naive "LLM attack agent" --------------------------------
// Each round it lists the current directory and dives into the most
// valuable-looking sub-directory. A real LLM agent behaves much the same.
const SCORE = /secret|credential|key|password|vault|backup|token|cert|prod|root/i;

function ftp(port) {
  const sock = net.connect(port, '127.0.0.1');
  let lines = [],
    buf = '';
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  const reply = (re) =>
    new Promise((res) => {
      const t = setInterval(() => {
        const i = lines.findIndex((l) => re.test(l));
        if (i >= 0) {
          const m = lines[i];
          lines = lines.slice(i + 1);
          clearInterval(t);
          res(m);
        }
      }, 5);
    });
  const cmd = (s) => sock.write(s + '\r\n');
  return { sock, reply, cmd };
}

const c = ftp(tarpit.port);
await c.reply(/^220/);
c.cmd('USER anonymous');
await c.reply(/^331/);
c.cmd('PASS agent@evil.example');
await c.reply(/^230/);

let round = 0,
  totalBytes = 0,
  depth = 0,
  foundFlag = false;
while (round < ROUNDS) {
  round++;
  c.cmd('PASV');
  const m = (await c.reply(/^227/)).match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  const data = net.connect(+m[5] * 256 + +m[6], '127.0.0.1');
  let body = '';
  data.on('data', (d) => (body += d));
  const done = new Promise((r) => data.on('close', r));
  c.cmd('LIST');
  await c.reply(/^150/);
  await done;
  await c.reply(/^226/);

  totalBytes += body.length;
  const dirs = body
    .trim()
    .split('\r\n')
    .filter((l) => l.startsWith('d'))
    .map((l) => l.split(/\s+/).slice(8).join(' '));
  if (body.includes('flag.txt') || body.includes('FLAG{')) {
    foundFlag = true;
    break;
  }
  // pick the juiciest-looking directory (exactly what you don't want an attacker's agent to keep doing)
  const next = dirs.sort((a, b) => SCORE.test(b) - SCORE.test(a) || b.length - a.length)[0];
  if (!next) break;
  c.cmd('CWD ' + next);
  await c.reply(/^2\d\d/);
  depth++;
  if (round % 10 === 0)
    console.log(
      `  round ${round}: depth ${depth}, ${(totalBytes / 1024).toFixed(0)} KB processed so far`,
    );
}

c.sock.destroy();
await tarpit.close();

console.log('\n─────────────────────────────────────────────');
console.log(`agent gave up after ${round} rounds (cap ${ROUNDS})`);
console.log(`  flag found:        ${foundFlag ? 'yes ⚠️' : 'no ✓ (there is none)'}`);
console.log(`  depth reached:     ${depth} directories deep, still descending`);
console.log(`  data it processed: ${(totalBytes / 1024).toFixed(0)} KB`);
console.log('─────────────────────────────────────────────');
console.log('Each KB is tokens a real LLM agent would pay to read, every round,');
console.log('forever. The attacker spends time and money; your real system is');
console.log('never touched. Raise dirsPerLevel to make it cost more.');
