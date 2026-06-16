// Central configuration, loaded from environment variables with sensible defaults.
// All values are resolved once at startup. See .env.example / README for docs.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Minimal .env loader (no dependency). Loads ./.env into process.env for any
// key that isn't already set, so `node src/server.js` works without exporting.
(function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env — fine
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

const WORK_DIR = path.resolve(
  process.env.WORK_DIR || path.join(process.cwd(), '.work')
);

export const config = {
  // HTTP
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),

  // Target modpack repo (consumed by the `modupdater` mod)
  repoSsh: process.env.MODPACK_REPO_SSH || 'git@github.com:Daledwin/modpack.git',
  cloneDir: path.resolve(
    process.env.MODPACK_CLONE_DIR || path.join(WORK_DIR, 'modpack-clone')
  ),
  allowedBranches: (process.env.MODPACK_BRANCHES || 'staging,main')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  defaultBranch: process.env.MODPACK_DEFAULT_BRANCH || 'staging',

  // SSH deploy key (write access to the modpack repo only)
  deployKeyPath: process.env.DEPLOY_KEY_PATH || '',

  // Commit identity (neutral values are fine)
  authorName: process.env.GIT_AUTHOR_NAME || 'modpack-tool',
  authorEmail: process.env.GIT_AUTHOR_EMAIL || 'modpack-tool@local',

  // Optional HTTP Basic Auth gate. Enabled ONLY when AUTH_PASSWORD is set.
  // Stopgap for LAN exposure — use real SSO + TLS for anything public.
  authUser: process.env.AUTH_USER || 'admin',
  authPassword: process.env.AUTH_PASSWORD || '',

  // Expected Minecraft version (used only to warn, never to block)
  expectedMcVersion: process.env.MODPACK_MC_VERSION || '1.21.11',

  // Working / scratch directories
  workDir: WORK_DIR,
  jobsDir: path.join(WORK_DIR, 'jobs'),
  buildDir: path.join(WORK_DIR, 'builds'),
  sshDir: path.join(WORK_DIR, 'ssh'),

  // Safety limits
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 256 * 1024 * 1024), // 256 MB
  buildTimeoutMs: Number(process.env.BUILD_TIMEOUT_MS || 30 * 60 * 1000), // 30 min
  gitTimeoutMs: Number(process.env.GIT_TIMEOUT_MS || 10 * 60 * 1000), // 10 min

  // Behaviour flags
  // When true, copy the deploy key into a managed 0600 file (handles read-only mounts).
  normalizeDeployKey: bool(process.env.NORMALIZE_DEPLOY_KEY, true),
};

export function sshGitCommand(keyPath) {
  // GIT_SSH_COMMAND used for every git operation against the modpack repo.
  const knownHosts = path.join(config.sshDir, 'known_hosts');
  return [
    'ssh',
    '-i', shellQuote(keyPath),
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${shellQuote(knownHosts)}`,
    '-o', 'BatchMode=yes',
  ].join(' ');
}

export function sshGitCommandNoKey() {
  // For cloning *source* repos (build-from-source). Never uses the deploy key,
  // so a source repo's SSH access can't be confused with the modpack's.
  const knownHosts = path.join(config.sshDir, 'known_hosts');
  return [
    'ssh',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${shellQuote(knownHosts)}`,
    '-o', 'BatchMode=yes',
  ].join(' ');
}

// Minimal quoting for paths that may contain spaces.
function shellQuote(p) {
  if (p && /[\s'"\\]/.test(p)) return `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
  return p;
}

export { os };
