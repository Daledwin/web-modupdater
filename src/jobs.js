// In-memory job store with a replayable Server-Sent-Events log per job.
// One job carries the whole prepare -> confirm -> push lifecycle.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const jobs = new Map();

export function createJob(kind, fields = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    kind, // 'mod' | 'delete'
    status: 'preparing', // preparing | ready | committing | done | error
    createdAt: Date.now(),
    ...fields,
    seq: 0,
    events: [], // { seq, event, data }
    listeners: new Set(),
    // filled in later:
    jarPath: null,
    entry: null,
    file: null,
    preview: null,
    result: null,
    error: null,
  };
  jobs.set(id, job);
  cleanupOld();
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

function write(res, ev) {
  res.write(`id: ${ev.seq}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
}

export function emit(job, event, data) {
  const ev = { seq: ++job.seq, event, data };
  job.events.push(ev);
  // Keep the buffer from growing without bound on very chatty builds.
  if (job.events.length > 5000) job.events.splice(0, job.events.length - 5000);
  for (const res of job.listeners) {
    try {
      write(res, ev);
    } catch {
      /* listener gone; cleaned up on close */
    }
  }
}

export function log(job, line, stream = 'out') {
  emit(job, 'log', { line, stream });
}

export function setStatus(job, status, extra = {}) {
  job.status = status;
  emit(job, 'status', { status, ...extra });
}

export function fail(job, message, detail = '') {
  job.status = 'error';
  job.error = { message, detail };
  emit(job, 'error', { message, detail });
}

/** Attach an SSE response: replay buffered events, then stream live ones. */
export function subscribe(job, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  // On reconnect the browser sends Last-Event-ID; only replay newer events so
  // already-handled events (e.g. the 'ready' preview) don't fire twice.
  const lastSeen = Number(res.req?.headers['last-event-id'] || 0) || 0;
  for (const ev of job.events) if (ev.seq > lastSeen) write(res, ev);
  // If the job already finished, the replay above already delivered the terminal
  // event; the client will close. Otherwise, keep the stream open.
  job.listeners.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);
  res.on('close', () => {
    clearInterval(heartbeat);
    job.listeners.delete(res);
  });
}

/** Best-effort cleanup of old jobs and their staged jar files. */
function cleanupOld() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff && job.listeners.size === 0) {
      if (job.jarPath) {
        try {
          fs.rmSync(job.jarPath, { force: true });
        } catch {
          /* ignore */
        }
      }
      jobs.delete(id);
    }
  }
  // Also sweep orphaned staged jars on disk.
  try {
    const dir = config.jobsDir;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* dir may not exist yet */
  }
}
