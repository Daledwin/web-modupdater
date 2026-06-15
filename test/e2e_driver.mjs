// Drives the running server through a full add + delete lifecycle via the HTTP API.
// Usage: node e2e_driver.mjs <baseUrl> <jarPath>
import fs from 'node:fs';

const [base, jarPath, jar2Path] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(jobId, until) {
  for (let i = 0; i < 300; i++) {
    const job = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
    if (until.includes(job.status)) return job;
    await sleep(150);
  }
  throw new Error('timed out polling job');
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

const jar = fs.readFileSync(jarPath);

// 1. config
const cfg = await (await fetch(`${base}/api/config`)).json();
console.log('config:', JSON.stringify({ repo: cfg.repo, branches: cfg.branches, key: cfg.deployKeyConfigured }));
assert(cfg.branches.includes('staging'), 'staging branch present');

// 2. prepare (upload)
let r = await fetch(
  `${base}/api/prepare?mode=upload&side=both&branch=staging&filename=examplemod-1.2.3.jar`,
  { method: 'POST', body: jar }
);
let { jobId } = await r.json();
assert(jobId, 'got jobId');
let job = await poll(jobId, ['ready', 'error']);
if (job.status === 'error') { console.error('prepare error:', job.error); process.exit(1); }
console.log('prepare ready: action=%s existed=%s files+=%j', job.preview.action, job.preview.existed, job.preview.filesAdded);
assert(job.preview.entry.id === 'examplemod', 'entry id');
assert(job.preview.entry.version === '1.2.3', 'entry version');
assert(/^[0-9a-f]{64}$/.test(job.preview.entry.sha256), 'sha256 hex');
assert(job.preview.action === 'add', 'action add');

// 3. confirm -> push
await fetch(`${base}/api/jobs/${jobId}/confirm`, { method: 'POST' });
job = await poll(jobId, ['done', 'error']);
if (job.status === 'error') { console.error('confirm error:', job.error); process.exit(1); }
console.log('pushed: hash=%s branch=%s', (job.result.hash || '').slice(0, 10), job.result.branch);
assert(job.result.hash && job.result.hash.length >= 7, 'commit hash');

// 4. list mods
let mods = (await (await fetch(`${base}/api/mods?branch=staging`)).json()).mods;
console.log('manifest now:', mods.map((m) => `${m.id}@${m.version}`).join(', '));
assert(mods.some((m) => m.id === 'examplemod' && m.version === '1.2.3'), 'mod in manifest');

// 5. update with a DIFFERENT file name -> old jar should be scheduled for removal
r = await fetch(
  `${base}/api/prepare?mode=upload&side=server&branch=staging&filename=examplemod-2.0.0.jar`,
  { method: 'POST', body: jar }
);
({ jobId } = await r.json());
job = await poll(jobId, ['ready', 'error']);
if (job.status === 'error') { console.error('update prepare error:', job.error); process.exit(1); }
assert(job.preview.action === 'update', 'action update');
console.log('update preview: existed=%s removes=%j', job.preview.existed, job.preview.filesRemoved);

// 6. delete flow
r = await fetch(`${base}/api/prepare-delete`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'examplemod', branch: 'staging' }),
});
({ jobId } = await r.json());
job = await poll(jobId, ['ready', 'error']);
if (job.status === 'error') { console.error('delete prepare error:', job.error); process.exit(1); }
assert(job.preview.kind === 'delete' && job.preview.removed.id === 'examplemod', 'delete preview');
await fetch(`${base}/api/jobs/${jobId}/confirm`, { method: 'POST' });
job = await poll(jobId, ['done', 'error']);
if (job.status === 'error') { console.error('delete confirm error:', job.error); process.exit(1); }
console.log('deleted: hash=%s', (job.result.hash || '').slice(0, 10));

mods = (await (await fetch(`${base}/api/mods?branch=staging`)).json()).mods;
assert(!mods.some((m) => m.id === 'examplemod'), 'mod removed from manifest');

// 7. CONCURRENCY regression: two confirms in parallel must BOTH land.
// Without the repo mutex, one job's `reset --hard` wipes the other's staged
// changes and that push is silently dropped (reported as "already up to date").
async function addMod(pth, file) {
  const buf = fs.readFileSync(pth);
  const pr = await (
    await fetch(`${base}/api/prepare?mode=upload&side=both&branch=staging&filename=${file}`, {
      method: 'POST', body: buf,
    })
  ).json();
  let j = await poll(pr.jobId, ['ready', 'error']);
  if (j.status === 'error') throw new Error('prepare failed: ' + JSON.stringify(j.error));
  await fetch(`${base}/api/jobs/${pr.jobId}/confirm`, { method: 'POST' });
  j = await poll(pr.jobId, ['done', 'error']);
  if (j.status === 'error') throw new Error('confirm failed: ' + JSON.stringify(j.error));
  return j.result;
}
const [ra, rb] = await Promise.all([
  addMod(jarPath, 'examplemod-1.2.3.jar'),
  addMod(jar2Path, 'othermod-1.0.0.jar'),
]);
console.log('concurrent pushes: %s / %s (noop: %s/%s)',
  (ra.hash || '').slice(0, 8), (rb.hash || '').slice(0, 8), !!ra.noop, !!rb.noop);
mods = (await (await fetch(`${base}/api/mods?branch=staging`)).json()).mods;
console.log('manifest after concurrent:', mods.map((m) => m.id).join(', '));
assert(mods.some((m) => m.id === 'examplemod'), 'concurrent: examplemod landed');
assert(mods.some((m) => m.id === 'othermod'), 'concurrent: othermod landed (no dropped push)');
assert(!ra.noop && !rb.noop, 'neither concurrent push was a silent no-op');

console.log('\nE2E DRIVER OK');
