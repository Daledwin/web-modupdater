// Orchestrates the lifecycle: prepare (fetch/build -> validate -> preview) and
// confirm (commit + push). Emits progress through the job's SSE log.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log, emit, setStatus, fail } from './jobs.js';
import { sha256Hex, sanitizeJarFileName } from './util.js';
import { parseFabricMod, mcVersionWarning } from './fabric.js';
import { downloadToBuffer } from './download.js';
import { buildFromSource, cleanupBuild } from './build.js';
import {
  makeEntry,
  validateEntry,
  upsertEntry,
  removeById,
  stringifyIndex,
  diffLines,
} from './modindex.js';
import { loadBranchIndex, upsertAndPush, removeAndPush } from './git.js';

function stagedJarPath(jobId) {
  return path.join(config.jobsDir, `${jobId}.jar`);
}

async function obtainJar(job) {
  const onLine = (line, stream) => log(job, line, stream);

  if (job.mode === 'upload') {
    setStatus(job, 'preparing', { phase: 'upload' });
    log(job, `Using uploaded file: ${job.originalName}`);
    const buffer = fs.readFileSync(job.jarPath);
    return { buffer, suggestedName: job.originalName };
  }

  if (job.mode === 'url') {
    setStatus(job, 'preparing', { phase: 'download' });
    log(job, `Downloading: ${job.url}`);
    let lastLogged = 0;
    const { buffer, finalUrl, suggestedName } = await downloadToBuffer(job.url, {
      maxBytes: config.maxUploadBytes,
      onProgress: (loaded, total) => {
        if (loaded - lastLogged >= 2 * 1024 * 1024 || (total && loaded === total)) {
          lastLogged = loaded;
          const pct = total ? ` (${Math.round((loaded / total) * 100)}%)` : '';
          log(job, `  ${(loaded / 1048576).toFixed(1)} MB downloaded${pct}`);
        }
      },
    });
    if (finalUrl !== job.url) log(job, `Resolved to: ${finalUrl}`);
    log(job, `Downloaded ${(buffer.length / 1048576).toFixed(2)} MB`);
    return { buffer, suggestedName };
  }

  if (job.mode === 'build') {
    setStatus(job, 'preparing', { phase: 'build' });
    log(job, `Building from source: ${job.repoUrl}`);
    const { buffer, filename, candidates } = await buildFromSource(
      job.repoUrl,
      job.id,
      onLine
    );
    log(job, `Build produced ${candidates.length} jar(s); chose ${filename}`);
    cleanupBuild(job.id);
    return { buffer, suggestedName: filename };
  }

  throw new Error(`Unknown source mode: ${job.mode}`);
}

export async function runPrepare(job) {
  try {
    // 1. Get the jar bytes from the chosen source.
    const { buffer, suggestedName } = await obtainJar(job);

    // 2. Sanitize the target filename.
    setStatus(job, 'preparing', { phase: 'validate' });
    const file = sanitizeJarFileName(suggestedName);

    // 3. Validate it's a Fabric mod & read its metadata.
    const { id, version, mcDepend, hasPlaceholder } = parseFabricMod(buffer);
    log(job, `Fabric mod detected: id="${id}", version="${version}"`);
    if (hasPlaceholder) {
      log(
        job,
        `WARNING: id/version contains an unresolved \${...} placeholder — this looks ` +
          'like an unprocessed dev jar.',
        'err'
      );
    }

    // 4. SHA-256 (lowercase hex).
    const sha256 = sha256Hex(buffer);
    log(job, `sha256 = ${sha256}`);

    // 5. Build & validate the index entry.
    const entry = makeEntry({ id, version, file, side: job.side, sha256 });
    const problems = validateEntry(entry);
    if (problems.length) {
      throw new Error(`Generated index entry is invalid: ${problems.join('; ')}`);
    }

    // 6. Minecraft version advisory.
    const mcWarning = mcVersionWarning(mcDepend, config.expectedMcVersion);

    // 7. Persist staged jar bytes for the confirm step.
    fs.mkdirSync(config.jobsDir, { recursive: true });
    const jarPath = stagedJarPath(job.id);
    fs.writeFileSync(jarPath, buffer);
    job.jarPath = jarPath;
    job.entry = entry;
    job.file = file;
    job.mcWarning = mcWarning;
    job.hasPlaceholder = hasPlaceholder;

    // 8. Compute the index.json diff against the target branch (dry-run preview).
    setStatus(job, 'preparing', { phase: 'diff' });
    log(job, `Syncing ${config.repoSsh} (${job.branch}) to compute the diff...`);
    const { index } = await loadBranchIndex(job.branch, (l, s) => log(job, l, s));
    const beforeText = stringifyIndex(index);
    const res = upsertEntry(index, entry);
    const afterText = stringifyIndex(res.index);

    const preview = {
      kind: 'mod',
      action: res.existed ? 'update' : 'add',
      branch: job.branch,
      entry,
      mcWarning,
      hasPlaceholder,
      existed: res.existed,
      oldEntry: res.oldEntry || null,
      filesAdded: [file],
      filesRemoved: res.oldFileToRemove ? [res.oldFileToRemove] : [],
      idConflict: res.existed
        ? {
            id,
            oldVersion: res.oldEntry ? res.oldEntry.version : null,
            oldFile: res.oldEntry ? res.oldEntry.file : null,
            replacesFile: res.oldFileToRemove || null,
          }
        : null,
      diff: diffLines(beforeText, afterText),
      modCount: { before: index.mods.length, after: res.index.mods.length },
    };
    job.preview = preview;

    setStatus(job, 'ready', { phase: 'ready' });
    emit(job, 'ready', preview);
  } catch (err) {
    fail(job, err.message, err.isBuildFailure ? 'gradle-build-failure' : err.stack || '');
    // Clean any build scratch on failure.
    cleanupBuild(job.id);
  }
}

export async function runConfirm(job) {
  if (job.status !== 'ready' || job.kind !== 'mod') {
    fail(job, `Job is not ready to commit (status=${job.status}).`);
    return;
  }
  try {
    setStatus(job, 'committing', { phase: 'commit' });
    const buffer = fs.readFileSync(job.jarPath);
    const { entry, file } = job;
    const message =
      `${job.preview.existed ? 'Update' : 'Add'} ${entry.id} ${entry.version} ` +
      `[${entry.side}] (${file})`;

    const result = await upsertAndPush(
      { branch: job.branch, jarBuffer: buffer, file, entry, message },
      (l, s) => log(job, l, s)
    );

    job.result = {
      ...result,
      message,
      entry,
    };
    setStatus(job, 'done', { phase: 'done' });
    emit(job, 'done', job.result);

    // Staged jar no longer needed.
    try {
      fs.rmSync(job.jarPath, { force: true });
    } catch {
      /* ignore */
    }
  } catch (err) {
    fail(job, err.message, err.pushStderr || err.stack || '');
  }
}

// ---- Delete flow -----------------------------------------------------------

export async function runDeletePrepare(job) {
  try {
    setStatus(job, 'preparing', { phase: 'diff' });
    log(job, `Loading ${job.branch} to locate "${job.modId}"...`);
    const { index } = await loadBranchIndex(job.branch, (l, s) => log(job, l, s));
    const beforeText = stringifyIndex(index);
    const res = removeById(index, job.modId);
    if (!res.removed) {
      throw new Error(`No mod with id "${job.modId}" exists on branch ${job.branch}.`);
    }
    const afterText = stringifyIndex(res.index);

    const preview = {
      kind: 'delete',
      branch: job.branch,
      removed: res.removed,
      filesRemoved: res.removed.file ? [res.removed.file] : [],
      diff: diffLines(beforeText, afterText),
      modCount: { before: index.mods.length, after: res.index.mods.length },
    };
    job.preview = preview;
    setStatus(job, 'ready', { phase: 'ready' });
    emit(job, 'ready', preview);
  } catch (err) {
    fail(job, err.message, err.stack || '');
  }
}

export async function runDeleteConfirm(job) {
  if (job.status !== 'ready' || job.kind !== 'delete') {
    fail(job, `Job is not ready to commit (status=${job.status}).`);
    return;
  }
  try {
    setStatus(job, 'committing', { phase: 'commit' });
    const removed = job.preview.removed;
    const message = `Remove ${removed.id}${removed.file ? ` (${removed.file})` : ''}`;
    const result = await removeAndPush(
      { branch: job.branch, id: job.modId, message },
      (l, s) => log(job, l, s)
    );
    job.result = { ...result, message };
    setStatus(job, 'done', { phase: 'done' });
    emit(job, 'done', job.result);
  } catch (err) {
    fail(job, err.message, err.pushStderr || err.stack || '');
  }
}
