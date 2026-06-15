// HTTP server: serves the SPA and the JSON/SSE API. Built-in modules only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createJob, getJob, subscribe } from './jobs.js';
import {
  runPrepare,
  runConfirm,
  runDeletePrepare,
  runDeleteConfirm,
} from './pipeline.js';
import { loadBranchIndex, checkAccess, ensureDeployKey } from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`Request body exceeds limit (${limit} bytes).`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    const err = new Error(`Invalid JSON body: ${e.message}`);
    err.status = 400;
    throw err;
  }
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

const SIDES = ['server', 'client', 'both'];

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  // --- config for the UI ---
  if (pathname === '/api/config' && method === 'GET') {
    let keyOk = true;
    let keyError = null;
    try {
      ensureDeployKey();
    } catch (e) {
      keyOk = false;
      keyError = e.message;
    }
    return sendJson(res, 200, {
      repo: config.repoSsh,
      branches: config.allowedBranches,
      defaultBranch: config.defaultBranch,
      expectedMcVersion: config.expectedMcVersion,
      author: { name: config.authorName, email: config.authorEmail },
      deployKeyConfigured: keyOk,
      deployKeyError: keyError,
    });
  }

  // --- live access / auth check ---
  if (pathname === '/api/health' && method === 'GET') {
    try {
      const r = await checkAccess();
      return sendJson(res, 200, { ok: true, branches: r.branches });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  // --- list mods on a branch ---
  if (pathname === '/api/mods' && method === 'GET') {
    const branch = searchParams.get('branch') || config.defaultBranch;
    if (!config.allowedBranches.includes(branch)) {
      return badRequest(res, `Unknown branch "${branch}".`);
    }
    try {
      const { index } = await loadBranchIndex(branch);
      return sendJson(res, 200, { branch, mods: index.mods || [] });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // --- prepare (add/update) ---
  if (pathname === '/api/prepare' && method === 'POST') {
    const mode = searchParams.get('mode');
    const side = searchParams.get('side');
    const branch = searchParams.get('branch') || config.defaultBranch;

    if (!['upload', 'url', 'build'].includes(mode)) {
      return badRequest(res, `Invalid mode "${mode}".`);
    }
    if (!SIDES.includes(side)) {
      return badRequest(res, `Invalid side "${side}" (expected server|client|both).`);
    }
    if (!config.allowedBranches.includes(branch)) {
      return badRequest(res, `Unknown branch "${branch}".`);
    }

    if (mode === 'upload') {
      const filename = searchParams.get('filename');
      if (!filename) return badRequest(res, 'Missing "filename" for upload.');
      let body;
      try {
        body = await readBody(req, config.maxUploadBytes);
      } catch (e) {
        return badRequest(res, e.message);
      }
      if (body.length === 0) return badRequest(res, 'Uploaded file is empty.');
      const job = createJob('mod', {
        mode,
        side,
        branch,
        originalName: filename,
      });
      fs.mkdirSync(config.jobsDir, { recursive: true });
      job.jarPath = path.join(config.jobsDir, `${job.id}.jar`);
      fs.writeFileSync(job.jarPath, body);
      runPrepare(job);
      return sendJson(res, 202, { jobId: job.id });
    }

    // url / build modes
    let payload;
    try {
      payload = await readJson(req);
    } catch (e) {
      return badRequest(res, e.message);
    }
    const target = (payload.url || payload.repoUrl || '').trim();
    if (!target) return badRequest(res, 'Missing "url" in request body.');

    const job = createJob('mod', {
      mode,
      side,
      branch,
      url: mode === 'url' ? target : undefined,
      repoUrl: mode === 'build' ? target : undefined,
    });
    runPrepare(job);
    return sendJson(res, 202, { jobId: job.id });
  }

  // --- prepare delete ---
  if (pathname === '/api/prepare-delete' && method === 'POST') {
    let payload;
    try {
      payload = await readJson(req);
    } catch (e) {
      return badRequest(res, e.message);
    }
    const modId = (payload.id || '').trim();
    const branch = (payload.branch || config.defaultBranch).trim();
    if (!modId) return badRequest(res, 'Missing mod "id".');
    if (!config.allowedBranches.includes(branch)) {
      return badRequest(res, `Unknown branch "${branch}".`);
    }
    const job = createJob('delete', { branch, modId });
    runDeletePrepare(job);
    return sendJson(res, 202, { jobId: job.id });
  }

  // --- job stream (SSE) ---
  let m = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/stream$/);
  if (m && method === 'GET') {
    const job = getJob(m[1]);
    if (!job) {
      res.writeHead(404);
      return res.end('job not found');
    }
    return subscribe(job, res);
  }

  // --- confirm a prepared job ---
  m = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/confirm$/);
  if (m && method === 'POST') {
    const job = getJob(m[1]);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    if (job.status !== 'ready') {
      return sendJson(res, 409, { error: `Job not ready (status=${job.status}).` });
    }
    if (job.kind === 'delete') runDeleteConfirm(job);
    else runConfirm(job);
    return sendJson(res, 202, { ok: true });
  }

  // --- job snapshot (polling fallback) ---
  m = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/);
  if (m && method === 'GET') {
    const job = getJob(m[1]);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    return sendJson(res, 200, {
      id: job.id,
      kind: job.kind,
      status: job.status,
      preview: job.preview,
      result: job.result,
      error: job.error,
    });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
      else try { res.end(); } catch { /* ignore */ }
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, url.pathname);
  }
  res.writeHead(405);
  res.end('Method not allowed');
});

// Ensure work dirs exist on boot.
for (const d of [config.workDir, config.jobsDir, config.buildDir, config.sshDir]) {
  fs.mkdirSync(d, { recursive: true });
}

server.listen(config.port, config.host, () => {
  /* eslint-disable no-console */
  console.log(`\n  web-modupdater  →  http://${config.host}:${config.port}`);
  console.log(`  repo            :  ${config.repoSsh}`);
  console.log(`  branches        :  ${config.allowedBranches.join(', ')} (default: ${config.defaultBranch})`);
  console.log(`  clone dir       :  ${config.cloneDir}`);
  let keyState = 'OK';
  try {
    ensureDeployKey();
  } catch (e) {
    keyState = `NOT READY — ${e.message}`;
  }
  console.log(`  deploy key      :  ${keyState}`);
  console.log(`  commit identity :  ${config.authorName} <${config.authorEmail}>\n`);
});
