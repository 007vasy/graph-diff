import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import SpriteText from 'three-spritetext';
import { forceX, forceY, forceZ } from 'd3-force-3d';

const $ = (id) => document.getElementById(id);
const COLORS = {
  added: '#3fb950',
  removed: '#f85149',
  modified: '#e3b341',
  unchanged: '#8b949e',
  file: '#58a6ff',
  folder: '#a371f7',
};
const HOVER_PATCH_LINES = 40;
/** Static export (GitHub Pages etc.): data comes from JSON files next to the page instead of the local server. */
const STATIC = !!window.GRAPH_DIFF_STATIC;
const api = {
  queue: (refresh) => fetch(STATIC ? 'queue.json' : `/api/queue${refresh ? '?refresh=1' : ''}`),
  graph: (key) => (STATIC ? fetch(`graph-${state.queue.findIndex((p) => p.key === key)}.json`) : fetch(`/api/graph?key=${encodeURIComponent(key)}`)),
  status: (key) => fetch(`/api/status?key=${encodeURIComponent(key)}`),
};
const AUTO_LABEL_LIMIT = 120;

const state = {
  queue: [],
  index: 0,
  payload: null,
  depth: 1,
  folders: false,
  labels: false,
  tests: true,
  statuses: new Set(['added', 'modified', 'removed', 'unchanged']),
  changed: [], // changed function nodes in j/k order
  cursor: -1,
  selected: null,
  hovered: null,
  loadToken: 0,
};

// ---------- 3D graph ----------

const graph = new ForceGraph3D($('graph'), { controlType: 'orbit' })
  .backgroundColor('rgba(0,0,0,0)') // CSS gradient shows through
  .showNavInfo(false)
  .warmupTicks(80) // lay out before first paint so the camera can frame it immediately
  .cooldownTime(5000)
  .nodeId('id')
  .nodeLabel((n) => tooltipHtml(n, true))
  .nodeThreeObject((n) => nodeObject(n))
  .linkColor((l) => linkColor(l))
  .linkLabel((l) => linkLabel(l))
  .linkOpacity(0.55)
  .linkWidth((l) => (isAdjacent(l) ? 1.6 : l.type === 'call' && l.status !== 'unchanged' ? 0.8 : 0))
  .linkDirectionalArrowLength((l) => (l.type === 'call' ? 3.2 : 0))
  .linkDirectionalArrowRelPos(1)
  .linkDirectionalArrowColor((l) => linkColor(l))
  .linkDirectionalParticles((l) => (l.type === 'call' && l.status === 'added' ? 2 : 0))
  .linkDirectionalParticleWidth(1.4)
  .linkDirectionalParticleColor(() => COLORS.added)
  .onNodeHover((n) => {
    state.hovered = n;
    $('graph').style.cursor = n ? 'pointer' : '';
    refreshLinks();
  })
  .onNodeClick((n) => select(n, true))
  .onBackgroundClick(() => select(null))
  .onEngineStop(() => {
    if (state.pendingFit && !state.selected) graph.zoomToFit(700, 50);
    state.pendingFit = false;
  });

graph.d3Force('charge').strength(-45).distanceMax(250);
graph.d3Force('link').distance((l) => (l.type === 'contains' ? 18 : 30));
// Gentle pull to the origin keeps disconnected components close, so zoom-to-fit stays readable.
for (const [k, f] of [['x', forceX], ['y', forceY], ['z', forceZ]]) graph.d3Force(k, f(0).strength(0.06));
window.__gd = { graph, state }; // debugging / e2e hooks

new ResizeObserver(() => {
  const el = $('center');
  graph.width(el.clientWidth).height(el.clientHeight);
}).observe($('center'));

const geometries = {
  sphere: new THREE.SphereGeometry(1, 18, 14),
  module: new THREE.IcosahedronGeometry(1, 0),
  file: new THREE.BoxGeometry(1.6, 1.6, 1.6),
  folder: new THREE.OctahedronGeometry(1.4),
};
const materials = new Map();
function material(color, opacity) {
  const k = `${color}:${opacity.toFixed(2)}`;
  if (!materials.has(k)) {
    materials.set(
      k,
      new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.28, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }),
    );
  }
  return materials.get(k);
}

const glowTextures = new Map();
function glowTexture(color) {
  if (!glowTextures.has(color)) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, color + 'aa');
    grad.addColorStop(0.35, color + '44');
    grad.addColorStop(1, color + '00');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowTextures.set(color, new THREE.CanvasTexture(c));
  }
  return glowTextures.get(color);
}

const ringTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = COLORS.removed;
  g.lineWidth = 5;
  g.beginPath();
  g.arc(32, 32, 27, 0, Math.PI * 2);
  g.stroke();
  return new THREE.CanvasTexture(c);
})();

function nodeRadius(n) {
  if (n.type === 'folder') return 4;
  if (n.type === 'file') return 3.2;
  if (n.status === 'unchanged') return 2;
  return Math.min(9, 3 + Math.sqrt((n.added ?? 0) + (n.removed ?? 0)) * 0.55);
}

function nodeColor(n) {
  if (n.type === 'folder') return COLORS.folder;
  if (n.type === 'file') return COLORS.file;
  return COLORS[n.status];
}

function nodeObject(n) {
  const r = nodeRadius(n);
  const group = new THREE.Group();
  const opacity =
    n.type !== 'function' ? 0.85 : n.status === 'unchanged' ? Math.max(0.22, 0.75 - 0.1 * n.depth) : n.isTest ? 0.7 : 1;
  const geo = n.type === 'function' ? (n.kind === 'module' ? geometries.module : geometries.sphere) : geometries[n.type];
  const mesh = new THREE.Mesh(geo, material(n === state.selected ? '#ffffff' : nodeColor(n), opacity));
  mesh.scale.setScalar(r);
  group.add(mesh);
  if ((n.type === 'function' && n.status !== 'unchanged') || n === state.selected) {
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(n === state.selected ? '#ffffff' : nodeColor(n)), depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }),
    );
    glow.scale.setScalar(r * (n === state.selected ? 6 : 4.5));
    group.add(glow);
  }
  if (n.covered === false) {
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture, depthWrite: false, transparent: true }));
    ring.scale.setScalar(r * 3);
    group.add(ring);
  }
  const showLabel =
    state.labels ||
    n === state.selected ||
    (n.type === 'function' && n.status !== 'unchanged' && state.changedVisible <= AUTO_LABEL_LIMIT) ||
    (n.type === 'folder' && state.folders);
  if (showLabel) {
    const t = new SpriteText(n.label, n.type === 'function' && n.status !== 'unchanged' ? 4.2 : 3, nodeColor(n));
    t.material.depthWrite = false;
    t.fontFace = 'ui-monospace, Menlo, monospace';
    t.position.y = r + 3.5;
    group.add(t);
  }
  return group;
}

function linkColor(l) {
  if (l.type === 'contains') return '#2a3646';
  if (isAdjacent(l)) return '#ffffff';
  if (l.status === 'added') return COLORS.added;
  if (l.status === 'removed') return COLORS.removed;
  return '#5b6573';
}

function linkLabel(l) {
  const name = (x) => {
    const n = typeof x === 'object' ? x : null;
    return esc(n ? (n.type === 'function' ? n.label : n.file) : String(x));
  };
  if (l.type === 'contains') return `<div class="tip"><div class="tip-h"><span class="muted">contains</span><b>${name(l.source)} → ${name(l.target)}</b></div></div>`;
  const what = { added: ['c-added', 'new call — added in this PR'], removed: ['c-removed', 'removed call — existed before this PR'], unchanged: ['muted', 'existing call (unchanged)'] }[l.status];
  return `<div class="tip"><div class="tip-h"><b>${name(l.source)} → ${name(l.target)}</b><span class="${what[0]}">${what[1]}</span></div></div>`;
}

function endId(x) {
  return typeof x === 'object' ? x.id : x;
}
function isAdjacent(l) {
  const n = state.hovered ?? state.selected;
  if (!n) return false;
  return endId(l.source) === n.id || endId(l.target) === n.id;
}
function refreshLinks() {
  graph.linkWidth(graph.linkWidth()).linkColor(graph.linkColor());
}

// ---------- Filtering ----------

function visibleGraph() {
  const p = state.payload;
  if (!p) return { nodes: [], links: [] };
  const fnVisible = (n) =>
    n.depth <= state.depth && state.statuses.has(n.status) && (state.tests || !n.isTest);
  const visible = new Set();
  for (const n of p.nodes) if (n.type === 'function' && fnVisible(n)) visible.add(n.id);
  const links = [];
  if (state.folders) {
    // Files that contain visible functions or are changed (non-code files), then their folder chain.
    const contains = p.links.filter((l) => l.type === 'contains');
    const parent = new Map(contains.map((l) => [l._t, l._s]));
    const files = new Set();
    for (const id of visible) files.add(parent.get(id));
    for (const n of p.nodes) if (n.type === 'file' && n.status !== 'unchanged' && n.depth <= state.depth) files.add(n.id);
    for (let id of files) {
      while (id && !visible.has(id)) {
        visible.add(id);
        id = parent.get(id);
      }
    }
    for (const l of contains) if (visible.has(l._s) && visible.has(l._t)) links.push({ ...l, source: l._s, target: l._t });
  }
  for (const l of p.links)
    if (l.type === 'call' && visible.has(l._s) && visible.has(l._t)) links.push({ ...l, source: l._s, target: l._t });
  const nodes = p.nodes.filter((n) => visible.has(n.id));
  state.changedVisible = nodes.filter((n) => n.type === 'function' && n.status !== 'unchanged').length;
  return { nodes, links };
}

function applyFilter() {
  const g = visibleGraph();
  graph.graphData(g);
  $('counts').textContent = `${g.nodes.length} nodes · ${g.links.length} links visible`;
  document.body.classList.toggle('folders', state.folders);
}

/** Frame the graph as soon as nodes have real positions (a zero-size bbox would zoom the camera inside it). */
function fitWhenLaidOut(token, tries = 0) {
  setTimeout(() => {
    if (token !== state.loadToken) return;
    const bb = graph.getGraphBbox();
    const size = bb ? Math.max(bb.x[1] - bb.x[0], bb.y[1] - bb.y[0], bb.z[1] - bb.z[0]) : 0;
    if (size > 5 || (graph.graphData().nodes.length === 1 && bb)) graph.zoomToFit(400, 50);
    else if (tries < 20) fitWhenLaidOut(token, tries + 1);
  }, 150);
}

function rerenderNodes() {
  graph.nodeThreeObject(graph.nodeThreeObject());
}

// ---------- Tooltip / detail ----------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function patchHtml(n, limit) {
  if (!n.patch?.length) return '';
  const lines = limit ? n.patch.slice(0, limit) : n.patch;
  const rows = lines.map((l) => {
    if (l.t === '@') return `<div class="h"><span class="ln"></span><span class="ln"></span><span class="tx">${esc(l.s)}</span></div>`;
    const cls = l.t === '+' ? 'p' : l.t === '-' ? 'm' : '';
    return `<div class="${cls}"><span class="ln">${l.o ?? ''}</span><span class="ln">${l.n ?? ''}</span><span class="tx">${esc(l.t === ' ' ? ' ' : l.t)} ${esc(l.s)}</span></div>`;
  });
  const more = limit && n.patch.length > limit ? n.patch.length - limit : 0;
  if (more) rows.push(`<div class="more">… ${more} more lines — click the node to pin the full diff</div>`);
  if (n.patchTruncated) rows.push(`<div class="more">… diff truncated</div>`);
  return `<div class="patch">${rows.join('')}</div>`;
}

function covText(n) {
  const parts = [];
  if (n.covered === true) parts.push('<span class="c-added">reached by tests</span>');
  if (n.covered === false) parts.push('<span class="c-removed">no test reaches this</span>');
  if (n.lcov) parts.push(`lcov ${n.lcov.covered}/${n.lcov.total} new lines hit`);
  return parts.join(' · ');
}

function tooltipHtml(n, hover) {
  if (n.type === 'folder') return `<div class="tip"><div class="tip-h"><b>${esc(n.file)}/</b><span class="muted">folder · ${n.status === 'unchanged' ? 'no changes' : 'contains changes'}</span></div></div>`;
  if (n.type === 'file') {
    return `<div class="tip"><div class="tip-h"><b>${esc(n.file)}</b><span class="muted"><span class="badge" style="color:${COLORS[n.status]}">${n.status}</span>${n.added != null ? `<span class="c-added">+${n.added}</span> <span class="c-removed">−${n.removed}</span>` : ''}</span></div></div>`;
  }
  const head = `<div class="tip-h"><b>${esc(n.label)}</b><span class="muted"><span class="badge" style="color:${COLORS[n.status]}">${n.status}</span>${esc(n.file)}:${n.line}${n.isTest ? ' · test' : ''}${n.status !== 'unchanged' ? ` · <span class="c-added">+${n.added}</span> <span class="c-removed">−${n.removed}</span>` : ` · depth ${n.depth}`}${n.degree ? ` · hub (${n.degree} links, not expanded)` : ''}</span>${covText(n) ? `<span class="muted">${covText(n)}</span>` : ''}</div>`;
  return `<div class="tip">${head}${patchHtml(n, hover ? HOVER_PATCH_LINES : 0)}</div>`;
}

function githubLink(n) {
  const pr = state.payload?.pr;
  if (!pr?.owner || !n.file) return null;
  const sha = n.status === 'removed' ? pr.baseSha : pr.headSha;
  return `https://github.com/${pr.owner}/${pr.repo}/blob/${sha}/${n.file}${n.line ? `#L${n.line}` : ''}`;
}

function select(n, fly = false) {
  const prev = state.selected;
  state.selected = n;
  if (prev !== n) rerenderNodes();
  refreshLinks();
  if (!n) {
    $('detail').hidden = true;
    renderChanges();
    return;
  }
  const link = githubLink(n);
  $('detail-title').innerHTML = link ? `<a href="${link}" target="_blank" style="color:inherit">${esc(n.file)}${n.line ? ':' + n.line : ''} ↗</a>` : esc(n.label);
  $('detail-body').innerHTML = tooltipHtml(n, false).replace('class="tip"', 'class="tip" style="border:0;box-shadow:none;background:none"');
  $('detail').hidden = false;
  const i = state.changed.indexOf(n);
  if (i >= 0) state.cursor = i;
  renderChanges();
  if (fly) focusNode(n);
}

function focusNode(n) {
  if (n.x === undefined) return;
  const dist = 140;
  const r = Math.hypot(n.x, n.y, n.z) || 1;
  const k = 1 + dist / r;
  graph.cameraPosition({ x: n.x * k, y: n.y * k, z: n.z * k }, n, 800);
}

function cycle(delta) {
  const list = state.changed.filter((n) => graph.graphData().nodes.includes(n));
  if (!list.length) return;
  let i = list.indexOf(state.selected);
  i = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
  select(list[i], true);
  document.querySelector('#changes li.active')?.scrollIntoView({ block: 'nearest' });
}

// ---------- Side panels ----------

function renderStats() {
  const s = state.payload.stats;
  $('s-files').textContent = s.filesChanged;
  $('s-add').textContent = '+' + s.linesAdded.toLocaleString();
  $('s-del').textContent = '−' + s.linesRemoved.toLocaleString();
  const fnTotal = s.fnAdded + s.fnModified + s.fnRemoved;
  $('s-fn').innerHTML = `${fnTotal}`;
  $('s-fnbar').innerHTML = fnTotal
    ? ['added', 'modified', 'removed']
        .map((k) => {
          const v = s[`fn${k[0].toUpperCase()}${k.slice(1)}`];
          return `<i style="width:${(100 * v) / fnTotal}%;background:${COLORS[k]}" title="${v} ${k}"></i>`;
        })
        .join('')
    : '';
  $('s-edges').innerHTML = `<span><span class="c-added">+${s.fnAdded}</span> / <span class="c-modified">~${s.fnModified}</span> / <span class="c-removed">−${s.fnRemoved}</span> fns</span><span>calls <span class="c-added">+${s.edgesAdded}</span> <span class="c-removed">−${s.edgesRemoved}</span></span>`;

  const c = s.coverage;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
  const meter = (p) => `<div class="meter"><i style="width:${p ?? 0}%;background:${p == null ? 'transparent' : p >= 80 ? COLORS.added : p >= 50 ? COLORS.modified : COLORS.removed}"></i></div>`;
  const sp = pct(c.staticCovered, c.staticTotal);
  let html = `<div class="cov" title="Changed (non-test) functions reachable from any test via the call graph"><div class="row"><span>Test reach (static)</span><b>${sp == null ? 'n/a' : sp + '%'}</b></div>${meter(sp)}<div class="small muted">${c.staticCovered} / ${c.staticTotal} changed functions reached by tests</div></div>`;
  if (c.lcov) {
    const lp = pct(c.lcov.coveredLines, c.lcov.totalLines);
    html += `<div class="cov" title="${esc(c.lcov.source)}"><div class="row"><span>Line coverage (lcov, new lines)</span><b>${lp == null ? 'n/a' : lp + '%'}</b></div>${meter(lp)}<div class="small muted">${c.lcov.coveredLines} / ${c.lcov.totalLines} instrumented added lines hit</div></div>`;
  } else html += `<div class="small muted">Pass <code>--coverage lcov.info</code> for line coverage.</div>`;
  $('s-cov').innerHTML = html;

  $('langs').innerHTML = Object.entries(s.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span>${esc(k)} <b>${v}</b></span>`)
    .join('');
  const t = state.payload.timings ?? {};
  $('perf').textContent = `parsed ${s.parsedFiles.head.toLocaleString()} files (head) · ${s.skippedFiles.toLocaleString()} skipped · ${t.cacheHit != null ? 'cached' : `${(s.analysisMs / 1000).toFixed(1)}s`}`;
}

function renderChanges() {
  $('changes').innerHTML = state.changed
    .map(
      (n, i) =>
        `<li data-i="${i}" class="${n === state.selected ? 'active' : ''}" title="${esc(n.file)}:${n.line}"><i class="dot ${n.status}"></i><span class="nm">${esc(n.label)}</span><span class="pm">+${n.added} −${n.removed}${n.covered === false ? ' <span class="c-removed">◯</span>' : ''}</span></li>`,
    )
    .join('');
}

function renderFiles() {
  $('files').innerHTML = state.payload.files
    .map(
      (f) =>
        `<li data-path="${esc(f.path)}" title="${esc(f.oldPath ? f.oldPath + ' → ' : '')}${esc(f.path)}"><i class="dot ${f.status === 'renamed' ? 'modified' : f.status}"></i><span class="nm">${esc(f.path)}</span><span class="pm"><span class="c-added">+${f.added}</span> <span class="c-removed">−${f.removed}</span></span></li>`,
    )
    .join('');
}

function renderHeader() {
  const pr = state.payload?.pr ?? state.queue[state.index];
  $('title').innerHTML = pr.url ? `<a href="${pr.url}" target="_blank">${esc(pr.title)}</a>` : esc(pr.title);
  const bits = [pr.key];
  if (pr.author) bits.push('@' + pr.author);
  if (pr.baseRef) bits.push(`${pr.baseRef} ← ${pr.headRef}`);
  if (pr.baseSha) bits.push(`${pr.baseSha.slice(0, 7)}…${pr.headSha.slice(0, 7)}`);
  $('meta').textContent = bits.join('  ·  ');
}

function renderQueue(statuses = {}) {
  $('queue').innerHTML = state.queue
    .map(
      (p, i) =>
        `<li data-i="${i}" class="${i === state.index ? 'active' : ''}"><div class="q-key"><i class="st ${statuses[p.key] ?? ''}"></i><span>${esc(p.key)}</span>${p.isDraft ? ' <span class="draft">draft</span>' : ''}</div><div class="q-title">${esc(p.title)}</div>${p.author ? `<div class="q-author">@${esc(p.author)}</div>` : ''}</li>`,
    )
    .join('');
  $('pos').textContent = $('mpos').textContent = `${state.index + 1} / ${state.queue.length}`;
  $('mprev').disabled = state.index <= 0;
  $('mnext').disabled = state.index >= state.queue.length - 1;
  $('prev').disabled = state.index <= 0;
  $('next').disabled = state.index >= state.queue.length - 1;
}

async function pollStatuses() {
  try {
    if (STATIC) return renderQueue();
    const s = await (await fetch('/api/statuses')).json();
    renderQueue(s);
  } catch {}
}

// ---------- Loading ----------

async function loadPr(index) {
  if (index < 0 || index >= state.queue.length) return;
  state.index = index;
  const pr = state.queue[index];
  const token = ++state.loadToken;
  location.hash = encodeURIComponent(pr.key);
  renderQueue();
  document.querySelector('#queue li.active')?.scrollIntoView({ block: 'nearest' });
  state.payload = null;
  renderHeader();
  select(null);
  $('error').hidden = true;
  $('empty').hidden = true;
  $('loading').hidden = false;
  $('loadmsg').textContent = 'Loading…';
  const poll = setInterval(async () => {
    if (STATIC) return;
    const s = await (await api.status(pr.key)).json();
    if (token === state.loadToken && s.message) $('loadmsg').textContent = s.message;
  }, 350);
  try {
    const res = await api.graph(pr.key);
    const body = await res.json();
    if (token !== state.loadToken) return;
    if (!res.ok) throw new Error(body.error);
    for (const l of body.links) {
      l._s = l.source;
      l._t = l.target;
    }
    state.payload = body;
    Object.assign(state.queue[index], { title: body.pr.title, author: body.pr.author, url: body.pr.url, isDraft: body.pr.isDraft });
    state.changed = body.nodes
      .filter((n) => n.type === 'function' && n.status !== 'unchanged')
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    state.cursor = -1;
    state.pendingFit = true;
    renderHeader();
    renderStats();
    renderChanges();
    renderFiles();
    const codeChanges = state.changed.length;
    $('empty').hidden = codeChanges > 0;
    if (!codeChanges) {
      $('empty').innerHTML = `No function-level changes in supported languages.<br><span class="small">${body.stats.filesChanged} file(s) changed — shown in the file / folder layer. Press <kbd>n</kbd> for the next PR.</span>`;
      if (!state.folders) $('folders').checked = state.folders = true;
    }
    applyFilter();
    fitWhenLaidOut(token);
  } catch (e) {
    if (token !== state.loadToken) return;
    $('error').textContent = `Failed to analyse ${pr.key}:\n${e.message}`;
    $('error').hidden = false;
    graph.graphData({ nodes: [], links: [] });
  } finally {
    clearInterval(poll);
    if (token === state.loadToken) $('loading').hidden = true;
    pollStatuses();
  }
}

// ---------- Controls ----------

function setDepth(d) {
  state.depth = Math.max(0, Math.min(6, d));
  $('depth').value = state.depth;
  $('depth-val').textContent = state.depth;
  applyFilter();
}

$('depth').addEventListener('input', (e) => setDepth(Number(e.target.value)));
$('folders').addEventListener('change', (e) => {
  state.folders = e.target.checked;
  applyFilter();
});
$('labels').addEventListener('change', (e) => {
  state.labels = e.target.checked;
  rerenderNodes();
});
$('tests').addEventListener('change', (e) => {
  state.tests = e.target.checked;
  applyFilter();
});
for (const cb of document.querySelectorAll('[data-status]')) {
  cb.addEventListener('change', () => {
    if (cb.checked) state.statuses.add(cb.dataset.status);
    else state.statuses.delete(cb.dataset.status);
    applyFilter();
  });
}
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return e.target.blur();
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  const nodes = graph.graphData().nodes;
  const hits = nodes.filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
  if (!hits.length) return void ($('counts').textContent = `no visible match for “${q}” (try a larger depth)`);
  const i = (hits.indexOf(state.selected) + 1) % hits.length;
  select(hits[i], true);
  $('counts').textContent = `match ${i + 1} / ${hits.length}`;
});
$('changes').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const n = state.changed[Number(li.dataset.i)];
  if (!graph.graphData().nodes.includes(n)) {
    state.statuses.add(n.status);
    document.querySelector(`[data-status="${n.status}"]`).checked = true;
    applyFilter();
  }
  setTimeout(() => select(n, true), 50);
});
$('files').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const path = li.dataset.path;
  if (e.metaKey || e.ctrlKey) {
    const pr = state.payload.pr;
    if (pr.url) window.open(`${pr.url}/files`, '_blank');
    return;
  }
  const n = state.changed.find((x) => x.file === path) ?? (state.folders && graph.graphData().nodes.find((x) => x.id === `file:${path}`));
  if (n) select(n, true);
});
$('detail-close').addEventListener('click', () => select(null));
$('help-btn').addEventListener('click', () => ($('help').hidden = !$('help').hidden));
// Legend: open on first visit, then remember the viewer's choice.
const legendKey = 'graph-diff:legend-collapsed';
const setLegend = (collapsed) => {
  $('legend').classList.toggle('collapsed', collapsed);
  $('legend-toggle').textContent = collapsed ? 'Legend ▸' : 'Legend ▾';
  try {
    localStorage.setItem(legendKey, collapsed ? '1' : '0');
  } catch {}
};
try {
  setLegend(localStorage.getItem(legendKey) === '1');
} catch {
  setLegend(false);
}
$('legend-toggle').addEventListener('click', () => setLegend(!$('legend').classList.contains('collapsed')));
$('prev').addEventListener('click', () => loadPr(state.index - 1));
$('mprev').addEventListener('click', () => loadPr(state.index - 1));
$('mnext').addEventListener('click', () => loadPr(state.index + 1));
$('next').addEventListener('click', () => loadPr(state.index + 1));
$('queue').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) loadPr(Number(li.dataset.i));
});
$('refresh').addEventListener('click', async () => {
  const cur = state.queue[state.index]?.key;
  const q = await (await api.queue(true)).json();
  state.queue = q.queue;
  const i = state.queue.findIndex((p) => p.key === cur);
  if (i >= 0) state.index = i;
  pollStatuses();
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input[type=search], input[type=text]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const actions = {
    n: () => loadPr(state.index + 1),
    p: () => loadPr(state.index - 1),
    j: () => cycle(1),
    k: () => cycle(-1),
    ']': () => setDepth(state.depth + 1),
    '[': () => setDepth(state.depth - 1),
    f: () => $('folders').click(),
    l: () => $('labels').click(),
    '/': () => $('search').focus(),
    Escape: () => {
      $('help').hidden = true;
      select(null);
    },
    '?': () => ($('help').hidden = !$('help').hidden),
    z: () => graph.zoomToFit(600, 50),
  };
  const fn = actions[e.key];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

// ---------- Boot ----------

(async () => {
  const q = await (await api.queue()).json();
  state.queue = q.queue;
  if (STATIC) document.body.classList.add('static');
  if (STATIC && state.queue.length === 1) document.body.classList.add('single');
  setDepth(q.initialDepth ?? 1);
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const hashIndex = state.queue.findIndex((p) => p.key === fromHash);
  await loadPr(hashIndex >= 0 ? hashIndex : q.index);
  setInterval(pollStatuses, 2000);
})();
