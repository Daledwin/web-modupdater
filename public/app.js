/* modpack // deploy — client state machine */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const RAIL = ['fetch', 'validate', 'diff', 'commit', 'done'];

const App = {
  cfg: null,
  mode: 'upload',
  file: null,
  jobId: null,
  jobKind: null,
  es: null,
  terminal: null,
  dryRun: false,
  manifestBranch: null,
  terminated: false,

  async init() {
    this.terminal = $('#terminal');
    await this.loadConfig();
    this.wire();
    this.loadManifest();
  },

  async loadConfig() {
    try {
      const r = await fetch('/api/config');
      this.cfg = await r.json();
    } catch {
      this.cfg = { branches: ['staging', 'main'], defaultBranch: 'staging', expectedMcVersion: '1.21.11', repo: '—' };
    }
    const c = this.cfg;
    $('[data-repo]').textContent = (c.repo || '—').replace(/^git@|\.git$/g, '');
    $('[data-mc]').textContent = c.expectedMcVersion || '—';
    if (c.author) $('[data-author]').textContent = `commit as ${c.author.name} <${c.author.email}>`;

    // deploy-key indicator
    const dot = $('[data-keydot]');
    const txt = $('[data-keytext]');
    if (c.deployKeyConfigured) {
      dot.className = 'dot ok';
      txt.textContent = 'deploy key ready';
    } else {
      dot.className = 'dot bad';
      txt.textContent = 'deploy key not set';
    }

    // branch segmented controls
    this.manifestBranch = c.defaultBranch;
    this.renderBranchSeg('#branchSeg', 'side-branch', c.defaultBranch, () => this.updateBranchReadout());
    this.renderBranchSeg('#manifestBranchSeg', 'man-branch', c.defaultBranch, (b) => {
      this.manifestBranch = b;
      this.loadManifest();
    });
    this.updateBranchReadout();
  },

  renderBranchSeg(sel, name, selected, onChange) {
    const el = $(sel);
    el.innerHTML = (this.cfg.branches || ['staging', 'main'])
      .map(
        (b) => `<label><input type="radio" name="${name}" value="${esc(b)}" ${
          b === selected ? 'checked' : ''
        }/><span>${esc(b)}</span></label>`
      )
      .join('');
    el.addEventListener('change', (e) => {
      if (e.target.value) onChange(e.target.value);
    });
  },

  getBranch() {
    const r = $('#branchSeg input:checked');
    return r ? r.value : this.cfg.defaultBranch;
  },
  getSide() {
    const r = $('#sideSeg input:checked');
    return r ? r.value : 'both';
  },
  updateBranchReadout() {
    const b = this.getBranch();
    $('#branchReadout').innerHTML = `→ will push to <b>${esc(b)}</b>`;
  },

  wire() {
    // mode tabs
    $$('#modeTabs .tab').forEach((tab) =>
      tab.addEventListener('click', () => this.setMode(tab.dataset.mode))
    );

    // file input + dropzone
    const fileInput = $('#fileInput');
    const dz = $('#dropzone');
    fileInput.addEventListener('change', () => this.setFile(fileInput.files[0]));
    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add('drag');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove('drag');
      })
    );
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (f) this.setFile(f);
    });

    // form
    $('#opForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });

    // confirm / reset buttons (delegated)
    $('#confirmBtn').addEventListener('click', () => this.confirm());
    $$('[data-action="reset"]').forEach((b) => b.addEventListener('click', () => this.reset()));

    // manifest
    $('#refreshBtn').addEventListener('click', () => this.loadManifest());
    $('#modList').addEventListener('click', (e) => {
      const btn = e.target.closest('.trash');
      if (btn) this.startDelete(btn.dataset.id);
    });

    // deploy-key check
    $('#keyChip').addEventListener('click', () => this.checkAccess());
  },

  setMode(mode) {
    this.mode = mode;
    $$('#modeTabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.mode === mode));
    $$('.pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === mode));
  },

  setFile(f) {
    if (!f) return;
    this.file = f;
    const el = $('#dzFile');
    el.hidden = false;
    el.textContent = `${f.name} · ${(f.size / 1048576).toFixed(2)} MB`;
  },

  // ---------- submit / prepare ----------
  async submit() {
    this.dryRun = $('#dryRun').checked;
    const side = this.getSide();
    const branch = this.getBranch();
    let url, body, headers;

    if (this.mode === 'upload') {
      if (!this.file) return this.toastErr('Choose a .jar file first.');
      url = `/api/prepare?mode=upload&side=${side}&branch=${branch}&filename=${encodeURIComponent(this.file.name)}`;
      body = this.file;
    } else if (this.mode === 'url') {
      const v = $('#urlInput').value.trim();
      if (!v) return this.toastErr('Enter a jar URL.');
      url = `/api/prepare?mode=url&side=${side}&branch=${branch}`;
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({ url: v });
    } else {
      const v = $('#repoInput').value.trim();
      if (!v) return this.toastErr('Enter a source repo URL.');
      url = `/api/prepare?mode=build&side=${side}&branch=${branch}`;
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({ url: v });
    }

    $('#prepareBtn').disabled = true;
    try {
      const r = await fetch(url, { method: 'POST', headers, body });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      this.openJob(data.jobId, 'mod');
    } catch (e) {
      $('#prepareBtn').disabled = false;
      this.toastErr(e.message);
    }
  },

  async startDelete(id) {
    try {
      const r = await fetch('/api/prepare-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, branch: this.manifestBranch }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      this.openJob(data.jobId, 'delete');
    } catch (e) {
      this.toastErr(e.message);
    }
  },

  // ---------- job lifecycle (SSE) ----------
  openJob(jobId, kind) {
    this.jobId = jobId;
    this.jobKind = kind;
    this.terminated = false;
    this.terminal.innerHTML = '';
    $('#errBanner').hidden = true;
    $('#consoleActions').hidden = true;
    $('#consoleMeta').innerHTML =
      kind === 'delete'
        ? `Removing a mod from <b>${esc(this.manifestBranch)}</b>…`
        : `Preparing <b>${esc(this.mode)}</b> → branch <b>${esc(this.getBranch())}</b>…`;
    $('#phaseRail').hidden = false;
    this.setRail(0, false);
    this.show('console');

    if (this.es) this.es.close();
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    this.es = es;
    es.addEventListener('log', (e) => this.onLog(JSON.parse(e.data)));
    es.addEventListener('status', (e) => this.onStatus(JSON.parse(e.data)));
    es.addEventListener('ready', (e) => this.onReady(JSON.parse(e.data)));
    es.addEventListener('done', (e) => this.onDone(JSON.parse(e.data)));
    es.addEventListener('error', (e) => {
      if (e.data) this.onError(JSON.parse(e.data));
      // network errors without data: EventSource will auto-retry; ignore.
    });
  },

  onLog({ line, stream }) {
    const div = document.createElement('div');
    let cls = 'ln';
    if (stream === 'err') cls += ' err';
    else if (/^\$\s/.test(line)) cls += ' cmd';
    else if (/^(Fabric mod|sha256|Build produced|Selected|Syncing|Downloaded|Resolved)/.test(line)) cls += ' sys';
    div.className = cls;
    div.textContent = line || ' ';
    this.terminal.appendChild(div);
    this.terminal.scrollTop = this.terminal.scrollHeight;
  },

  onStatus({ status, phase }) {
    const map = {
      upload: [0, false], download: [0, false], build: [0, false], fetch: [0, false],
      validate: [1, false], diff: [2, false], ready: [2, true],
      commit: [3, false], done: [4, true],
    };
    if (phase && map[phase]) this.setRail(map[phase][0], map[phase][1]);
    if (status === 'committing') $('#consoleMeta').innerHTML = `Committing &amp; pushing to <b>${esc(this.currentBranch())}</b>…`;
  },

  onReady(preview) {
    this.preview = preview;
    this.setRail(2, true);
    this.renderPreview(preview);
    this.show('preview');
  },

  onDone(result) {
    this.terminated = true;
    if (this.es) this.es.close();
    this.setRail(4, true);
    this.renderDone(result);
    this.show('done');
    this.loadManifest();
  },

  onError({ message, detail }) {
    this.terminated = true;
    if (this.es) this.es.close();
    $('#prepareBtn').disabled = false;
    $('#errTitle').textContent = message;
    const dt = $('#errDetail');
    if (detail && detail !== 'gradle-build-failure' && !/^\s*$/.test(detail) && detail.length < 4000 && /\n|push|denied|fatal|error/i.test(detail)) {
      dt.textContent = detail;
      dt.hidden = false;
    } else {
      dt.hidden = true;
    }
    $('#errBanner').hidden = false;
    $('#consoleActions').hidden = false;
    this.show('console');
  },

  currentBranch() {
    return this.preview ? this.preview.branch : this.getBranch();
  },

  setRail(idx, finished) {
    $$('#phaseRail .ph').forEach((el, i) => {
      el.classList.remove('active', 'done');
      if (i < idx) el.classList.add('done');
      else if (i === idx) el.classList.add(finished ? 'done' : 'active');
    });
  },

  // ---------- confirm ----------
  async confirm() {
    $('#confirmBtn').disabled = true;
    $('#consoleActions').hidden = true;
    $('#errBanner').hidden = true;
    $('#consoleMeta').innerHTML = `Committing &amp; pushing to <b>${esc(this.currentBranch())}</b>…`;
    this.setRail(3, false);
    this.show('console');
    try {
      const r = await fetch(`/api/jobs/${this.jobId}/confirm`, { method: 'POST' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      // results arrive over the (still open) SSE stream
    } catch (e) {
      $('#confirmBtn').disabled = false;
      this.onError({ message: e.message, detail: '' });
    }
  },

  // ---------- rendering: preview ----------
  renderPreview(p) {
    if (p.kind === 'delete') return this.renderDeletePreview(p);

    const warns = [];
    if (p.hasPlaceholder)
      warns.push(this.callout('danger', '!', `The mod id/version contains an unresolved <code>\${...}</code> placeholder. This is almost certainly an unprocessed dev jar — pushing it will break the manifest.`));
    if (p.idConflict)
      warns.push(this.callout('warn', '⟳', `A mod with id <code>${esc(p.idConflict.id)}</code> already exists (version <b>${esc(p.idConflict.oldVersion || '?')}</b>). Its entry will be <b>replaced</b>${p.idConflict.replacesFile ? ` and the old jar <code>${esc(p.idConflict.replacesFile)}</code> will be deleted from the repo` : ''}.`));
    if (p.mcWarning)
      warns.push(this.callout('warn', '⚠', esc(p.mcWarning)));

    const filesHtml =
      `<div class="filechips">` +
      p.filesAdded.map((f) => `<span class="filechip add"><span class="g">+</span>${esc(f)}</span>`).join('') +
      p.filesRemoved.map((f) => `<span class="filechip del"><span class="g">−</span>${esc(f)}</span>`).join('') +
      `</div>`;

    $('#previewBody').innerHTML = `
      <div class="pv-section">
        <div class="pv-h">index.json entry <span class="tag ${p.action}">${p.action === 'add' ? 'NEW' : 'UPDATE'}</span></div>
        <div class="codeblock">
          <button class="copy-btn" id="copyEntry">copy</button>
          <pre>${this.hlJson(p.entry)}</pre>
        </div>
      </div>
      ${warns.length ? `<div class="pv-section">${warns.join('')}</div>` : ''}
      <div class="pv-section">
        <div class="pv-h">files at repo root</div>
        ${filesHtml}
      </div>
      <div class="pv-section">
        <div class="pv-h">index.json diff <span class="tag update">${p.modCount.before} → ${p.modCount.after} mods</span></div>
        ${this.renderDiff(p.diff)}
      </div>
      ${this.callout('info', 'i', `Target branch <b>${esc(p.branch)}</b> · nothing is pushed until you confirm.`)}
    `;

    $('#copyEntry').addEventListener('click', (e) => {
      navigator.clipboard.writeText(JSON.stringify(p.entry, null, 2));
      e.target.textContent = 'copied';
      setTimeout(() => (e.target.textContent = 'copy'), 1200);
    });

    // dry-run: hide push button
    const cb = $('#confirmBtn');
    cb.disabled = false;
    if (this.dryRun) {
      cb.hidden = true;
      $('#previewBody').insertAdjacentHTML(
        'beforeend',
        this.callout('info', '◑', `<b>Dry-run.</b> This is a preview only — the push button is hidden. Re-run without dry-run to publish.`)
      );
    } else {
      cb.hidden = false;
      cb.innerHTML = `Confirm &amp; push to ${esc(p.branch)} <i>↥</i>`;
    }
  },

  renderDeletePreview(p) {
    $('#confirmBtn').hidden = false;
    $('#confirmBtn').disabled = false;
    $('#confirmBtn').innerHTML = `Confirm removal &amp; push <i>↥</i>`;
    $('#previewBody').innerHTML = `
      ${this.callout('danger', '🗑', `This removes <code>${esc(p.removed.id)}</code> (v${esc(p.removed.version)}) and its jar from branch <b>${esc(p.branch)}</b>.`)}
      <div class="pv-section">
        <div class="pv-h">entry being removed <span class="tag remove">REMOVE</span></div>
        <div class="codeblock"><pre>${this.hlJson(p.removed)}</pre></div>
      </div>
      <div class="pv-section">
        <div class="pv-h">files removed</div>
        <div class="filechips">${p.filesRemoved.map((f) => `<span class="filechip del"><span class="g">−</span>${esc(f)}</span>`).join('') || '<span class="readout">none</span>'}</div>
      </div>
      <div class="pv-section">
        <div class="pv-h">index.json diff <span class="tag update">${p.modCount.before} → ${p.modCount.after} mods</span></div>
        ${this.renderDiff(p.diff)}
      </div>
    `;
  },

  renderDiff(diff) {
    if (!diff || !diff.length) return `<div class="diff"><div class="row ctx" style="padding:10px 14px">(no changes)</div></div>`;
    const rows = diff
      .map((d) => {
        const sign = d.type === 'add' ? '+' : d.type === 'del' ? '−' : ' ';
        return `<div class="row ${d.type}"><span class="g">${sign}</span>${esc(d.text)}</div>`;
      })
      .join('');
    return `<div class="diff">${rows}</div>`;
  },

  // ---------- rendering: done ----------
  renderDone(result) {
    if (this.jobKind === 'delete') return this.renderDeleteDone(result);

    if (result.noop) {
      $('#doneBody').innerHTML = `
        <div class="done-hero">
          <div class="done-mark" style="border-color:var(--blue);color:var(--blue)">=</div>
          <h3>Already up to date</h3>
          <p>The repo already contained this exact entry — nothing to commit.</p>
        </div>`;
      return;
    }
    const e = result.entry;
    const hashShort = result.hash ? result.hash.slice(0, 10) : '—';
    $('#doneBody').innerHTML = `
      <div class="done-hero">
        <div class="done-mark">✓</div>
        <h3>Pushed to ${esc(result.branch)}</h3>
        <p>${esc(e.id)} <b>${esc(e.version)}</b> is live in the manifest.</p>
      </div>
      <dl class="kv">
        <dt>commit</dt><dd>${result.url ? `<a href="${esc(result.url)}" target="_blank" rel="noopener">${esc(hashShort)} ↗</a>` : `<span class="hashpill">${esc(hashShort)}</span>`}</dd>
        <dt>branch</dt><dd>${esc(result.branch)}</dd>
        <dt>file</dt><dd>${esc(e.file)}</dd>
        <dt>side</dt><dd>${esc(e.side)}</dd>
        <dt>sha256</dt><dd style="font-size:11px">${esc(e.sha256)}</dd>
      </dl>`;
  },

  renderDeleteDone(result) {
    if (result.noop) {
      $('#doneBody').innerHTML = `<div class="done-hero"><div class="done-mark" style="border-color:var(--blue);color:var(--blue)">=</div><h3>Nothing removed</h3><p>That mod id was not present.</p></div>`;
      return;
    }
    const hashShort = result.hash ? result.hash.slice(0, 10) : '—';
    $('#doneBody').innerHTML = `
      <div class="done-hero">
        <div class="done-mark" style="border-color:var(--red);color:var(--red)">✓</div>
        <h3>Removed from ${esc(result.branch)}</h3>
        <p><b>${esc(result.removed.id)}</b> and its jar were deleted.</p>
      </div>
      <dl class="kv">
        <dt>commit</dt><dd>${result.url ? `<a href="${esc(result.url)}" target="_blank" rel="noopener">${esc(hashShort)} ↗</a>` : `<span class="hashpill">${esc(hashShort)}</span>`}</dd>
        <dt>branch</dt><dd>${esc(result.branch)}</dd>
      </dl>`;
  },

  // ---------- manifest ----------
  async loadManifest() {
    const list = $('#modList');
    list.innerHTML = `<div class="empty"><div class="big spin">⟳</div>loading ${esc(this.manifestBranch)}…</div>`;
    try {
      const r = await fetch(`/api/mods?branch=${encodeURIComponent(this.manifestBranch)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      this.renderManifest(data.mods || []);
    } catch (e) {
      list.innerHTML = `<div class="empty"><div class="big">⚠</div>${esc(e.message)}</div>`;
    }
  },

  renderManifest(mods) {
    const list = $('#modList');
    if (!mods.length) {
      list.innerHTML = `<div class="empty"><div class="big">∅</div>no mods on this branch yet</div>`;
      return;
    }
    list.innerHTML = mods
      .map(
        (m) => `
      <div class="mod">
        <div class="id">${esc(m.id)}</div>
        <div class="right">
          <span class="side-badge ${esc(m.side)}">${esc(m.side || '?')}</span>
          <button class="trash" data-id="${esc(m.id)}" title="remove ${esc(m.id)}">🗑</button>
        </div>
        <div class="ver">v${esc(m.version)}</div>
        <div class="file">${esc(m.file)}</div>
      </div>`
      )
      .join('');
  },

  async checkAccess() {
    const dot = $('[data-keydot]');
    const txt = $('[data-keytext]');
    dot.className = 'dot checking';
    txt.textContent = 'checking…';
    try {
      const r = await fetch('/api/health');
      const data = await r.json();
      if (data.ok) {
        dot.className = 'dot ok';
        txt.textContent = `access ok · ${data.branches.length} branches`;
      } else {
        dot.className = 'dot bad';
        txt.textContent = 'access denied';
        this.toastErr(data.error || 'Deploy-key access check failed.');
      }
    } catch (e) {
      dot.className = 'dot bad';
      txt.textContent = 'check failed';
      this.toastErr(e.message);
    }
  },

  // ---------- misc ----------
  reset() {
    if (this.es) this.es.close();
    this.es = null;
    this.jobId = null;
    this.preview = null;
    this.file = null;
    $('#dzFile').hidden = true;
    $('#fileInput').value = '';
    $('#urlInput').value = '';
    $('#repoInput').value = '';
    $('#prepareBtn').disabled = false;
    $('#confirmBtn').disabled = false;
    $('#confirmBtn').hidden = false;
    $('#phaseRail').hidden = true;
    this.show('form');
  },

  show(screen) {
    $$('.op .screen').forEach((s) => (s.hidden = s.dataset.screen !== screen));
  },

  callout(kind, icon, html) {
    return `<div class="callout ${kind}"><span class="ic">${icon}</span><span>${html}</span></div>`;
  },

  hlJson(obj) {
    const json = esc(JSON.stringify(obj, null, 2));
    // String token that also consumes escaped entities (&amp; &lt; &gt; &quot; &#39;)
    // so values containing &, <, >, ', " still highlight correctly.
    const STR = '&quot;(?:&(?:amp|lt|gt|quot|#39);|[^&])*?&quot;';
    return json
      .replace(new RegExp(`(${STR})(\\s*:)`, 'g'), '<span class="json-key">$1</span>$2')
      .replace(new RegExp(`(:\\s*)(${STR})`, 'g'), '$1<span class="json-str">$2</span>');
  },

  toastErr(msg) {
    // lightweight inline error in the form actions readout
    const ro = $('#branchReadout');
    if (ro) {
      ro.innerHTML = `<span style="color:var(--red)">✕ ${esc(msg)}</span>`;
      setTimeout(() => this.updateBranchReadout(), 4000);
    } else {
      alert(msg);
    }
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
