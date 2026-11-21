// Tableau blanc collaboratif — logique front.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

const PALETTE = ['#1f2937', '#3b82f6', '#dc2626', '#16a34a', '#f59e0b', '#9333ea', '#0891b2', '#ec4899'];
const NAMES = ['Renard', 'Loutre', 'Hibou', 'Lynx', 'Panda', 'Koala', 'Dauphin', 'Colibri', 'Tortue', 'Hérisson'];

const ROOM = (() => {
  const url = new URL(location.href);
  let room = url.searchParams.get('room');
  if (!room || !/^[a-zA-Z0-9_-]{1,64}$/.test(room)) {
    room = Math.random().toString(36).slice(2, 8);
    url.searchParams.set('room', room);
    history.replaceState(null, '', url);
  }
  return room;
})();

const me = {
  name: localStorage.getItem('wb-name') || NAMES[Math.floor(Math.random() * NAMES.length)],
  color: localStorage.getItem('wb-color') || PALETTE[1 + Math.floor(Math.random() * (PALETTE.length - 1))],
  id: null,
};
localStorage.setItem('wb-name', me.name);
localStorage.setItem('wb-color', me.color);

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
const state = {
  objects: new Map(), // id -> objet
  drafts: new Map(), // user -> trait en cours (des autres)
  users: [],
  view: { tx: 0, ty: 0, scale: 1 },
  tool: 'pen',
  color: PALETTE[0],
  width: 3,
  fontSize: 24,
  selected: null,
  undo: [],
  redo: [],
};

const canvas = $('#board');
const ctx = canvas.getContext('2d');
const overlay = $('#overlay');
const cursorsEl = $('#cursors');
const selectionEl = $('#selection');
const editor = $('#editor');
const stage = $('#stage');
const hint = $('#hint');

let dpr = window.devicePixelRatio || 1;

// ---------------------------------------------------------------------------
// Réseau
// ---------------------------------------------------------------------------
let ws = null;
let reconnectDelay = 500;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = new URLSearchParams({ room: ROOM, name: me.name, color: me.color });
  ws = new WebSocket(`${proto}//${location.host}/ws?${q}`);
  $('#status').hidden = false;
  $('#status').textContent = 'Connexion…';

  ws.onopen = () => {
    reconnectDelay = 500;
    $('#status').hidden = true;
  };
  ws.onclose = () => {
    $('#status').hidden = false;
    $('#status').textContent = 'Déconnecté — reconnexion…';
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    handleMessage(msg);
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'init':
      me.id = msg.you;
      state.objects.clear();
      overlay.replaceChildren();
      for (const obj of msg.objects) state.objects.set(obj.id, obj);
      state.users = msg.users;
      renderUsers();
      requestRender();
      if (!initialFitDone) {
        initialFitDone = true;
        fitView();
      }
      break;
    case 'add':
      state.objects.set(msg.obj.id, msg.obj);
      requestRender();
      break;
    case 'update': {
      const obj = state.objects.get(msg.id);
      if (obj) Object.assign(obj, msg.patch);
      if (state.selected === msg.id) updateSelectionBox();
      requestRender();
      break;
    }
    case 'remove':
      for (const id of msg.ids) removeObjectLocal(id);
      requestRender();
      break;
    case 'clear':
      state.objects.clear();
      overlay.replaceChildren();
      selectObject(null);
      requestRender();
      break;
    case 'draft':
      if (msg.points) state.drafts.set(msg.user, msg);
      else state.drafts.delete(msg.user);
      requestRender();
      break;
    case 'cursor':
      updateRemoteCursor(msg);
      break;
    case 'presence':
      state.users = msg.users;
      renderUsers();
      break;
    case 'leave':
      cursorsEl.querySelector(`[data-user="${msg.user}"]`)?.remove();
      state.drafts.delete(msg.user);
      requestRender();
      break;
  }
}
let initialFitDone = false;

// ---------------------------------------------------------------------------
// Opérations (locales + réseau + annulation)
// ---------------------------------------------------------------------------
function removeObjectLocal(id) {
  state.objects.delete(id);
  overlay.querySelector(`[data-id="${id}"]`)?.remove();
  if (state.selected === id) selectObject(null);
}

function applyOp(op, record = true) {
  switch (op.t) {
    case 'add':
      for (const obj of op.objs) {
        state.objects.set(obj.id, obj);
        send({ t: 'add', obj });
      }
      break;
    case 'remove':
      for (const obj of op.objs) removeObjectLocal(obj.id);
      send({ t: 'remove', ids: op.objs.map((o) => o.id) });
      break;
    case 'update': {
      const obj = state.objects.get(op.id);
      if (!obj) return;
      Object.assign(obj, op.after);
      send({ t: 'update', id: op.id, patch: op.after });
      break;
    }
  }
  if (record) recordOp(op);
  requestRender();
}

function recordOp(op) {
  state.undo.push(op);
  if (state.undo.length > 200) state.undo.shift();
  state.redo.length = 0;
  updateUndoButtons();
}

function invert(op) {
  switch (op.t) {
    case 'add': return { t: 'remove', objs: op.objs };
    case 'remove': return { t: 'add', objs: op.objs };
    case 'update': return { t: 'update', id: op.id, before: op.after, after: op.before };
  }
}

function undo() {
  const op = state.undo.pop();
  if (!op) return;
  applyOp(invert(op), false);
  state.redo.push(op);
  updateUndoButtons();
}

function redo() {
  const op = state.redo.pop();
  if (!op) return;
  applyOp(op, false);
  state.undo.push(op);
  updateUndoButtons();
}

function updateUndoButtons() {
  $('#btn-undo').disabled = !state.undo.length;
  $('#btn-redo').disabled = !state.redo.length;
}

// ---------------------------------------------------------------------------
// Vue (pan / zoom)
// ---------------------------------------------------------------------------
function toWorld(sx, sy) {
  const { tx, ty, scale } = state.view;
  return [(sx - tx) / scale, (sy - ty) / scale];
}
function toScreen(wx, wy) {
  const { tx, ty, scale } = state.view;
  return [wx * scale + tx, wy * scale + ty];
}

function zoomAt(sx, sy, factor) {
  const v = state.view;
  const newScale = clamp(v.scale * factor, 0.1, 8);
  const f = newScale / v.scale;
  v.tx = sx - (sx - v.tx) * f;
  v.ty = sy - (sy - v.ty) * f;
  v.scale = newScale;
  requestRender();
}

function contentBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const obj of state.objects.values()) {
    const b = bbox(obj);
    if (!b) continue;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function fitView() {
  const b = contentBounds();
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!b) {
    state.view = { tx: W / 2, ty: H / 2, scale: 1 };
  } else {
    const scale = clamp(Math.min((W - 120) / Math.max(b.w, 1), (H - 120) / Math.max(b.h, 1)), 0.1, 2);
    state.view = {
      scale,
      tx: W / 2 - (b.x + b.w / 2) * scale,
      ty: H / 2 - (b.y + b.h / 2) * scale,
    };
  }
  requestRender();
}

// ---------------------------------------------------------------------------
// Géométrie des objets
// ---------------------------------------------------------------------------
function bbox(obj) {
  switch (obj.type) {
    case 'stroke': {
      const p = obj.points;
      if (p.length < 2) return null;
      let minX = p[0], minY = p[1], maxX = p[0], maxY = p[1];
      for (let i = 2; i < p.length; i += 2) {
        if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
        if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
      }
      const r = obj.width / 2;
      return { x: minX - r, y: minY - r, w: maxX - minX + 2 * r, h: maxY - minY + 2 * r };
    }
    case 'pdf':
      return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
    case 'text': {
      const el = overlay.querySelector(`[data-id="${obj.id}"]`);
      const k = obj.size / 16; // le div est rendu à 16px puis mis à l'échelle
      const w = el ? el.offsetWidth * k : 100;
      const h = el ? el.offsetHeight * k : obj.size * 1.5;
      return { x: obj.x, y: obj.y, w, h };
    }
  }
  return null;
}

function strokeHit(obj, wx, wy, radius) {
  const p = obj.points;
  const r = radius + obj.width / 2;
  if (p.length === 2) return dist(p[0], p[1], wx, wy) <= r;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (segDist(wx, wy, p[i], p[i + 1], p[i + 2], p[i + 3]) <= r) return true;
  }
  return false;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return dist(px, py, ax + t * dx, ay + t * dy);
}

// Rendu du plus haut au plus bas : texte > traits > PDF.
const Z = { pdf: 0, stroke: 1, text: 2 };
function sortedObjects() {
  return [...state.objects.values()].sort((a, b) => (Z[a.type] - Z[b.type]) || ((a.ts || 0) - (b.ts || 0)));
}

function hitTest(wx, wy) {
  const objs = sortedObjects().reverse();
  const tol = 6 / state.view.scale;
  for (const obj of objs) {
    if (obj.type === 'stroke') {
      if (strokeHit(obj, wx, wy, tol)) return obj;
    } else {
      const b = bbox(obj);
      if (b && wx >= b.x - tol && wx <= b.x + b.w + tol && wy >= b.y - tol && wy <= b.y + b.h + tol) return obj;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  requestRender();
}

function render() {
  const { tx, ty, scale } = state.view;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawGrid(W, H);

  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);

  // Zone visible en coordonnées monde (pour ne pas dessiner hors écran)
  const [vx0, vy0] = toWorld(0, 0);
  const [vx1, vy1] = toWorld(W, H);

  const seen = new Set();
  for (const obj of sortedObjects()) {
    const b = bbox(obj);
    if (obj.type === 'text') {
      seen.add(obj.id);
      renderText(obj);
      continue;
    }
    if (b && (b.x > vx1 || b.x + b.w < vx0 || b.y > vy1 || b.y + b.h < vy0)) continue;
    if (obj.type === 'stroke') drawStroke(obj);
    else if (obj.type === 'pdf') drawPdf(obj);
  }
  for (const draft of state.drafts.values()) drawStroke(draft);
  if (currentStroke) drawStroke(currentStroke);

  // Nettoyage des textes supprimés
  for (const el of overlay.children) {
    if (!seen.has(el.dataset.id)) el.remove();
  }

  overlay.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  cursorsEl.style.transform = overlay.style.transform;
  for (const c of cursorsEl.children) c.style.transform = `translate(${c.dataset.x}px, ${c.dataset.y}px) scale(${1 / scale})`;
  updateSelectionBox();
  $('#btn-zoom-fit').textContent = Math.round(scale * 100) + ' %';
}

function drawGrid(W, H) {
  const { tx, ty, scale } = state.view;
  let step = 40;
  while (step * scale < 24) step *= 2;
  while (step * scale > 96) step /= 2;
  const s = step * scale;
  ctx.fillStyle = '#d2d6dc';
  const x0 = ((tx % s) + s) % s, y0 = ((ty % s) + s) % s;
  for (let x = x0; x < W; x += s) {
    for (let y = y0; y < H; y += s) {
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
}

function drawStroke(obj) {
  const p = obj.points;
  if (!p || p.length < 2) return;
  ctx.globalAlpha = obj.opacity ?? 1;
  ctx.strokeStyle = obj.color;
  ctx.lineWidth = obj.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (p.length === 2) {
    ctx.arc(p[0], p[1], obj.width / 2, 0, Math.PI * 2);
    ctx.fillStyle = obj.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  ctx.moveTo(p[0], p[1]);
  if (p.length === 4) {
    ctx.lineTo(p[2], p[3]);
  } else {
    for (let i = 2; i + 3 < p.length; i += 2) {
      const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
      ctx.quadraticCurveTo(p[i], p[i + 1], mx, my);
    }
    ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ----- PDF -----
const pdfDocs = new Map(); // url -> Promise<PDFDocumentProxy>
const pageCache = new Map(); // `${id}@${bucket}` -> canvas | 'pending'

function getPdfDoc(url) {
  if (!pdfDocs.has(url)) pdfDocs.set(url, pdfjsLib.getDocument({ url: new URL(url, location.href).href }).promise);
  return pdfDocs.get(url);
}

function drawPdf(obj) {
  // Résolution adaptée au zoom (par paliers de puissance de 2), plafonnée.
  const wanted = clamp(Math.pow(2, Math.ceil(Math.log2(state.view.scale * dpr))), 0.5, 4);
  const key = `${obj.id}@${wanted}`;
  let img = pageCache.get(key);
  if (!img) {
    pageCache.set(key, 'pending');
    renderPdfPage(obj, wanted).then((c) => {
      pageCache.set(key, c);
      requestRender();
    }).catch(() => pageCache.set(key, 'error'));
  }
  if (!img || img === 'pending' || img === 'error') {
    // Repli : le meilleur rendu déjà disponible
    for (const b of [4, 2, 1, 0.5]) {
      const alt = pageCache.get(`${obj.id}@${b}`);
      if (alt && alt !== 'pending' && alt !== 'error') { img = alt; break; }
    }
  }
  ctx.fillStyle = 'white';
  ctx.shadowColor = 'rgba(0,0,0,.15)';
  ctx.shadowBlur = 12 / state.view.scale;
  ctx.fillRect(obj.x, obj.y, obj.w, obj.h);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  if (img && img !== 'pending' && img !== 'error') {
    ctx.drawImage(img, obj.x, obj.y, obj.w, obj.h);
  } else {
    ctx.fillStyle = '#9ca3af';
    ctx.font = `${Math.max(12, obj.w / 30)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(img === 'error' ? 'PDF indisponible' : 'Chargement…', obj.x + obj.w / 2, obj.y + obj.h / 2);
    ctx.textAlign = 'start';
  }
}

async function renderPdfPage(obj, bucket) {
  const doc = await getPdfDoc(obj.url);
  const page = await doc.getPage(obj.page);
  const vp0 = page.getViewport({ scale: 1 });
  const targetW = Math.min(4096, obj.w * bucket);
  const vp = page.getViewport({ scale: targetW / vp0.width });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c;
}

async function insertPdfFile(file, wx, wy) {
  setHint('Envoi du PDF…');
  try {
    const res = await fetch('/upload', { method: 'POST', body: file, headers: { 'Content-Type': 'application/pdf' } });
    if (!res.ok) throw new Error(await res.text());
    const { url } = await res.json();
    const doc = await getPdfDoc(url);
    const pageW = 800;
    let y = wy;
    const objs = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const h = (pageW * vp.height) / vp.width;
      const obj = { id: uid(), type: 'pdf', url, page: i, x: wx, y, w: pageW, h, ts: Date.now() };
      objs.push(obj);
      y += h + 24;
    }
    applyOp({ t: 'add', objs });
    setHint(`${doc.numPages} page(s) insérée(s)`);
    setTimeout(() => setHint(''), 2500);
  } catch (err) {
    setHint('Échec : ' + err.message);
    setTimeout(() => setHint(''), 4000);
  }
}

// ----- Texte / LaTeX -----
function renderLatexHtml(text) {
  // Découpe $$...$$ (bloc) et $...$ (en ligne) ; le reste est du texte brut.
  const parts = [];
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(escapeHtml(text.slice(last, m.index)));
    const tex = m[1] ?? m[2];
    try {
      parts.push(katex.renderToString(tex, { displayMode: m[1] !== undefined, throwOnError: false }));
    } catch (_) {
      parts.push(`<span style="color:#dc2626">${escapeHtml(m[0])}</span>`);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(escapeHtml(text.slice(last)));
  return parts.join('') || '&nbsp;';
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderText(obj) {
  let el = overlay.querySelector(`[data-id="${obj.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'wb-text';
    el.dataset.id = obj.id;
    overlay.appendChild(el);
  }
  const sig = `${obj.text}|${obj.color}`;
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = renderLatexHtml(obj.text || '');
    el.style.color = obj.color;
  }
  // Rendu à 16px puis mise à l'échelle : KaTeX garde ses proportions.
  el.style.fontSize = '16px';
  el.style.transform = `translate(${obj.x}px, ${obj.y}px) scale(${obj.size / 16})`;
  el.classList.toggle('hidden', editing && editing.id === obj.id);
}

let editing = null; // { id, isNew, x, y }

function openEditor(wx, wy, obj) {
  closeEditor(false);
  editing = obj ? { id: obj.id, isNew: false, x: obj.x, y: obj.y } : { id: uid(), isNew: true, x: wx, y: wy };
  const [sx, sy] = toScreen(editing.x, editing.y);
  editor.style.left = sx + 'px';
  editor.style.top = sy + 'px';
  editor.style.fontSize = Math.max(13, Math.min(28, (obj ? obj.size : state.fontSize) * state.view.scale * 0.8)) + 'px';
  editor.value = obj ? obj.text : '';
  editor.hidden = false;
  editor.focus();
  if (obj) requestRender();
  setHint('Entrée : valider · Maj+Entrée : nouvelle ligne · Échap : annuler · $x^2$ pour du LaTeX');
}

function closeEditor(commit) {
  if (!editing) return;
  const e = editing;
  editing = null;
  editor.hidden = true;
  const text = editor.value.trim();
  if (commit) {
    if (e.isNew) {
      if (text) {
        applyOp({ t: 'add', objs: [{ id: e.id, type: 'text', x: e.x, y: e.y, text, size: state.fontSize, color: state.color, ts: Date.now() }] });
      }
    } else {
      const obj = state.objects.get(e.id);
      if (obj) {
        if (!text) applyOp({ t: 'remove', objs: [obj] });
        else if (text !== obj.text) applyOp({ t: 'update', id: e.id, before: { text: obj.text }, after: { text } });
      }
    }
  }
  setHint('');
  requestRender();
}

editor.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); closeEditor(true); }
  else if (ev.key === 'Escape') { ev.preventDefault(); closeEditor(false); }
  ev.stopPropagation();
});
editor.addEventListener('blur', () => setTimeout(() => { if (editing && !editor.hidden) closeEditor(true); }, 0));

// ---------------------------------------------------------------------------
// Sélection
// ---------------------------------------------------------------------------
function selectObject(id) {
  state.selected = id;
  updateSelectionBox();
}

function updateSelectionBox() {
  const obj = state.selected && state.objects.get(state.selected);
  const b = obj && bbox(obj);
  if (!b) { selectionEl.hidden = true; return; }
  const [sx, sy] = toScreen(b.x, b.y);
  selectionEl.hidden = false;
  selectionEl.style.left = sx - 4 + 'px';
  selectionEl.style.top = sy - 4 + 'px';
  selectionEl.style.width = b.w * state.view.scale + 8 + 'px';
  selectionEl.style.height = b.h * state.view.scale + 8 + 'px';
  selectionEl.querySelector('.handle').hidden = obj.type === 'stroke';
}

function moveObject(obj, dx, dy) {
  if (obj.type === 'stroke') {
    const p = obj.points;
    for (let i = 0; i < p.length; i += 2) { p[i] += dx; p[i + 1] += dy; }
  } else {
    obj.x += dx; obj.y += dy;
  }
}

function snapshot(obj) {
  return obj.type === 'stroke' ? { points: obj.points.slice() } : obj.type === 'pdf'
    ? { x: obj.x, y: obj.y, w: obj.w, h: obj.h } : { x: obj.x, y: obj.y, size: obj.size };
}

// ---------------------------------------------------------------------------
// Pointeur
// ---------------------------------------------------------------------------
let currentStroke = null;
let drag = null; // { kind, ... }
const pointers = new Map(); // pointerId -> {x,y}
let pinch = null;
let spaceDown = false;
let lastDraftSent = 0;

function effectiveTool(ev) {
  if (spaceDown || ev.button === 1) return 'hand';
  return state.tool;
}

canvas.addEventListener('pointerdown', (ev) => {
  if (editing) { closeEditor(true); }
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  // Deux doigts : pincement = pan + zoom
  if (pointers.size === 2) {
    cancelCurrentStroke();
    drag = null;
    const [a, b] = [...pointers.values()];
    pinch = { d: dist(a.x, a.y, b.x, b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    return;
  }
  if (pointers.size > 1) return;

  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  const tool = effectiveTool(ev);

  if (tool === 'hand') {
    drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, tx: state.view.tx, ty: state.view.ty };
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (tool === 'pen' || tool === 'marker') {
    currentStroke = {
      id: uid(), type: 'stroke', points: [wx, wy], color: state.color,
      width: tool === 'marker' ? state.width * 4 : state.width,
      opacity: tool === 'marker' ? 0.35 : 1, ts: Date.now(),
    };
    drag = { kind: 'draw' };
    requestRender();
    return;
  }

  if (tool === 'eraser') {
    drag = { kind: 'erase', removed: [] };
    eraseAt(wx, wy, drag);
    return;
  }

  if (tool === 'text') {
    // Ouvert au relâchement : sinon le focus repart vers le canvas et ferme l'éditeur.
    const hit = hitTest(wx, wy);
    drag = { kind: 'text', wx, wy, hit: hit && hit.type === 'text' ? hit : null };
    return;
  }

  if (tool === 'select') {
    const sel = state.selected && state.objects.get(state.selected);
    if (sel && sel.type !== 'stroke') {
      const b = bbox(sel);
      const [hx, hy] = toScreen(b.x + b.w, b.y + b.h);
      if (dist(ev.clientX, ev.clientY, hx + 4, hy + 4) < 14) {
        drag = { kind: 'resize', obj: sel, before: snapshot(sel), b0: { ...b }, sx: ev.clientX, sy: ev.clientY };
        return;
      }
    }
    const hit = hitTest(wx, wy);
    selectObject(hit ? hit.id : null);
    if (hit) {
      drag = { kind: 'move', obj: hit, before: snapshot(hit), lx: wx, ly: wy, moved: false };
    } else {
      drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, tx: state.view.tx, ty: state.view.ty };
    }
  }
});

canvas.addEventListener('pointermove', (ev) => {
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  // Curseur partagé (limité)
  const now = performance.now();
  if (now - lastCursorSent > 50) {
    lastCursorSent = now;
    send({ t: 'cursor', x: wx, y: wy });
  }

  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = dist(a.x, a.y, b.x, b.y);
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    state.view.tx += cx - pinch.cx;
    state.view.ty += cy - pinch.cy;
    zoomAt(cx, cy, d / pinch.d);
    pinch = { d, cx, cy };
    return;
  }
  if (!drag) {
    if (state.tool === 'select') {
      const hit = hitTest(wx, wy);
      canvas.style.cursor = hit ? 'move' : 'default';
    }
    return;
  }

  switch (drag.kind) {
    case 'pan':
      state.view.tx = drag.tx + ev.clientX - drag.sx;
      state.view.ty = drag.ty + ev.clientY - drag.sy;
      requestRender();
      break;
    case 'draw': {
      const p = currentStroke.points;
      const n = p.length;
      if (dist(p[n - 2], p[n - 1], wx, wy) * state.view.scale < 1.5) return;
      p.push(wx, wy);
      if (now - lastDraftSent > 60) {
        lastDraftSent = now;
        send({ t: 'draft', ...currentStroke });
      }
      requestRender();
      break;
    }
    case 'erase':
      eraseAt(wx, wy, drag);
      break;
    case 'move': {
      const dx = wx - drag.lx, dy = wy - drag.ly;
      if (!drag.moved && Math.hypot(dx, dy) * state.view.scale < 3) return;
      drag.moved = true;
      moveObject(drag.obj, dx, dy);
      drag.lx = wx; drag.ly = wy;
      send({ t: 'update', id: drag.obj.id, patch: snapshot(drag.obj) });
      requestRender();
      break;
    }
    case 'resize': {
      const obj = drag.obj, b0 = drag.b0;
      const f = Math.max(0.05, ((wx - b0.x) / b0.w + (wy - b0.y) / b0.h) / 2);
      if (obj.type === 'pdf') { obj.w = b0.w * f; obj.h = b0.h * f; }
      else obj.size = clamp(drag.before.size * f, 6, 400);
      send({ t: 'update', id: obj.id, patch: snapshot(obj) });
      requestRender();
      break;
    }
  }
});
let lastCursorSent = 0;

function endPointer(ev) {
  pointers.delete(ev.pointerId);
  if (pinch) {
    if (pointers.size < 2) pinch = null;
    return;
  }
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.style.cursor = '';

  switch (d.kind) {
    case 'text':
      if (d.hit) openEditor(0, 0, d.hit);
      else openEditor(d.wx, d.wy, null);
      break;
    case 'draw': {
      const s = currentStroke;
      currentStroke = null;
      send({ t: 'draft', points: null });
      if (s) applyOp({ t: 'add', objs: [s] });
      break;
    }
    case 'erase':
      if (d.removed.length) {
        recordOp({ t: 'remove', objs: d.removed });
      }
      break;
    case 'move':
      if (d.moved) {
        recordOp({ t: 'update', id: d.obj.id, before: d.before, after: snapshot(d.obj) });
      }
      break;
    case 'resize':
      recordOp({ t: 'update', id: d.obj.id, before: d.before, after: snapshot(d.obj) });
      break;
  }
  requestRender();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function cancelCurrentStroke() {
  if (currentStroke) {
    currentStroke = null;
    send({ t: 'draft', points: null });
    requestRender();
  }
}

function eraseAt(wx, wy, d) {
  const radius = Math.max(8, state.width * 2) / state.view.scale;
  for (const obj of state.objects.values()) {
    if (obj.type !== 'stroke') continue;
    if (strokeHit(obj, wx, wy, radius)) {
      d.removed.push(obj);
      removeObjectLocal(obj.id);
      send({ t: 'remove', ids: [obj.id] });
    }
  }
  requestRender();
}

canvas.addEventListener('dblclick', (ev) => {
  if (state.tool !== 'select') return;
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  const hit = hitTest(wx, wy);
  if (hit && hit.type === 'text') openEditor(0, 0, hit);
  else if (!hit) openEditor(wx, wy, null);
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.01));
  } else {
    state.view.tx -= ev.deltaX;
    state.view.ty -= ev.deltaY;
    requestRender();
  }
}, { passive: false });

// Glisser-déposer de PDF
stage.addEventListener('dragover', (ev) => { ev.preventDefault(); stage.classList.add('dragover'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (ev) => {
  ev.preventDefault();
  stage.classList.remove('dragover');
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  let offset = 0;
  for (const file of ev.dataTransfer.files) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      insertPdfFile(file, wx + offset, wy);
      offset += 860;
    }
  }
});
$('#pdf-input').addEventListener('change', (ev) => {
  const [wx, wy] = toWorld(canvas.clientWidth / 2 - 400 * state.view.scale, 80);
  let offset = 0;
  for (const file of ev.target.files) {
    insertPdfFile(file, wx + offset, wy);
    offset += 860;
  }
  ev.target.value = '';
});

// ---------------------------------------------------------------------------
// Curseurs et participants
// ---------------------------------------------------------------------------
function updateRemoteCursor(msg) {
  let el = cursorsEl.querySelector(`[data-user="${msg.user}"]`);
  const user = state.users.find((u) => u.id === msg.user);
  if (!el) {
    el = document.createElement('div');
    el.className = 'cursor';
    el.dataset.user = msg.user;
    el.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-3 6z" stroke="white" stroke-width="1.5"/></svg><span></span>`;
    cursorsEl.appendChild(el);
  }
  const color = user?.color || '#888';
  el.querySelector('path').setAttribute('fill', color);
  el.querySelector('span').textContent = user?.name || '';
  el.querySelector('span').style.background = color;
  el.dataset.x = msg.x;
  el.dataset.y = msg.y;
  el.style.transform = `translate(${msg.x}px, ${msg.y}px) scale(${1 / state.view.scale})`;
}

function renderUsers() {
  const box = $('#users');
  box.replaceChildren();
  for (const u of state.users) {
    const a = document.createElement('div');
    a.className = 'avatar';
    a.style.background = u.color;
    a.textContent = (u.name || '?')[0].toUpperCase();
    a.title = u.name + (u.id === me.id ? ' (moi)' : '');
    box.appendChild(a);
  }
  $('#btn-name').textContent = me.name;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.style.cursor = { hand: 'grab', select: 'default', text: 'text', eraser: 'cell' }[tool] || 'crosshair';
  $('#width').hidden = !(tool === 'pen' || tool === 'marker' || tool === 'eraser');
  $('#font-size').hidden = tool !== 'text';
  $('#colors').hidden = tool === 'eraser' || tool === 'hand' || tool === 'select';
  if (tool !== 'select') selectObject(null);
  setHint({
    pen: '', marker: '',
    eraser: 'Glisser sur un trait pour l’effacer',
    text: 'Cliquer pour écrire · $…$ = LaTeX en ligne · $$…$$ = bloc',
    select: 'Cliquer pour sélectionner, glisser pour déplacer, Suppr pour effacer · double-clic : texte',
    hand: 'Glisser pour déplacer la vue · Ctrl + molette : zoom',
  }[tool] || '');
}

function setHint(text) { hint.textContent = text; }

document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

const colorsEl = $('#colors');
for (const c of PALETTE) {
  const s = document.createElement('div');
  s.className = 'swatch';
  s.style.background = c;
  s.dataset.color = c;
  s.addEventListener('click', () => setColor(c));
  colorsEl.appendChild(s);
}
{
  const custom = document.createElement('label');
  custom.className = 'swatch custom';
  custom.title = 'Couleur personnalisée';
  const input = document.createElement('input');
  input.type = 'color';
  input.addEventListener('input', () => setColor(input.value));
  custom.appendChild(input);
  colorsEl.appendChild(custom);
}
function setColor(c) {
  state.color = c;
  colorsEl.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === c));
  const sel = state.selected && state.objects.get(state.selected);
  if (sel && sel.type !== 'pdf') applyOp({ t: 'update', id: sel.id, before: { color: sel.color }, after: { color: c } });
}
setColor(state.color);

$('#width').addEventListener('input', (ev) => { state.width = Number(ev.target.value); });
$('#font-size').addEventListener('input', (ev) => {
  state.fontSize = Number(ev.target.value);
  const sel = state.selected && state.objects.get(state.selected);
  if (sel && sel.type === 'text') applyOp({ t: 'update', id: sel.id, before: { size: sel.size }, after: { size: state.fontSize } });
});

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-zoom-in').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.25));
$('#btn-zoom-out').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 0.8));
$('#btn-zoom-fit').addEventListener('click', fitView);
$('#btn-clear').addEventListener('click', () => {
  if (!state.objects.size) return;
  if (!confirm('Effacer tout le tableau pour tout le monde ?')) return;
  const objs = [...state.objects.values()];
  state.objects.clear();
  overlay.replaceChildren();
  selectObject(null);
  send({ t: 'clear' });
  recordOp({ t: 'remove', objs });
  requestRender();
});
$('#btn-share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $('#btn-share').textContent = 'Lien copié !';
  } catch (_) {
    prompt('Lien de la salle :', location.href);
  }
  setTimeout(() => ($('#btn-share').textContent = 'Partager'), 1800);
});
$('#btn-name').addEventListener('click', () => {
  const name = prompt('Votre nom :', me.name);
  if (name && name.trim()) {
    me.name = name.trim().slice(0, 24);
    localStorage.setItem('wb-name', me.name);
    ws?.close(); // la reconnexion renvoie le nouveau nom
  }
});
$('#room-label').textContent = 'salle ' + ROOM;

window.addEventListener('keydown', (ev) => {
  if (editing || /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
  if (mod) return;
  switch (ev.key) {
    case ' ':
      if (!spaceDown) { spaceDown = true; canvas.style.cursor = 'grab'; }
      ev.preventDefault();
      break;
    case 'v': case 'V': setTool('select'); break;
    case 'p': case 'P': case 'c': case 'C': setTool('pen'); break;
    case 'h': case 'H': setTool('marker'); break;
    case 'e': case 'E': case 'g': case 'G': setTool('eraser'); break;
    case 't': case 'T': setTool('text'); break;
    case 'm': case 'M': setTool('hand'); break;
    case 'Delete': case 'Backspace': {
      const sel = state.selected && state.objects.get(state.selected);
      if (sel) applyOp({ t: 'remove', objs: [sel] });
      break;
    }
    case 'Escape': selectObject(null); break;
  }
});
window.addEventListener('keyup', (ev) => {
  if (ev.key === ' ') { spaceDown = false; if (!drag) setTool(state.tool); }
});

window.addEventListener('resize', resize);
resize();
setTool('pen');
updateUndoButtons();
connect();
