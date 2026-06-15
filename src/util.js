// Small shared helpers: process execution, filename sanitization, URL helpers.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

/**
 * Run a command, streaming combined stdout/stderr line-by-line to `onLine`.
 * Resolves with { code, stdout, stderr }. Rejects only on spawn failure or timeout.
 * Caller decides what a non-zero exit code means.
 */
export function run(cmd, args, { cwd, env, onLine, timeoutMs, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    const timer = timeoutMs
      ? setTimeout(() => {
          killedByTimeout = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;

    const flush = (which) => {
      // Emit any trailing partial line at stream end.
      const buf = which === 'out' ? stdoutBuf : stderrBuf;
      if (buf && onLine) onLine(buf, which);
      if (which === 'out') stdoutBuf = '';
      else stderrBuf = '';
    };

    const handle = (data, which) => {
      const text = data.toString();
      if (which === 'out') stdout += text;
      else stderr += text;
      let buf = (which === 'out' ? stdoutBuf : stderrBuf) + text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop(); // keep partial
      if (which === 'out') stdoutBuf = buf;
      else stderrBuf = buf;
      if (onLine) for (const line of lines) onLine(line, which);
    };

    child.stdout.on('data', (d) => handle(d, 'out'));
    child.stderr.on('data', (d) => handle(d, 'err'));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      flush('out');
      flush('err');
      if (killedByTimeout) {
        const e = new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`);
        e.code = 'ETIMEDOUT';
        return reject(e);
      }
      resolve({ code, stdout, stderr });
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/** Run git, throwing a helpful error on non-zero exit (unless allowFail). */
export async function git(args, opts = {}) {
  const { allowFail = false } = opts;
  const res = await run('git', args, opts);
  if (res.code !== 0 && !allowFail) {
    const err = new Error(
      `git ${args.join(' ')} failed (exit ${res.code})\n${res.stderr || res.stdout}`.trim()
    );
    err.gitCode = res.code;
    err.gitStderr = res.stderr;
    err.gitStdout = res.stdout;
    throw err;
  }
  return res;
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex'); // already lowercase
}

/**
 * Sanitize a jar filename for safe storage at the repo root.
 * Returns the clean basename or throws with a clear message.
 */
export function sanitizeJarFileName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Missing jar filename.');
  }
  // Strip any directory components; we only ever store at the repo root.
  let base = name.replace(/\\/g, '/');
  base = base.slice(base.lastIndexOf('/') + 1);
  base = base.trim();

  if (base === '' || base === '.' || base === '..') {
    throw new Error(`Invalid jar filename: "${name}"`);
  }
  if (base.includes('..')) {
    throw new Error(`Invalid jar filename (contains ".."): "${name}"`);
  }
  if (!/\.jar$/i.test(base)) {
    throw new Error(`Jar filename must end with ".jar": "${base}"`);
  }
  if (!/^[A-Za-z0-9._+\-() ]+\.jar$/i.test(base)) {
    throw new Error(
      `Jar filename contains unsupported characters: "${base}". ` +
        'Allowed: letters, digits, . _ + - ( ) space.'
    );
  }
  // Normalize spaces to avoid surprises in URLs the client builds (<repo>/<file>).
  return base;
}

/** Convert a git SSH/HTTPS remote into an https base URL (no .git). */
export function remoteToHttpsBase(remote) {
  if (!remote) return null;
  let r = remote.trim();
  // git@github.com:Owner/Repo.git  ->  https://github.com/Owner/Repo
  let m = r.match(/^[\w.+-]+@([^:]+):(.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  // ssh://git@github.com/Owner/Repo.git
  m = r.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  // https://github.com/Owner/Repo(.git)
  m = r.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

export function commitUrl(remote, hash) {
  const base = remoteToHttpsBase(remote);
  if (!base || !hash) return null;
  return `${base}/commit/${hash}`;
}

export function lastUrlSegment(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : '';
  } catch {
    // Fall back to naive parsing if not a valid URL object.
    const clean = String(url).split(/[?#]/)[0];
    const seg = clean.split('/').filter(Boolean).pop();
    return seg || '';
  }
}
