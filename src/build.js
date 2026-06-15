// Build a Fabric mod from source: clone the repo, run the Gradle wrapper (JDK 21),
// and return the produced production jar (excluding -sources/-dev/-javadoc).

import fs from 'node:fs';
import path from 'node:path';
import { run } from './util.js';
import { config, sshGitCommandNoKey } from './config.js';

const EXCLUDE = /-(sources|dev|javadoc)\.jar$/i;

/**
 * Validate a user-supplied source repo URL before handing it to `git clone`.
 * Restricts to http/https (parity with the URL-download path), rejects leading
 * '-' (git argv-option injection) and non-network transports (file:, ssh:, scp).
 */
export function validateSourceRepoUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) throw new Error('Missing source repo URL.');
  if (url.startsWith('-')) {
    throw new Error('Source repo URL must not start with "-".');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Invalid source repo URL: "${url}". Use a public http(s) git URL ` +
        '(e.g. https://github.com/owner/repo.git).'
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported source URL transport "${parsed.protocol}". Only http(s) is allowed ` +
        '(no file:, ssh:, or local paths).'
    );
  }
  return url;
}

function listJarsRecursive(root, depth = 4) {
  // Collect every build/libs/*.jar under `root` (handles single + multi-module).
  const out = [];
  const walk = (dir, d) => {
    if (d < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === '.gradle' || e.name === 'node_modules') continue;
        walk(full, d - 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.jar')) {
        // Only consider jars that live in a build/libs directory.
        if (/[\\/]build[\\/]libs[\\/][^\\/]+\.jar$/i.test(full)) out.push(full);
      }
    }
  };
  walk(root, depth);
  return out;
}

function pickProductionJar(jars) {
  const candidates = jars.filter((j) => !EXCLUDE.test(path.basename(j)));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const an = path.basename(a);
    const bn = path.basename(b);
    // Fewer "-" segments usually = the plain remapped artifact (no classifier).
    const ad = (an.match(/-/g) || []).length;
    const bd = (bn.match(/-/g) || []).length;
    if (ad !== bd) return ad - bd;
    // Tie-break: larger file (the real, populated jar).
    return fs.statSync(b).size - fs.statSync(a).size;
  });
  return candidates[0];
}

/**
 * @param {string} repoUrl - public/source repo URL (https recommended)
 * @param {string} jobId
 * @param {(line:string, stream:'out'|'err')=>void} onLine
 * @returns {Promise<{ buffer: Buffer, filename: string, chosenPath: string, candidates: string[] }>}
 */
export async function buildFromSource(repoUrl, jobId, onLine) {
  repoUrl = validateSourceRepoUrl(repoUrl);
  const workdir = path.join(config.buildDir, jobId);
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.mkdirSync(workdir, { recursive: true });

  const env = {
    GIT_SSH_COMMAND: sshGitCommandNoKey(), // never the modpack deploy key
    GIT_TERMINAL_PROMPT: '0',
  };

  onLine(`$ git clone --depth 1 ${repoUrl}`, 'out');
  const clone = await run(
    'git',
    [
      // Block non-network transports even for submodules; '--' ends option parsing.
      '-c', 'protocol.ext.allow=never',
      '-c', 'protocol.file.allow=never',
      'clone', '--depth', '1', '--recurse-submodules',
      '--', repoUrl, workdir,
    ],
    { env, onLine, timeoutMs: config.gitTimeoutMs }
  );
  if (clone.code !== 0) {
    throw new Error(
      `Failed to clone source repo "${repoUrl}". Make sure it is a public URL ` +
        `(this machine has no credentials for private source repos).`
    );
  }

  const gradlew = path.join(workdir, 'gradlew');
  if (!fs.existsSync(gradlew)) {
    throw new Error(
      'No Gradle wrapper (./gradlew) found at the repo root. ' +
        'This tool builds Fabric mods via the Gradle wrapper only.'
    );
  }
  try {
    fs.chmodSync(gradlew, 0o755);
  } catch {
    /* best effort */
  }

  onLine('$ ./gradlew build --no-daemon --console=plain', 'out');
  const build = await run(
    './gradlew',
    ['build', '--no-daemon', '--console=plain', '--stacktrace'],
    {
      cwd: workdir,
      env: { ...env, GRADLE_OPTS: '-Dorg.gradle.daemon=false' },
      onLine,
      timeoutMs: config.buildTimeoutMs,
    }
  );
  if (build.code !== 0) {
    const err = new Error(
      `Gradle build failed (exit ${build.code}). See the build log above for details.`
    );
    err.isBuildFailure = true;
    throw err;
  }

  const jars = listJarsRecursive(workdir);
  const chosen = pickProductionJar(jars);
  if (!chosen) {
    throw new Error(
      'Build succeeded but no production jar was found in build/libs ' +
        `(scanned ${jars.length} jar(s); all looked like -sources/-dev/-javadoc).`
    );
  }
  onLine(`Selected artifact: ${path.relative(workdir, chosen)}`, 'out');
  const buffer = fs.readFileSync(chosen);
  return {
    buffer,
    filename: path.basename(chosen),
    chosenPath: chosen,
    candidates: jars.map((j) => path.relative(workdir, j)),
  };
}

/** Remove a build's scratch directory. */
export function cleanupBuild(jobId) {
  try {
    fs.rmSync(path.join(config.buildDir, jobId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
