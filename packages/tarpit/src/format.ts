import type { FakeEntry } from './filesystem';

/** Render FTP `LIST` output (Unix `ls -l` long format), which FTP clients parse. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function formatDate(mtime: number): string {
  const d = new Date(mtime);
  const mon = MONTHS[d.getUTCMonth()]!;
  const day = String(d.getUTCDate()).padStart(2, ' ');
  return `${mon} ${day} ${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}`;
}

/** One `ls -l` line for a fake entry. */
export function formatListLine(entry: FakeEntry): string {
  const perms = entry.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--';
  const size = String(entry.size).padStart(8, ' ');
  return `${perms} 1 root group ${size} ${formatDate(entry.mtime)} ${entry.name}`;
}

/** Full `LIST` body (CRLF-terminated lines) for a set of entries. */
export function formatList(entries: readonly FakeEntry[]): string {
  return entries.map(formatListLine).join('\r\n') + (entries.length ? '\r\n' : '');
}

/** `NLST` body: bare names, CRLF-terminated. */
export function formatNameList(entries: readonly FakeEntry[]): string {
  return entries.map((e) => e.name).join('\r\n') + (entries.length ? '\r\n' : '');
}
