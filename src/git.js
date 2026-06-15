// All git operations against the modpack repo, authenticated by the SSH deploy key.

import fs from 'node:fs';
import path from 'node:path';
import { config, sshGitCommand } from './config.js';
import { git, run, commitUrl } from './util.js';
import {
  readIndex,
  upsertEntry,
  removeById,
  stringifyIndex,
  indexPath,
} from './modindex.js';

let resolvedKeyPath = null;

// Serialize every operation that touches the shared working clone. Without this,
// one job's `reset --hard`/`clean -fd` (inside syncBranch) can wipe the jar+index
// another job just wrote but hasn't committed yet — silently dropping a push.
let repoLock = Promise.resolve();
function withRepoLock(fn) {
  const result = repoLock.then(() => fn());
  repoLock = result.then(
    () => {},
    () => {}
  );
  return result;
}

/** Ensure the deploy key is usable (exists, 0600). Copies it if the source is read-only. */
export function ensureDeployKey() {
  if (resolvedKeyPath) return resolvedKeyPath;
  const src = config.deployKeyPath;
  if (!src) {
    throw new Error(
      'DEPLOY_KEY_PATH is not set. Point it at your modpack deploy key (private key file).'
    );
  }
  if (!fs.existsSync(src)) {
    throw new Error(`Deploy key not found at DEPLOY_KEY_PATH="${src}".`);
  }
  fs.mkdirSync(config.sshDir, { recursive: true });

  if (config.normalizeDeployKey) {
    // Copy into a managed 0600 file so read-only bind mounts / odd perms don't break ssh.
    const dest = path.join(config.sshDir, 'deploy_key');
    const data = fs.readFileSync(src);
    fs.writeFileSync(dest, data, { mode: 0o600 });
    fs.chmodSync(dest, 0o600);
    resolvedKeyPath = dest;
  } else {
    try {
      fs.chmodSync(src, 0o600);
    } catch {
      /* may fail on read-only mounts; ssh may still accept it */
    }
    resolvedKeyPath = src;
  }
  return resolvedKeyPath;
}

function gitEnv() {
  const keyPath = ensureDeployKey();
  return {
    GIT_SSH_COMMAND: sshGitCommand(keyPath),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: config.authorName,
    GIT_AUTHOR_EMAIL: config.authorEmail,
    GIT_COMMITTER_NAME: config.authorName,
    GIT_COMMITTER_EMAIL: config.authorEmail,
  };
}

function assertBranch(branch) {
  if (!config.allowedBranches.includes(branch)) {
    throw new Error(
      `Branch "${branch}" is not allowed. Allowed: ${config.allowedBranches.join(', ')}.`
    );
  }
}

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

/** Clone the repo the first time; otherwise verify the remote matches. */
export async function ensureClone(onLine = () => {}) {
  const env = gitEnv();
  const dir = config.cloneDir;

  if (!isGitRepo(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    onLine(`$ git clone ${config.repoSsh}`, 'out');
    await git(['clone', config.repoSsh, dir], {
      env,
      onLine,
      timeoutMs: config.gitTimeoutMs,
    });
    return dir;
  }

  // Make sure the existing clone points at the configured remote.
  const remote = await git(['-C', dir, 'remote', 'get-url', 'origin'], {
    env,
    allowFail: true,
  });
  const url = (remote.stdout || '').trim();
  if (url && url !== config.repoSsh) {
    await git(['-C', dir, 'remote', 'set-url', 'origin', config.repoSsh], { env });
  }
  return dir;
}

/** Fetch + hard-reset the target branch to its remote tip (clean working tree). */
export async function syncBranch(branch, onLine = () => {}) {
  assertBranch(branch);
  const env = gitEnv();
  const dir = await ensureClone(onLine);

  onLine(`$ git fetch origin ${branch}`, 'out');
  const fetch = await git(['-C', dir, 'fetch', '--prune', 'origin'], {
    env,
    onLine,
    timeoutMs: config.gitTimeoutMs,
    allowFail: true,
  });
  if (fetch.code !== 0) {
    throw decorateAuthError(
      new Error(`git fetch failed:\n${fetch.stderr || fetch.stdout}`),
      fetch.stderr
    );
  }

  // Make sure the branch exists on the remote.
  const ref = await git(
    ['-C', dir, 'rev-parse', '--verify', '--quiet', `origin/${branch}`],
    { env, allowFail: true }
  );
  if (ref.code !== 0) {
    throw new Error(
      `Branch "${branch}" does not exist on the remote. Create it on GitHub first.`
    );
  }

  await git(['-C', dir, 'checkout', '-B', branch, `origin/${branch}`], { env, onLine });
  await git(['-C', dir, 'reset', '--hard', `origin/${branch}`], { env, onLine });
  await git(['-C', dir, 'clean', '-fd'], { env, onLine });

  // Pin commit identity locally too (in addition to env vars).
  await git(['-C', dir, 'config', 'user.name', config.authorName], { env });
  await git(['-C', dir, 'config', 'user.email', config.authorEmail], { env });

  return dir;
}

/** Read the current manifest for a branch (used by preview + the mods list). */
export function loadBranchIndex(branch, onLine = () => {}) {
  return withRepoLock(async () => {
    const dir = await syncBranch(branch, onLine);
    const { index, text } = readIndex(dir);
    return { dir, index, text };
  });
}

// ---- Working-tree mutations (re-runnable after a hard reset) ---------------

function applyUpsert(dir, { jarBuffer, file, entry }) {
  const { index } = readIndex(dir);
  const res = upsertEntry(index, entry);
  // Write the new jar at the repo root.
  fs.writeFileSync(path.join(dir, file), jarBuffer);
  // Remove a superseded jar if the filename changed.
  if (res.oldFileToRemove) {
    const old = path.join(dir, res.oldFileToRemove);
    if (fs.existsSync(old)) fs.rmSync(old, { force: true });
  }
  fs.writeFileSync(indexPath(dir), stringifyIndex(res.index));
  return res; // { existed, oldEntry, oldFileToRemove }
}

function applyRemove(dir, id) {
  const { index } = readIndex(dir);
  const res = removeById(index, id);
  if (!res.removed) return res;
  if (res.removed.file) {
    const f = path.join(dir, res.removed.file);
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  fs.writeFileSync(indexPath(dir), stringifyIndex(res.index));
  return res;
}

function decorateAuthError(err, stderr = '') {
  const s = (stderr || err.message || '').toLowerCase();
  if (
    /permission denied|publickey|access rights|read-only|denied to|could not read from remote|authentication failed/.test(
      s
    )
  ) {
    err.message +=
      '\n\nHint: the SSH deploy key was rejected. Check that the key in DEPLOY_KEY_PATH ' +
      'is registered on the modpack repo as a deploy key WITH WRITE ACCESS, and that ' +
      'MODPACK_REPO_SSH matches that repo.';
    err.isAuthError = true;
  }
  return err;
}

async function commitAndPush(dir, branch, env, message, onLine) {
  await git(['-C', dir, 'add', '-A'], { env, onLine });

  // Nothing changed? Don't create an empty commit.
  const staged = await git(['-C', dir, 'diff', '--cached', '--quiet'], {
    env,
    allowFail: true,
  });
  if (staged.code === 0) {
    const head = await git(['-C', dir, 'rev-parse', 'HEAD'], { env });
    return { hash: head.stdout.trim(), pushed: false, noop: true };
  }

  await git(['-C', dir, 'commit', '-m', message], { env, onLine });
  onLine(`$ git push origin ${branch}`, 'out');
  const push = await git(['-C', dir, 'push', 'origin', `HEAD:${branch}`], {
    env,
    onLine,
    timeoutMs: config.gitTimeoutMs,
    allowFail: true,
  });
  if (push.code !== 0) {
    const e = new Error(`git push failed:\n${push.stderr || push.stdout}`);
    e.pushStderr = push.stderr || push.stdout;
    throw decorateAuthError(e, push.stderr);
  }
  const head = await git(['-C', dir, 'rev-parse', 'HEAD'], { env });
  return { hash: head.stdout.trim(), pushed: true, noop: false };
}

/**
 * Apply an upsert and push it. Re-syncs and retries once on a non-fast-forward
 * (someone else pushed in between), so concurrent updates don't clobber each other.
 */
export function upsertAndPush(
  { branch, jarBuffer, file, entry, message },
  onLine = () => {}
) {
  return withRepoLock(async () => {
    const env = gitEnv();
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const dir = await syncBranch(branch, onLine);
      const applied = applyUpsert(dir, { jarBuffer, file, entry });
      try {
        const result = await commitAndPush(dir, branch, env, message, onLine);
        return {
          ...result,
          ...applied,
          branch,
          url: commitUrl(config.repoSsh, result.hash),
        };
      } catch (e) {
        lastErr = e;
        const retriable = /non-fast-forward|fetch first|rejected|\[rejected\]/i.test(
          e.pushStderr || ''
        );
        if (retriable && attempt === 0) {
          onLine('Remote moved ahead — re-syncing and retrying push once...', 'err');
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  });
}

/** Remove a mod (entry + jar) and push. */
export function removeAndPush({ branch, id, message }, onLine = () => {}) {
  return withRepoLock(async () => {
    const env = gitEnv();
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const dir = await syncBranch(branch, onLine);
      const applied = applyRemove(dir, id);
      if (!applied.removed) {
        return { removed: null, branch, noop: true };
      }
      try {
        const result = await commitAndPush(dir, branch, env, message, onLine);
        return {
          ...result,
          removed: applied.removed,
          branch,
          url: commitUrl(config.repoSsh, result.hash),
        };
      } catch (e) {
        lastErr = e;
        const retriable = /non-fast-forward|fetch first|rejected|\[rejected\]/i.test(
          e.pushStderr || ''
        );
        if (retriable && attempt === 0) {
          onLine('Remote moved ahead — re-syncing and retrying push once...', 'err');
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  });
}

/** Quick connectivity / auth check used by the health endpoint. */
export async function checkAccess() {
  const env = gitEnv();
  const res = await run('git', ['ls-remote', '--heads', config.repoSsh], {
    env,
    timeoutMs: 60000,
  });
  if (res.code !== 0) {
    throw decorateAuthError(new Error(res.stderr || 'git ls-remote failed'), res.stderr);
  }
  const branches = res.stdout
    .split('\n')
    .map((l) => l.split('\t')[1])
    .filter(Boolean)
    .map((r) => r.replace('refs/heads/', ''));
  return { branches };
}
