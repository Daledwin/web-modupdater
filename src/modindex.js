// Read / mutate the modpack's index.json (the manifest the `modupdater` mod consumes).
// Schema: { "mods": [ { id, version, file, side, sha256 } ] }

import fs from 'node:fs';
import path from 'node:path';

export const INDEX_FILE = 'index.json';

export function indexPath(repoDir) {
  return path.join(repoDir, INDEX_FILE);
}

/** Build an entry with a stable field order. */
export function makeEntry({ id, version, file, side, sha256 }) {
  return { id, version, file, side, sha256 };
}

export function stringifyIndex(index) {
  return JSON.stringify(index, null, 2) + '\n';
}

/** Read & validate index.json from the repo dir. Missing file => empty manifest. */
export function readIndex(repoDir) {
  const p = indexPath(repoDir);
  let text = null;
  if (fs.existsSync(p)) {
    text = fs.readFileSync(p, 'utf8');
  }
  let index;
  if (text === null || text.trim() === '') {
    index = { mods: [] };
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`Repo index.json is not valid JSON: ${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.mods)) {
      throw new Error('Repo index.json must be an object with a "mods" array.');
    }
    index = parsed;
  }
  return { index, text };
}

/**
 * Upsert by id. Replaces an existing entry (keeping its position) or appends.
 * If an existing entry referenced a different file, that file must be deleted.
 * @returns {{ index, existed, oldEntry, oldFileToRemove }}
 */
export function upsertEntry(index, entry) {
  const mods = Array.isArray(index.mods) ? index.mods.slice() : [];
  const i = mods.findIndex((m) => m && m.id === entry.id);
  let existed = false;
  let oldEntry = null;
  let oldFileToRemove = null;

  if (i >= 0) {
    existed = true;
    oldEntry = mods[i];
    if (oldEntry.file && oldEntry.file !== entry.file) {
      oldFileToRemove = oldEntry.file;
    }
    mods[i] = entry;
  } else {
    mods.push(entry);
  }
  return { index: { ...index, mods }, existed, oldEntry, oldFileToRemove };
}

/**
 * Remove an entry by id.
 * @returns {{ index, removed }} removed is the deleted entry or null.
 */
export function removeById(index, id) {
  const mods = Array.isArray(index.mods) ? index.mods.slice() : [];
  const i = mods.findIndex((m) => m && m.id === id);
  if (i < 0) return { index, removed: null };
  const removed = mods[i];
  mods.splice(i, 1);
  return { index: { ...index, mods }, removed };
}

/** Validate that an entry has every field modupdater requires (esp. sha256). */
export function validateEntry(entry) {
  const problems = [];
  for (const k of ['id', 'version', 'file', 'side', 'sha256']) {
    if (!entry[k] || typeof entry[k] !== 'string') problems.push(`missing "${k}"`);
  }
  if (entry.side && !['server', 'client', 'both'].includes(entry.side)) {
    problems.push(`invalid side "${entry.side}" (expected server|client|both)`);
  }
  if (entry.sha256 && !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    problems.push('sha256 must be 64 lowercase hex chars');
  }
  return problems;
}

// ---- Minimal unified line diff (for the preview screen) --------------------

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * Produce a unified-style diff between two text blobs.
 * @returns {Array<{type:'ctx'|'add'|'del', text:string}>}
 */
export function diffLines(beforeText, afterText) {
  const a = (beforeText || '').split('\n');
  const b = (afterText || '').split('\n');
  // Drop the trailing empty element from a final newline for cleaner output.
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();

  const dp = lcsTable(a, b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'add', text: b[j++] });
  return out;
}
