// Zero-dependency test runner. Validates the core logic, using python3's zipfile
// (an INDEPENDENT zip implementation) to produce the test jars our reader parses.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readZipEntry, readZipText } from '../src/zip.js';
import { parseFabricMod, mcVersionWarning } from '../src/fabric.js';
import { validateSourceRepoUrl } from '../src/build.js';
import {
  sha256Hex,
  sanitizeJarFileName,
  remoteToHttpsBase,
  commitUrl,
  lastUrlSegment,
} from '../src/util.js';
import {
  makeEntry,
  upsertEntry,
  removeById,
  validateEntry,
  diffLines,
  stringifyIndex,
} from '../src/modindex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wmu-test-'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`);
  }
}
function throws(name, fn, match) {
  try {
    fn();
    ok(name, false, '(expected throw)');
  } catch (e) {
    ok(name, !match || match.test(e.message), `(got: ${e.message})`);
  }
}

// --- build jars with python3 (independent zip implementation) ----------------
function makeJar(file, members, compress = true) {
  const py = `
import zipfile, sys, json
ct = zipfile.ZIP_DEFLATED if ${compress ? 'True' : 'False'} else zipfile.ZIP_STORED
with zipfile.ZipFile(${JSON.stringify(file)}, 'w', ct) as z:
    members = json.loads(${JSON.stringify(JSON.stringify(members))})
    for name, content in members.items():
        z.writestr(name, content)
`;
  execFileSync('python3', ['-c', py]);
  return fs.readFileSync(file);
}

console.log('\nweb-modupdater test suite\n');

// === zip reader (deflated) ===
const fmj = JSON.stringify(
  { schemaVersion: 1, id: 'examplemod', version: '1.2.3', depends: { minecraft: '1.21.11' } },
  null,
  2
);
const deflated = makeJar(path.join(TMP, 'a.jar'), {
  'fabric.mod.json': fmj,
  'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n',
  'com/example/Mod.class': 'x'.repeat(5000),
});
ok('reads deflated fabric.mod.json', readZipText(deflated, 'fabric.mod.json') === fmj);
ok('returns null for missing entry', readZipEntry(deflated, 'nope.json') === null);

// === zip reader (stored / uncompressed) ===
const stored = makeJar(path.join(TMP, 'b.jar'), { 'fabric.mod.json': fmj }, false);
ok('reads STORED fabric.mod.json', readZipText(stored, 'fabric.mod.json') === fmj);

// === fabric validation ===
const meta = parseFabricMod(deflated);
ok('parseFabricMod id', meta.id === 'examplemod');
ok('parseFabricMod version', meta.version === '1.2.3');
ok('parseFabricMod mcDepend', meta.mcDepend === '1.21.11');
ok('no placeholder flag', meta.hasPlaceholder === false);

const noFabric = makeJar(path.join(TMP, 'c.jar'), { 'whatever.txt': 'hi' });
throws('rejects non-fabric jar', () => parseFabricMod(noFabric), /not a Fabric mod/i);
throws('rejects non-zip buffer', () => parseFabricMod(Buffer.from('not a zip at all')), /zip|jar/i);

const noId = makeJar(path.join(TMP, 'd.jar'), {
  'fabric.mod.json': JSON.stringify({ version: '1.0.0' }),
});
throws('rejects missing id', () => parseFabricMod(noId), /id/i);

const placeholderJar = makeJar(path.join(TMP, 'e.jar'), {
  'fabric.mod.json': JSON.stringify({ id: 'm', version: '${version}' }),
});
ok('detects ${} placeholder', parseFabricMod(placeholderJar).hasPlaceholder === true);

// lenient JSON (block comment + trailing comma). NOTE: // line comments are
// intentionally unsupported (they can't be stripped without corrupting strings).
const lenient = makeJar(path.join(TMP, 'f.jar'), {
  'fabric.mod.json': '{\n  /* a comment */\n  "id": "lm",\n  "version": "9.9",\n}',
});
ok('parses fabric.mod.json with block comment + trailing comma', parseFabricMod(lenient).id === 'lm');

// array minecraft depends
const arrDep = makeJar(path.join(TMP, 'g.jar'), {
  'fabric.mod.json': JSON.stringify({ id: 'x', version: '1', depends: { minecraft: ['1.21.x'] } }),
});
ok('handles array minecraft depends', parseFabricMod(arrDep).mcDepend === '1.21.x');

// '//' inside a string value must NOT be eaten by the lenient parser (trailing
// comma forces the lenient path; the // is part of a real value).
const slashInStr = makeJar(path.join(TMP, 'h.jar'), {
  'fabric.mod.json': '{\n  "id": "sm",\n  "version": "1.0",\n  "description": "see a//b path",\n}',
});
const sm = parseFabricMod(slashInStr);
ok('keeps // inside string values', sm.id === 'sm' && sm.raw.description === 'see a//b path');

// === source repo URL validation (build mode) ===
ok('accepts https source url', validateSourceRepoUrl('https://github.com/o/r.git') === 'https://github.com/o/r.git');
ok('accepts http source url', validateSourceRepoUrl('http://example.com/r.git') === 'http://example.com/r.git');
throws('rejects file:// transport', () => validateSourceRepoUrl('file:///etc'), /transport|http/i);
throws('rejects scp-style ssh url', () => validateSourceRepoUrl('git@github.com:o/r.git'), /Invalid|transport|http/i);
throws('rejects leading-dash (argv injection)', () => validateSourceRepoUrl('--upload-pack=x'), /-|http/i);
throws('rejects empty source url', () => validateSourceRepoUrl('  '), /Missing|source/i);

// === sha256 matches python hashlib (independent) ===
const bytes = crypto.randomBytes(4096);
const fp = path.join(TMP, 'blob.bin');
fs.writeFileSync(fp, bytes);
const pyHash = execFileSync('python3', [
  '-c',
  `import hashlib,sys;print(hashlib.sha256(open(${JSON.stringify(fp)},'rb').read()).hexdigest())`,
])
  .toString()
  .trim();
const ourHash = sha256Hex(bytes);
ok('sha256 matches python hashlib', ourHash === pyHash, `(${ourHash} vs ${pyHash})`);
ok('sha256 is lowercase hex', /^[0-9a-f]{64}$/.test(ourHash));

// === filename sanitization ===
ok('keeps clean name', sanitizeJarFileName('cool-mod-1.0.jar') === 'cool-mod-1.0.jar');
ok('strips path components', sanitizeJarFileName('a/b/c/mod.jar') === 'mod.jar');
ok('strips windows path', sanitizeJarFileName('a\\b\\mod.jar') === 'mod.jar');
throws('rejects non-jar', () => sanitizeJarFileName('evil.exe'), /\.jar/i);
// Traversal is neutralized to a safe basename (cannot escape the repo root).
ok('neutralizes traversal to basename', sanitizeJarFileName('../../etc/passwd.jar') === 'passwd.jar');
ok('result has no separators', !/[\\/]/.test(sanitizeJarFileName('a/b/../c/mod.jar')));
throws('rejects ".." in cleaned name', () => sanitizeJarFileName('weird..name.jar'), /\.\./);
throws('rejects empty', () => sanitizeJarFileName(''), /filename/i);

// === remote -> https / commit url ===
ok(
  'ssh remote -> https',
  remoteToHttpsBase('git@github.com:Daledwin/modpack.git') === 'https://github.com/Daledwin/modpack'
);
ok(
  'https remote -> https',
  remoteToHttpsBase('https://github.com/Daledwin/modpack.git') === 'https://github.com/Daledwin/modpack'
);
ok(
  'commit url',
  commitUrl('git@github.com:Daledwin/modpack.git', 'abc123') ===
    'https://github.com/Daledwin/modpack/commit/abc123'
);

// === url last segment ===
ok('last segment basic', lastUrlSegment('https://x.com/a/b/mod-1.0.jar') === 'mod-1.0.jar');
ok('last segment ignores query', lastUrlSegment('https://x.com/d/mod.jar?x=1') === 'mod.jar');

// === index upsert / remove ===
let idx = { mods: [] };
const e1 = makeEntry({ id: 'foo', version: '1.0', file: 'foo-1.0.jar', side: 'both', sha256: 'a'.repeat(64) });
let r = upsertEntry(idx, e1);
ok('upsert appends new', r.index.mods.length === 1 && !r.existed);
idx = r.index;

// update SAME file -> no removal
const e1b = makeEntry({ id: 'foo', version: '1.1', file: 'foo-1.0.jar', side: 'both', sha256: 'b'.repeat(64) });
r = upsertEntry(idx, e1b);
ok('upsert updates in place', r.index.mods.length === 1 && r.existed);
ok('same file -> no removal', r.oldFileToRemove === null);
ok('version replaced', r.index.mods[0].version === '1.1');
idx = r.index;

// update with DIFFERENT file -> old file removed
const e1c = makeEntry({ id: 'foo', version: '1.2', file: 'foo-1.2.jar', side: 'server', sha256: 'c'.repeat(64) });
r = upsertEntry(idx, e1c);
ok('different file -> remove old', r.oldFileToRemove === 'foo-1.0.jar');
idx = r.index;

// add a second mod, keep order
const e2 = makeEntry({ id: 'bar', version: '2.0', file: 'bar.jar', side: 'client', sha256: 'd'.repeat(64) });
idx = upsertEntry(idx, e2).index;
ok('second mod appended', idx.mods.length === 2 && idx.mods[1].id === 'bar');

// remove
const rem = removeById(idx, 'foo');
ok('removeById removes entry', rem.index.mods.length === 1 && rem.removed.id === 'foo');
ok('removeById returns file', rem.removed.file === 'foo-1.2.jar');
ok('removeById missing -> null', removeById(idx, 'ghost').removed === null);

// === entry validation ===
ok('valid entry has no problems', validateEntry(e1).length === 0);
ok('missing sha flagged', validateEntry({ id: 'a', version: '1', file: 'a.jar', side: 'both' }).some((p) => /sha/.test(p)));
ok('bad side flagged', validateEntry({ ...e1, side: 'nope' }).some((p) => /side/.test(p)));
ok('uppercase sha flagged', validateEntry({ ...e1, sha256: 'A'.repeat(64) }).some((p) => /sha256/.test(p)));

// === diff ===
const before = stringifyIndex({ mods: [e2] });
const after = stringifyIndex({ mods: [e2, e1] });
const d = diffLines(before, after);
ok('diff has additions', d.some((x) => x.type === 'add'));
ok('diff has context', d.some((x) => x.type === 'ctx'));

// === mc warning ===
ok('mc match -> no warning', mcVersionWarning('1.21.11', '1.21.11') === null);
ok('mc major.minor match -> no warning', mcVersionWarning('>=1.21', '1.21.11') === null);
ok('mc mismatch -> warning', typeof mcVersionWarning('1.20.1', '1.21.11') === 'string');
ok('mc missing -> warning', typeof mcVersionWarning(null, '1.21.11') === 'string');

// cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
