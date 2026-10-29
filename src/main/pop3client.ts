// Minimal POP3 client (RFC 1939 + STLS from RFC 2595): just what fetching mail needs.
// Port 995 = TLS right away; otherwise the connection is upgraded with STLS – without TLS
// the password is never sent.
import net from 'node:net';
import tls from 'node:tls';

export interface Pop3Cfg {
  host: string;
  port: number;
  secure: boolean;
  user: string;
}

const TIMEOUT = 60_000;
const END = Buffer.from('\r\n.\r\n');

export class Pop3Client {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiting: { multi: boolean; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private failed: Error | null = null;

  static async connect(cfg: Pop3Cfg, pass: string): Promise<Pop3Client> {
    const c = new Pop3Client();
    await c.open(cfg);
    await c.read(false); // greeting
    if (!cfg.secure) {
      try {
        await c.cmd('STLS');
      } catch {
        c.close();
        throw new Error('POP3: server offers no STLS – use port 995 with SSL/TLS');
      }
      await c.upgrade(cfg.host);
    }
    try {
      await c.cmd(`USER ${cfg.user}`);
      await c.cmd(`PASS ${pass}`);
    } catch (err) {
      c.close();
      throw Object.assign(new Error((err as Error).message), { authenticationFailed: true });
    }
    return c;
  }

  private open(cfg: Pop3Cfg): Promise<void> {
    return new Promise((resolve, reject) => {
      const opts = { host: cfg.host, port: cfg.port, servername: cfg.host };
      const s = cfg.secure ? tls.connect(opts, () => resolve()) : net.connect(opts, () => resolve());
      this.attach(s);
      s.once('error', reject);
    });
  }

  private upgrade(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock.removeAllListeners('data');
      const s = tls.connect({ socket: this.sock, servername: host }, () => resolve());
      s.once('error', reject);
      this.attach(s);
    });
  }

  private attach(s: net.Socket): void {
    this.sock = s;
    s.setTimeout(TIMEOUT, () => this.fail(new Error('POP3: timeout')));
    s.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.pump();
    });
    s.on('error', (e) => this.fail(e));
    s.on('close', () => this.fail(new Error('POP3: connection closed')));
  }

  private fail(e: Error): void {
    this.failed ??= e;
    const w = this.waiting;
    this.waiting = null;
    w?.reject(e);
  }

  // Hand a complete answer (one line, or up to "\r\n.\r\n" for lists/mails) to the waiting command
  private pump(): void {
    const w = this.waiting;
    if (!w) return;
    const eol = this.buf.indexOf('\r\n');
    if (eol < 0) return;
    const first = this.buf.subarray(0, eol).toString('latin1');
    if (first.startsWith('-ERR')) {
      this.buf = this.buf.subarray(eol + 2);
      this.waiting = null;
      return w.reject(new Error(first.slice(4).trim() || 'POP3 error'));
    }
    if (!w.multi) {
      this.buf = this.buf.subarray(eol + 2);
      this.waiting = null;
      return w.resolve(Buffer.from(first));
    }
    // multi-line: body runs from after the status line to "CRLF . CRLF". Searching from the
    // status line's own CRLF also catches an empty body (a body line can't start with a lone ".")
    const bodyStart = eol + 2;
    const end = this.buf.indexOf(END, eol);
    if (end < 0) return;
    const body = end < bodyStart ? Buffer.alloc(0) : this.buf.subarray(bodyStart, end + 2);
    this.buf = this.buf.subarray(end + END.length);
    this.waiting = null;
    w.resolve(unstuff(body));
  }

  private read(multi: boolean): Promise<Buffer> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiting = { multi, resolve, reject };
      this.pump();
    });
  }

  private async cmd(line: string, multi = false): Promise<Buffer> {
    if (this.failed) throw this.failed;
    const answer = this.read(multi);
    this.sock.write(`${line}\r\n`);
    return answer;
  }

  // message number → unique ID (stays the same across sessions)
  async uidl(): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const line of (await this.cmd('UIDL', true)).toString('latin1').split('\r\n')) {
      const m = /^(\d+)\s+(\S+)/.exec(line);
      if (m) out.set(Number(m[1]), m[2]);
    }
    return out;
  }

  async retr(n: number): Promise<Buffer> {
    return this.cmd(`RETR ${n}`, true);
  }

  async dele(n: number): Promise<void> {
    await this.cmd(`DELE ${n}`);
  }

  // QUIT commits the deletions (DELE) on the server
  async quit(): Promise<void> {
    try {
      await this.cmd('QUIT');
    } catch {
      /* already gone */
    }
    this.close();
  }

  close(): void {
    this.failed ??= new Error('POP3: closed');
    this.sock?.destroy();
  }
}

// Lines starting with "." are sent with an extra "." (byte stuffing) – undo it
function unstuff(body: Buffer): Buffer {
  if (!body.includes('\r\n..') && !(body[0] === 0x2e && body[1] === 0x2e)) return body;
  const parts: Buffer[] = [];
  let start = 0;
  let lineStart = 0;
  while (lineStart < body.length) {
    if (body[lineStart] === 0x2e && body[lineStart + 1] === 0x2e) {
      parts.push(body.subarray(start, lineStart));
      start = lineStart + 1;
    }
    const next = body.indexOf('\r\n', lineStart);
    if (next < 0) break;
    lineStart = next + 2;
  }
  parts.push(body.subarray(start));
  return Buffer.concat(parts);
}
