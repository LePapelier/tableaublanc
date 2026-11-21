// Tableau blanc collaboratif, 100 % statique : synchronisation pair-à-pair (WebRTC via Trystero),
// LaTeX (KaTeX), PDF (pdf.js), sauvegarde locale (IndexedDB).
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { joinRoom } from './vendor/trystero.js';
import { normalizePreamble, translateProoftrees, BUILTIN_PACKAGES, EMULATED_PACKAGES } from './latex-extras.mjs';
import { connectMqtt } from './mqtt-lite.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

const PALETTE = ['#1f2937', '#3b82f6', '#dc2626', '#16a34a', '#f59e0b', '#9333ea', '#0891b2', '#ec4899'];
const NAMES = ['Renard', 'Loutre', 'Hibou', 'Lynx', 'Panda', 'Koala', 'Dauphin', 'Colibri', 'Tortue', 'Hérisson'];
const APP_ID = 'tableaublanc.whiteboard.v1';

const PAGE_URL = new URL(location.href);
const ROOM = (() => {
  let room = PAGE_URL.searchParams.get('room');
  if (!room || !/^[a-zA-Z0-9_-]{1,64}$/.test(room)) {
    room = Math.random().toString(36).slice(2, 8);
    PAGE_URL.searchParams.set('room', room);
    history.replaceState(null, '', PAGE_URL);
  }
  return room;
})();
document.title = `Salle ${ROOM} · Tableau blanc`;
const RELAYS = PAGE_URL.searchParams.get('relay'); // relais Nostr personnalisés, séparés par des virgules
// Serveurs TURN : indispensables quand les deux réseaux interdisent la connexion directe (4G, box stricte,
// réseau d'entreprise). Par défaut : le service public gratuit Open Relay ; remplaçable via ?turn=…&turnuser=…&turnpass=…
const TURN_SERVERS = PAGE_URL.searchParams.get('turn')
  ? [{ urls: PAGE_URL.searchParams.get('turn').split(','), username: PAGE_URL.searchParams.get('turnuser') || '', credential: PAGE_URL.searchParams.get('turnpass') || '' }]
  : [{
    urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443?transport=tcp'],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  }];

// Relais de secours : brokers MQTT publics sur WebSocket, utilisés pour les participants que WebRTC n'atteint pas.
const MQTT_BROKERS = (PAGE_URL.searchParams.get('mqtt') || 'wss://broker.emqx.io:8084/mqtt,wss://broker.hivemq.com:8884/mqtt,wss://test.mosquitto.org:8081/mqtt')
  .split(',').map((u) => u.trim()).filter(Boolean);

const me = {
  uid: localStorage.getItem('wb-uid') || uid(), // identité stable de ce navigateur (droits d'accès)
  rid: uid(), // identité sur le relais de secours (stable pour la session)
  name: localStorage.getItem('wb-name') || NAMES[Math.floor(Math.random() * NAMES.length)],
  color: localStorage.getItem('wb-color') || PALETTE[1 + Math.floor(Math.random() * (PALETTE.length - 1))],
  id: null,
};
localStorage.setItem('wb-name', me.name);
localStorage.setItem('wb-color', me.color);
localStorage.setItem('wb-uid', me.uid);

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
const state = {
  objects: new Map(), // id -> objet
  tombstones: new Map(), // id supprimé -> date (évite la résurrection lors des fusions)
  drafts: new Map(), // peerId -> trait en cours (des autres)
  view: { tx: 0, ty: 0, scale: 1 },
  tool: 'pen',
  color: PALETTE[0],
  width: 4,
  fontSize: 24,
  selected: new Set(), // ids sélectionnés
  preamble: '', // préambule LaTeX partagé (macros)
  access: null, // droits : { leader, mode: 'open' | 'restricted', writers: { uid: true } }
  undo: [],
  redo: [],
};
const files = new Map(); // fileId -> ArrayBuffer (PDF, images)
const isRect = (obj) => obj.type === 'pdf' || obj.type === 'image';

const canvas = $('#board');
const ctx = canvas.getContext('2d');
const overlay = $('#overlay');
const cursorsEl = $('#cursors');
const selectionEl = $('#selection');
const selbar = $('#selbar');
const marqueeEl = $('#marquee');
const editor = $('#editor');
const stage = $('#stage');
const hint = $('#hint');
const statusEl = $('#status');

let dpr = window.devicePixelRatio || 1;

// ---------------------------------------------------------------------------
// Sauvegarde locale (IndexedDB)
// ---------------------------------------------------------------------------
const db = new Promise((resolve) => {
  // Safari laisse parfois une ouverture IndexedDB en suspens : on n'attend pas plus de 3 s.
  const timer = setTimeout(() => resolve(null), 3000);
  let req;
  try { req = indexedDB.open('tableaublanc', 1); } catch (_) { clearTimeout(timer); return resolve(null); }
  req.onupgradeneeded = () => {
    req.result.createObjectStore('rooms');
    req.result.createObjectStore('files');
  };
  req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
  req.onerror = () => { clearTimeout(timer); resolve(null); };
  req.onblocked = () => { clearTimeout(timer); resolve(null); };
});

async function idbGet(store, key) {
  const d = await db;
  if (!d) return undefined;
  return new Promise((resolve) => {
    const r = d.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(undefined);
  });
}
async function idbPut(store, key, value) {
  const d = await db;
  if (!d) return;
  try { d.transaction(store, 'readwrite').objectStore(store).put(value, key); } catch (_) { /* quota ou base fermée */ }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const cutoff = Date.now() - 7 * 86400e3;
    for (const [id, t] of state.tombstones) if (t < cutoff) state.tombstones.delete(id);
    idbPut('rooms', ROOM, { objects: [...state.objects.values()], tombstones: [...state.tombstones], preamble: state.preamble, access: state.access });
  }, 800);
}

async function loadLocal() {
  const saved = await idbGet('rooms', ROOM);
  if (!saved) return;
  for (const [id, t] of saved.tombstones || []) state.tombstones.set(id, t);
  if (saved.preamble) applyPreamble(saved.preamble, { broadcast: false, save: false });
  if (saved.access && saved.access.leader && !state.access) setAccess(saved.access, { broadcast: false, save: false });
  mergeObjects(saved.objects || [], null);
}

// ---------------------------------------------------------------------------
// Réseau pair-à-pair
// ---------------------------------------------------------------------------
let room = null;
let actions = null;
let profile = null;
let preambleState = null; // état partagé du préambule (synchronisé aux retardataires)
let accessState = null; // état partagé des droits
const peerUsers = new Map(); // peerId -> userId

function setStatus(text, kind = '') {
  statusEl.hidden = !text;
  statusEl.textContent = text || '';
  statusEl.className = kind;
}

function peerIds() {
  return room ? Object.keys(room.getPeers()) : [];
}

// Indicateur de connexion : pastille à côté des participants.
const net = { relay: 'connecting', peers: 0, lastError: '' };
function renderNetStatus() {
  const dot = $('#users .avatar.me .status');
  if (!dot) return;
  const viaRelay = relayOnlyPeers().length;
  const relayUp = relay.clients.some((c) => c.isOpen);
  let cls = 'connecting', title = 'Connexion aux relais de mise en relation…';
  if (net.relay === 'offline') { cls = 'error'; title = 'Hors ligne'; }
  else if (net.peers > 0 || viaRelay > 0) {
    cls = 'online';
    title = `En ligne · ${net.peers + viaRelay} autre(s) participant(s)` + (viaRelay ? ` dont ${viaRelay} via le relais de secours` : '');
  } else if (net.relay === 'error') { cls = relayUp ? 'ready' : 'error'; title = (relayUp ? 'Relais de secours prêt. ' : '') + 'Mise en relation WebRTC injoignable : ' + net.lastError; }
  else if (net.relay === 'ready' || relayUp) { cls = 'ready'; title = 'Prêt : personne d’autre dans la salle pour l’instant. Partagez le lien.'; }
  if (net.lastError && cls === 'online') title += ' · ' + net.lastError;
  dot.className = 'status ' + cls;
  $('#users').title = title;
  net.title = title;
}

function connect() {
  const config = { appId: APP_ID, identity: 'none', turnConfig: TURN_SERVERS };
  if (RELAYS) config.relayConfig = { urls: RELAYS.split(',').map((s) => s.trim()).filter(Boolean) };
  relayStart();
  try {
    room = joinRoom(config, ROOM);
  } catch (err) {
    setStatus('WebRTC indisponible : ' + err.message + (crypto.subtle ? ' · relais de secours seul' : ''), 'warn');
    return;
  }

  actions = {
    op: room.makeAction('op'),
    draft: room.makeAction('draft'),
    cursor: room.makeAction('cursor'),
    sync: room.makeAction('sync', { kind: 'request' }),
    file: room.makeAction('file', { kind: 'request' }),
    digest: room.makeAction('digest', { kind: 'request' }),
    fetch: room.makeAction('fetch', { kind: 'request' }),
  };
  profile = room.makeUserState('profile', { name: 'Anonyme', color: '#9ca3af', uid: '' });
  profile.set({ name: me.name, color: me.color, uid: me.uid }).catch(() => {});
  accessState = room.makeState('access', null, {
    // Seul le leader en place peut modifier les droits (ou n'importe qui tant qu'il n'y en a pas).
    validate: (next, ctx) => {
      const cur = state.access;
      if (!cur || !cur.leader || ctx.peerId === me.id) return true;
      const uid = uidOfPeer(ctx.peerId);
      return !uid || uid === cur.leader;
    },
  });
  accessState.onChange((value) => {
    if (value && value.leader && JSON.stringify(value) !== JSON.stringify(state.access)) setAccess(value, { broadcast: false });
  });
  preambleState = room.makeState('preamble', '');
  preambleState.onChange((value) => {
    if (typeof value === 'string' && value !== state.preamble) {
      applyPreamble(value, { broadcast: false });
      if (preambleDialog.open) { $('#preamble-text').value = value; setPreambleStatus('Préambule mis à jour par un autre participant.'); }
    }
  });

  room.getSelf().then((self) => { me.id = self.peerId; renderUsers(); relayPresence(); });
  room.ready.then(() => {
    net.relay = 'ready'; renderNetStatus();
    // Salle sans leader connu après quelques secondes : le premier arrivé prend le rôle.
    setTimeout(() => { if (!state.access && !peerIds().length && !relay.peers.size) claimLeader(); }, 2500);
  })
    .catch((err) => { net.relay = 'error'; net.lastError = err.message; renderNetStatus(); setStatus('Relais de mise en relation injoignable : ' + err.message, 'warn'); });
  room.onError((err) => {
    console.warn('Trystero :', err.code, err.message);
    if (err.code === 'relay-failed') {
      net.relay = 'error'; net.lastError = err.message; renderNetStatus();
      setStatus('Relais de mise en relation injoignable. Réseau filtré ? Réessayez ou passez un relais via ?relay=…', 'warn');
    } else if (err.code === 'peer-connect-failed') {
      net.lastError = 'connexion directe impossible avec un participant' + (err.turnConfigured ? '' : ' (pas de TURN)');
      renderNetStatus();
      setStatus(relay.clients.some((c) => c.isOpen)
        ? 'Connexion directe impossible avec un participant : le relais de secours prend le relais.'
        : 'Connexion impossible avec un participant : son réseau ou le vôtre bloque WebRTC, même via TURN.', 'warn');
      setTimeout(() => setStatus(''), 8000);
    } else if (err.code === 'peer-error' || err.code === 'handshake-failed') {
      net.lastError = err.message; renderNetStatus();
    }
  });
  window.addEventListener('online', () => { net.relay = 'connecting'; renderNetStatus(); });
  window.addEventListener('offline', () => { net.relay = 'offline'; renderNetStatus(); });
  renderNetStatus();

  actions.op.onMessage((msg, { peerId }) => handleOp(msg, peerId));
  actions.draft.onMessage((msg, { peerId }) => {
    if (!peerCanWrite(peerId)) return;
    if (msg && msg.points) state.drafts.set(peerId, msg);
    else state.drafts.delete(peerId);
    requestRender();
  });
  actions.cursor.onMessage((msg, { peerId }) => updateRemoteCursor(peerId, msg));
  actions.sync.onRequest(() => ({ objects: [...state.objects.values()], tombstones: [...state.tombstones] }));
  actions.digest.onRequest(() => ({
    revs: Object.fromEntries([...state.objects.values()].map((o) => [o.id, o.rev || 0])),
    tombstones: [...state.tombstones],
  }));
  actions.fetch.onRequest((ids) => (Array.isArray(ids) ? ids.map((id) => state.objects.get(id)).filter(Boolean) : []));
  actions.file.onRequest((fileId) => {
    const buf = files.get(fileId);
    return buf ? new Uint8Array(buf) : null;
  });

  profile.onChange(() => { renderUsers(); applyAccess(); });
  room.onPeerJoin(({ peerId, userId }) => {
    peerUsers.set(peerId, userId);
    setStatus('');
    net.peers = peerIds().length; net.lastError = ''; renderNetStatus();
    renderUsers();
    syncFrom(peerId);
    // Un préambule local jamais publié (salle rouverte seul) est partagé au premier arrivant.
    if (state.preamble && preambleState && !preambleState.get()) preambleState.set(state.preamble).catch(() => {});
    if (state.access && accessState && !accessState.get()) accessState.set(state.access).catch(() => {});
  });
  room.onPeerLeave(({ peerId }) => {
    peerUsers.delete(peerId);
    cursorsEl.querySelector(`[data-user="${peerId}"]`)?.remove();
    state.drafts.delete(peerId);
    net.peers = peerIds().length; renderNetStatus();
    renderUsers();
    requestRender();
  });
}

// Réconciliation avec un pair : on compare les empreintes (id → révision) et on échange ce qui manque,
// dans les deux sens. Utile après un gel de l'onglet (Safari en arrière-plan), une coupure réseau, etc.
async function reconcileWith(peerId) {
  if (!actions) return;
  try {
    const d = await actions.digest.request(null, { target: peerId, timeoutMs: 20000 });
    if (!d || typeof d !== 'object') return;
    const theirs = d.revs || {};
    for (const [id, t] of d.tombstones || []) {
      if (!state.tombstones.has(id)) {
        state.tombstones.set(id, t);
        if (state.objects.has(id)) removeObjectLocal(id);
      }
    }
    const missing = Object.entries(theirs)
      .filter(([id, rev]) => !state.tombstones.has(id) && (!state.objects.has(id) || (state.objects.get(id).rev || 0) < rev))
      .map(([id]) => id);
    if (missing.length) {
      const objs = await actions.fetch.request(missing, { target: peerId, timeoutMs: 60000 });
      mergeObjects(Array.isArray(objs) ? objs : [], peerId);
    }
    const toPush = [...state.objects.values()].filter((o) => !(o.id in theirs) || theirs[o.id] < (o.rev || 0));
    for (const obj of toPush) actions.op.send({ t: 'add', obj }, { target: peerId }).catch(() => {});
    const deadIds = [...state.tombstones.keys()].filter((id) => id in theirs);
    if (deadIds.length) actions.op.send({ t: 'remove', ids: deadIds }, { target: peerId }).catch(() => {});
    scheduleSave();
    requestRender();
  } catch (_) {
    /* pair parti ou injoignable */
  }
}

let reconcileIndex = 0;
function reconcileAll() {
  for (const id of peerIds()) reconcileWith(id);
  for (const rid of relayOnlyPeers()) relaySend({ k: 'sync-req' }, rid);
}
setInterval(() => {
  const ids = peerIds();
  if (!ids.length || document.hidden) return;
  reconcileWith(ids[reconcileIndex++ % ids.length]);
}, 45000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(reconcileAll, 1500); });
window.addEventListener('online', () => setTimeout(reconcileAll, 3000));
// Safari restaure les pages depuis son cache avec des connexions mortes : on repart proprement.
window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });

function broadcast(kind, payload) {
  if (actions && peerIds().length) actions[kind].send(payload).catch(() => {});
  if (relayOnlyPeers().length) {
    const now = performance.now();
    const ephemeral = kind === 'cursor' || (kind === 'draft' && !(payload && payload.end));
    if (ephemeral && now - (relay.lastSent[kind] || 0) < 250) return; // 4 Hz max sur le relais public
    relay.lastSent[kind] = now;
    relaySend({ k: kind, p: payload });
  }
}

async function syncFrom(peerId) {
  try {
    const res = await actions.sync.request(null, { target: peerId, timeoutMs: 60000 });
    if (!res) return;
    for (const [id, t] of res.tombstones || []) {
      if (!state.tombstones.has(id)) state.tombstones.set(id, t);
      if (state.objects.has(id)) removeObjectLocal(id);
    }
    mergeObjects(res.objects || [], peerId);
  } catch (_) {
    /* pair parti entre-temps */
  }
}

function mergeObjects(objs, fromPeer) {
  let changed = false;
  for (const obj of objs) {
    if (!obj || typeof obj.id !== 'string' || state.tombstones.has(obj.id)) continue;
    const cur = state.objects.get(obj.id);
    if (!cur || (obj.rev || 0) > (cur.rev || 0)) {
      state.objects.set(obj.id, obj);
      if (isRect(obj) && fromPeer && !String(fromPeer).startsWith('r:')) fileHints.set(obj.fileId, fromPeer);
      changed = true;
    }
  }
  if (changed) {
    scheduleSave();
    requestRender();
  }
}

function handleOp(msg, peerId) {
  if (!msg || typeof msg !== 'object') return;
  if (!peerCanWrite(peerId)) return; // participant en lecture seule : modification ignorée
  switch (msg.t) {
    case 'add':
      if (msg.obj && typeof msg.obj.id === 'string') state.tombstones.delete(msg.obj.id); // ré-ajout explicite (rétablir)
      mergeObjects([msg.obj], peerId);
      break;
    case 'update': {
      const obj = state.objects.get(msg.id);
      if (!obj || (msg.patch.rev || 0) <= (obj.rev || 0)) return;
      Object.assign(obj, msg.patch);
      if (state.selected.has(msg.id)) updateSelectionBox();
      scheduleSave();
      requestRender();
      break;
    }
    case 'patch':
      for (const it of msg.items || []) {
        const obj = state.objects.get(it.id);
        if (!obj || (it.patch.rev || 0) <= (obj.rev || 0)) continue;
        Object.assign(obj, it.patch);
      }
      updateSelectionBox();
      scheduleSave();
      requestRender();
      break;
    case 'remove':
      for (const id of msg.ids || []) {
        state.tombstones.set(id, Date.now());
        removeObjectLocal(id);
      }
      scheduleSave();
      requestRender();
      break;
    case 'clear':
      for (const id of state.objects.keys()) state.tombstones.set(id, Date.now());
      state.objects.clear();
      overlay.replaceChildren();
      setSelection([]);
      scheduleSave();
      requestRender();
      break;
  }
}

// ---------------------------------------------------------------------------
// Relais de secours (MQTT sur WebSocket, chiffré de bout en bout)
// ---------------------------------------------------------------------------
// Quand WebRTC échoue (réseau restrictif, Safari capricieux), les participants se retrouvent sur un sujet
// MQTT dérivé de la salle. Tout est chiffré en AES-GCM avec une clé dérivée du lien : les brokers publics
// ne voient que du bruit. N'est utilisé pour les données que vers les participants injoignables en WebRTC.
const relay = { clients: [], topic: null, key: null, peers: new Map(), seen: new Set(), seenOrder: [], chunks: new Map(), lastSent: {}, started: false };
const RELAY_CHUNK = 48000; // caractères par message (limites des brokers publics)
const textEnc = new TextEncoder();
const textDec = new TextDecoder();

async function relayStart() {
  if (relay.started || !crypto.subtle || !MQTT_BROKERS.length) return;
  relay.started = true;
  const raw = await crypto.subtle.digest('SHA-256', textEnc.encode(`${APP_ID}:${ROOM}`));
  relay.key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const t = new Uint8Array(await crypto.subtle.digest('SHA-256', textEnc.encode(`topic:${APP_ID}:${ROOM}`)));
  relay.topic = 'tableaublanc/v1/' + [...t.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
  for (const url of MQTT_BROKERS) relayConnect(url, 0);
  setInterval(relayPresence, 15000);
  setInterval(relayPrune, 10000);
  window.addEventListener('pagehide', () => relaySend({ k: 'bye' }));
}

function relayConnect(url, attempt) {
  let client;
  client = connectMqtt(url, {
    onOpen() { client.subscribe(relay.topic); relayPresence(); renderNetStatus(); },
    onMessage(_, bytes) { relayReceive(bytes); },
    onClose() {
      relay.clients = relay.clients.filter((c) => c !== client);
      renderNetStatus();
      if (navigator.onLine !== false) setTimeout(() => relayConnect(url, attempt + 1), Math.min(60000, 2000 * 2 ** attempt));
    },
  });
  relay.clients.push(client);
}

async function relayEncrypt(str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, relay.key, textEnc.encode(str)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}

async function relayPublish(obj) {
  const bytes = await relayEncrypt(JSON.stringify(obj));
  for (const c of relay.clients) if (c.isOpen) c.publish(relay.topic, bytes);
}

function relaySend(msg, to = null) {
  if (!relay.key || !relay.clients.some((c) => c.isOpen)) return;
  const base = { from: me.rid, pid: me.id, to };
  const json = JSON.stringify(msg);
  if (json.length <= RELAY_CHUNK) {
    relayPublish({ ...base, id: uid(), m: msg }).catch(() => {});
    return;
  }
  const cid = uid();
  const n = Math.ceil(json.length / RELAY_CHUNK);
  for (let i = 0; i < n; i++) {
    relayPublish({ ...base, id: uid(), c: cid, i, n, d: json.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK) }).catch(() => {});
  }
}

function relaySeen(id) {
  if (relay.seen.has(id)) return true;
  relay.seen.add(id);
  relay.seenOrder.push(id);
  if (relay.seenOrder.length > 5000) relay.seen.delete(relay.seenOrder.shift());
  return false;
}

async function relayReceive(bytes) {
  let env;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, relay.key, bytes.subarray(12));
    env = JSON.parse(textDec.decode(pt));
  } catch (_) {
    return; // autre salle, autre version, ou bruit
  }
  if (!env || env.from === me.rid || (env.to && env.to !== me.rid) || relaySeen(env.id)) return;
  if (env.c) {
    let entry = relay.chunks.get(env.c);
    if (!entry) { entry = { parts: new Array(env.n), got: 0, at: Date.now() }; relay.chunks.set(env.c, entry); }
    if (entry.parts[env.i] === undefined) { entry.parts[env.i] = env.d; entry.got++; }
    if (entry.got < env.n) return;
    relay.chunks.delete(env.c);
    try { relayHandle(JSON.parse(entry.parts.join('')), env); } catch (_) { /* message corrompu */ }
    return;
  }
  relayHandle(env.m, env);
}

function relayHandle(msg, env) {
  if (!msg || typeof msg !== 'object') return;
  const from = env.from;
  const key = 'r:' + from;
  switch (msg.k) {
    case 'presence': {
      const prev = relay.peers.get(from);
      relay.peers.set(from, { name: msg.p?.name || 'Anonyme', color: msg.p?.color || '#9ca3af', uid: msg.p?.uid || '', pid: env.pid || null, last: Date.now() });
      if (!prev || prev.name !== msg.p?.name || prev.color !== msg.p?.color || prev.pid !== env.pid) { renderUsers(); renderNetStatus(); applyAccess(); }
      if (!prev) {
        relayPresence(); // qu'il nous connaisse tout de suite
        if (relayOnly(from)) relaySend({ k: 'sync-req' }, from);
      }
      break;
    }
    case 'bye':
      relay.peers.delete(from);
      cursorsEl.querySelector(`[data-user="${key}"]`)?.remove();
      state.drafts.delete(key);
      renderUsers(); renderNetStatus(); requestRender();
      break;
    case 'op': handleOp(msg.p, key); break;
    case 'draft':
      if (!peerCanWrite(key)) break;
      if (msg.p && msg.p.points) state.drafts.set(key, msg.p); else state.drafts.delete(key);
      requestRender();
      break;
    case 'access': {
      const cur = state.access;
      const fromUid = relay.peers.get(from)?.uid;
      if (msg.p && msg.p.leader && (!cur || !cur.leader || fromUid === cur.leader)) setAccess(msg.p, { broadcast: false });
      break;
    }
    case 'cursor': updateRemoteCursor(key, msg.p); break;
    case 'sync-req':
      relaySend({ k: 'sync', p: { objects: [...state.objects.values()], tombstones: [...state.tombstones], preamble: state.preamble, access: state.access } }, from);
      break;
    case 'sync': {
      const p = msg.p || {};
      for (const [id, t] of p.tombstones || []) {
        if (!state.tombstones.has(id)) { state.tombstones.set(id, t); if (state.objects.has(id)) removeObjectLocal(id); }
      }
      mergeObjects(p.objects || [], key);
      if (typeof p.preamble === 'string' && p.preamble && !state.preamble) applyPreamble(p.preamble, { broadcast: false });
      if (p.access && p.access.leader && !state.access) setAccess(p.access, { broadcast: false });
      break;
    }
    case 'file-req':
      if (files.has(msg.p)) relaySend({ k: 'file', p: { fileId: msg.p, data: bufToBase64(files.get(msg.p)) } }, from);
      break;
    case 'file': {
      const { fileId, data } = msg.p || {};
      if (!fileId || files.has(fileId) || typeof data !== 'string') break;
      const buf = base64ToBuf(data);
      sha256(buf).then((h) => { if (h === fileId) storeFile(fileId, buf); });
      break;
    }
    case 'preamble':
      if (typeof msg.p === 'string' && msg.p !== state.preamble) applyPreamble(msg.p, { broadcast: false });
      break;
  }
}

function relayOnly(rid) {
  const p = relay.peers.get(rid);
  return !!p && !(p.pid && peerIds().includes(p.pid));
}
function relayOnlyPeers() {
  return [...relay.peers.keys()].filter(relayOnly);
}
function relayPresence() {
  relaySend({ k: 'presence', p: { name: me.name, color: me.color, uid: me.uid } });
}
function relayPrune() {
  const now = Date.now();
  let changed = false;
  for (const [rid, p] of relay.peers) {
    if (now - p.last > 50000) {
      relay.peers.delete(rid);
      cursorsEl.querySelector(`[data-user="r:${rid}"]`)?.remove();
      state.drafts.delete('r:' + rid);
      changed = true;
    }
  }
  for (const [cid, e] of relay.chunks) if (now - e.at > 300000) relay.chunks.delete(cid);
  if (changed) { renderUsers(); renderNetStatus(); requestRender(); }
}

// ---------------------------------------------------------------------------
// Opérations (locales + réseau + annulation)
// ---------------------------------------------------------------------------
function removeObjectLocal(id) {
  state.objects.delete(id);
  overlay.querySelector(`[data-id="${id}"]`)?.remove();
  if (state.selected.delete(id)) updateSelectionBox();
}

function applyOp(op, record = true) {
  if (!iCanWrite()) { warn('Lecture seule : le leader ne vous a pas autorisé à écrire'); return; }
  switch (op.t) {
    case 'add':
      for (const obj of op.objs) {
        state.tombstones.delete(obj.id);
        obj.rev = (obj.rev || 0) + 1;
        state.objects.set(obj.id, obj);
        broadcast('op', { t: 'add', obj });
      }
      break;
    case 'remove':
      for (const obj of op.objs) {
        state.tombstones.set(obj.id, Date.now());
        removeObjectLocal(obj.id);
      }
      broadcast('op', { t: 'remove', ids: op.objs.map((o) => o.id) });
      break;
    case 'update': {
      const obj = state.objects.get(op.id);
      if (!obj) return;
      Object.assign(obj, op.after);
      obj.rev = (obj.rev || 0) + 1;
      broadcast('op', { t: 'update', id: op.id, patch: { ...op.after, rev: obj.rev } });
      break;
    }
    case 'patch': {
      const items = [];
      for (const it of op.items) {
        const obj = state.objects.get(it.id);
        if (!obj) continue;
        restore(obj, it.after);
        obj.rev = (obj.rev || 0) + 1;
        items.push({ id: it.id, patch: { ...it.after, rev: obj.rev } });
      }
      if (items.length) broadcast('op', { t: 'patch', items });
      break;
    }
  }
  if (record) recordOp(op);
  scheduleSave();
  requestRender();
}

// Envoi d'une mise à jour transitoire (déplacement en cours) sans l'enregistrer dans l'historique.
function pushLive(objs) {
  if (!iCanWrite()) return;
  const items = objs.map((obj) => {
    obj.rev = (obj.rev || 0) + 1;
    return { id: obj.id, patch: { ...snapshot(obj), rev: obj.rev } };
  });
  broadcast('op', { t: 'patch', items });
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
    case 'patch': return { t: 'patch', items: op.items.map((it) => ({ id: it.id, before: it.after, after: it.before })) };
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

// Zoom maximal : 4× au doigt (au-delà, on se perd), 6× à la souris.
const MAX_ZOOM = matchMedia('(pointer: coarse)').matches ? 4 : 6;
function zoomAt(sx, sy, factor) {
  const v = state.view;
  const newScale = clamp(v.scale * factor, 0.1, MAX_ZOOM);
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
    case 'image':
      return rotatedBounds(obj.x, obj.y, obj.w, obj.h, obj.rot || 0);
    case 'text': {
      const [w, h] = textSize(obj);
      return rotatedBounds(obj.x, obj.y, w, h, obj.rot || 0);
    }
  }
  return null;
}

function textSize(obj) {
  const el = overlay.querySelector(`[data-id="${obj.id}"]`);
  const k = obj.size / 16; // le div est rendu à 16px puis mis à l'échelle
  return [el ? el.offsetWidth * k : 100, el ? el.offsetHeight * k : obj.size * 1.5];
}

// Coins d'un rectangle (x, y, w, h) tourné de rot autour de (x, y).
function rectCorners(x, y, w, h, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return [[x, y], [x + w * c, y + w * s], [x + w * c - h * s, y + w * s + h * c], [x - h * s, y + h * c]];
}

function rotatedBounds(x, y, w, h, rot) {
  if (!rot) return { x, y, w, h };
  const pts = rectCorners(x, y, w, h, rot);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

// Taille (w, h) et coins d'un objet rectangulaire (texte ou PDF).
function objectRect(obj) {
  const [w, h] = isRect(obj) ? [obj.w, obj.h] : textSize(obj);
  return { w, h, corners: rectCorners(obj.x, obj.y, w, h, obj.rot || 0) };
}

// Le point (wx, wy) est-il dans le rectangle tourné de l'objet (avec une marge) ?
function rectHit(obj, wx, wy, tol) {
  const { w, h } = objectRect(obj);
  const rot = obj.rot || 0;
  const dx = wx - obj.x, dy = wy - obj.y;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return lx >= -tol && lx <= w + tol && ly >= -tol && ly <= h + tol;
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

// Ordre de rendu : PDF en dessous, puis traits, puis textes.
const Z = { pdf: 0, image: 0.5, stroke: 1, text: 2 };
// Profondeur d'un objet : z explicite (menu contextuel), sinon son type puis sa date de création.
function zOf(o) { return o.z ?? (Z[o.type] * 1e13 + (o.ts || 0)); }
function sortedObjects() {
  return [...state.objects.values()].sort((a, b) => zOf(a) - zOf(b));
}

function hitTest(wx, wy, tol = 6 / state.view.scale) {
  const objs = sortedObjects().reverse();
  for (const obj of objs) {
    if (obj.type === 'stroke') {
      if (strokeHit(obj, wx, wy, tol)) return obj;
    } else if (rectHit(obj, wx, wy, tol)) {
      return obj;
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
    else if (obj.type === 'image') drawImageObj(obj);
  }
  for (const draft of state.drafts.values()) drawStroke(draft);
  if (currentStroke) drawStroke(currentStroke);
  if (drag && drag.kind === 'lasso' && drag.pts.length > 4) drawLasso(drag.pts);

  for (const el of [...overlay.children]) {
    if (!seen.has(el.dataset.id)) el.remove();
  }
  // Les textes (DOM) suivent l'ordre de profondeur entre eux
  let idx = 0;
  for (const obj of sortedObjects()) {
    if (obj.type !== 'text') continue;
    const el = overlay.querySelector(`[data-id="${obj.id}"]`);
    if (el && overlay.children[idx] !== el) overlay.insertBefore(el, overlay.children[idx] || null);
    idx++;
  }

  overlay.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  cursorsEl.style.transform = overlay.style.transform;
  for (const c of cursorsEl.children) c.style.transform = `translate(${c.dataset.x}px, ${c.dataset.y}px) scale(${1 / scale})`;
  updateSelectionBox();
  $('#btn-zoom-fit .zoom-value').textContent = Math.round(scale * 100) + ' %';
}

function drawLasso(pts) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
  ctx.fill();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5 / state.view.scale;
  ctx.setLineDash([6 / state.view.scale, 4 / state.view.scale]);
  ctx.stroke();
  ctx.restore();
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
    for (let y = y0; y < H; y += s) ctx.fillRect(x - 1, y - 1, 2, 2);
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

// ---------------------------------------------------------------------------
// PDF : fichiers partagés entre pairs, rendu par page
// ---------------------------------------------------------------------------
const fileHints = new Map(); // fileId -> peerId qui l'a annoncé
const filePending = new Map(); // fileId -> Promise
const pdfDocs = new Map(); // fileId -> Promise<PDFDocumentProxy>
const pageCache = new Map(); // `${id}@${bucket}` -> canvas | 'pending' | 'error'

async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const fileWaiters = new Map(); // fileId -> callback (arrivée par le relais)
function storeFile(fileId, buf) {
  files.set(fileId, buf);
  fileWaiters.get(fileId)?.();
  fileWaiters.delete(fileId);
  idbPut('files', fileId, buf);
  pdfDocs.delete(fileId);
  imageCache.delete(fileId);
  for (const key of [...pageCache.keys()]) {
    const obj = state.objects.get(key.split('@')[0]);
    if (!obj || obj.fileId === fileId) pageCache.delete(key);
  }
  requestRender();
}

// Récupère un PDF manquant : d'abord en local (IndexedDB), sinon auprès des pairs.
function ensureFile(fileId) {
  if (files.has(fileId)) return Promise.resolve(true);
  if (filePending.has(fileId)) return filePending.get(fileId);
  const p = (async () => {
    const local = await idbGet('files', fileId);
    if (local) { storeFile(fileId, local); return true; }
    const hinted = fileHints.get(fileId);
    const candidates = [...new Set([hinted, ...peerIds()].filter(Boolean))];
    for (const peerId of candidates) {
      if (!actions) break;
      try {
        const bytes = await actions.file.request(fileId, { target: peerId, timeoutMs: 120000 });
        if (bytes && bytes.byteLength) {
          const buf = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
          if ((await sha256(buf)) === fileId) { storeFile(fileId, buf); return true; }
        }
      } catch (_) { /* pair suivant */ }
    }
    // Relais de secours : on demande à tous, le premier qui l'a répond.
    if (relay.peers.size) {
      relaySend({ k: 'file-req', p: fileId });
      const ok = await new Promise((resolve) => {
        const timer = setTimeout(() => { fileWaiters.delete(fileId); resolve(false); }, 180000);
        fileWaiters.set(fileId, () => { clearTimeout(timer); resolve(true); });
      });
      if (ok) return true;
    }
    return false;
  })().finally(() => filePending.delete(fileId));
  filePending.set(fileId, p);
  return p;
}

function getPdfDoc(fileId) {
  if (!pdfDocs.has(fileId)) {
    // pdf.js transfère le tampon au worker : on lui passe une copie.
    const data = new Uint8Array(files.get(fileId)).slice();
    pdfDocs.set(fileId, pdfjsLib.getDocument({ data }).promise);
  }
  return pdfDocs.get(fileId);
}

function drawPdf(obj) {
  ctx.save();
  ctx.translate(obj.x, obj.y);
  if (obj.rot) ctx.rotate(obj.rot);
  ctx.fillStyle = 'white';
  ctx.shadowColor = 'rgba(0,0,0,.15)';
  ctx.shadowBlur = 12 / state.view.scale;
  ctx.fillRect(0, 0, obj.w, obj.h);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';

  let img = null;
  if (files.has(obj.fileId)) {
    const wanted = clamp(Math.pow(2, Math.ceil(Math.log2(state.view.scale * dpr))), 0.5, 4);
    const key = `${obj.id}@${wanted}`;
    img = pageCache.get(key);
    if (!img) {
      pageCache.set(key, 'pending');
      renderPdfPage(obj, wanted).then((c) => { pageCache.set(key, c); requestRender(); })
        .catch(() => pageCache.set(key, 'error'));
    }
    if (!img || img === 'pending' || img === 'error') {
      for (const b of [4, 2, 1, 0.5]) {
        const alt = pageCache.get(`${obj.id}@${b}`);
        if (alt && alt !== 'pending' && alt !== 'error') { img = alt; break; }
      }
    }
  } else {
    ensureFile(obj.fileId).then((ok) => { if (!ok) pageCache.set(`${obj.id}@missing`, 'error'); });
  }

  if (img && img !== 'pending' && img !== 'error') {
    ctx.drawImage(img, 0, 0, obj.w, obj.h);
  } else {
    const missing = !files.has(obj.fileId) && pageCache.get(`${obj.id}@missing`) === 'error';
    ctx.fillStyle = '#9ca3af';
    ctx.font = `${Math.max(12, obj.w / 30)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(missing ? 'PDF indisponible (aucun participant ne l’a)' : img === 'error' ? 'PDF illisible' : 'Réception du PDF…', obj.w / 2, obj.h / 2);
    ctx.textAlign = 'start';
  }
  ctx.restore();
}

async function renderPdfPage(obj, bucket) {
  const doc = await getPdfDoc(obj.fileId);
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

const imageCache = new Map(); // fileId -> ImageBitmap | 'pending' | 'error'

function drawImageObj(obj) {
  let img = imageCache.get(obj.fileId);
  if (!img) {
    if (files.has(obj.fileId)) {
      imageCache.set(obj.fileId, 'pending');
      createImageBitmap(new Blob([files.get(obj.fileId)], { type: obj.mime || 'image/png' }))
        .then((bmp) => { imageCache.set(obj.fileId, bmp); requestRender(); })
        .catch(() => imageCache.set(obj.fileId, 'error'));
    } else {
      ensureFile(obj.fileId).then((ok) => { if (!ok) imageCache.set(obj.fileId, 'missing'); });
    }
  }
  ctx.save();
  ctx.translate(obj.x, obj.y);
  if (obj.rot) ctx.rotate(obj.rot);
  if (img && typeof img !== 'string') {
    ctx.drawImage(img, 0, 0, obj.w, obj.h);
  } else {
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(0, 0, obj.w, obj.h);
    ctx.fillStyle = '#9ca3af';
    ctx.font = `${Math.max(12, obj.w / 30)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(img === 'missing' ? 'Image indisponible' : img === 'error' ? 'Image illisible' : 'Réception de l’image…', obj.w / 2, obj.h / 2);
    ctx.textAlign = 'start';
  }
  ctx.restore();
}

async function insertImageFile(file, wx, wy) {
  setHint('Lecture de l’image…');
  try {
    const buf = await file.arrayBuffer();
    const fileId = await sha256(buf);
    const bmp = await createImageBitmap(new Blob([buf], { type: file.type }));
    if (!files.has(fileId)) storeFile(fileId, buf);
    const w = Math.min(800, bmp.width);
    const h = (w * bmp.height) / bmp.width;
    applyOp({ t: 'add', objs: [{ id: uid(), type: 'image', fileId, mime: file.type || 'image/png', x: wx, y: wy, w, h, ts: Date.now() }] });
    bmp.close?.();
    flash('Image insérée');
  } catch (err) {
    warn('Échec : ' + err.message);
  }
}

// Aiguillage PDF / image pour les fichiers déposés, choisis ou collés.
function insertFiles(fileList, wx, wy) {
  if (!iCanWrite()) { warn('Lecture seule : le leader ne vous a pas autorisé à écrire'); return; }
  let offset = 0;
  for (const file of fileList) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) insertPdfFile(file, wx + offset, wy);
    else if (file.type.startsWith('image/')) insertImageFile(file, wx + offset, wy);
    else continue;
    offset += 860;
  }
}

async function insertPdfFile(file, wx, wy) {
  setHint('Lecture du PDF…');
  try {
    const buf = await file.arrayBuffer();
    const fileId = await sha256(buf);
    if (!files.has(fileId)) storeFile(fileId, buf);
    const doc = await getPdfDoc(fileId);
    const pageW = 800;
    let y = wy;
    const objs = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const h = (pageW * vp.height) / vp.width;
      objs.push({ id: uid(), type: 'pdf', fileId, page: i, x: wx, y, w: pageW, h, ts: Date.now() });
      y += h + 24;
    }
    applyOp({ t: 'add', objs });
    setHint('');
  } catch (err) {
    setHint('');
    warn('Échec : ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Texte / LaTeX
// ---------------------------------------------------------------------------
function renderLatexHtml(text) {
  const parts = [];
  // $…$ et \begin{prooftree}…\end{prooftree} en mode bloc, $…$ en ligne.
  const re = /\$\$([\s\S]+?)\$\$|(\\begin\{prooftree\}[\s\S]*?\\end\{prooftree\})|\$([^$\n]+?)\$/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(escapeHtml(text.slice(last, m.index)));
    const tex = translateProoftrees(m[1] ?? m[2] ?? m[3]);
    try {
      parts.push(katex.renderToString(tex, { displayMode: m[3] === undefined, throwOnError: false, macros: katexMacros }));
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
  const sig = `${obj.text}|${obj.color}|${preambleRev}`;
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = renderLatexHtml(obj.text || '');
    el.style.color = obj.color;
  }
  el.style.fontSize = '16px';
  el.style.transform = `translate(${obj.x}px, ${obj.y}px) rotate(${obj.rot || 0}rad) scale(${obj.size / 16})`;
  el.classList.toggle('hidden', editing && editing.id === obj.id);
}

let editing = null; // { id, isNew, x, y }

function openEditor(wx, wy, obj) {
  closeEditor(false);
  editing = obj ? { id: obj.id, isNew: false, x: obj.x, y: obj.y } : { id: uid(), isNew: true, x: wx, y: wy };
  const [sx, sy] = toScreen(editing.x, editing.y);
  editor.style.left = sx + 'px';
  editor.style.top = sy + 'px';
  editor.style.fontSize = Math.max(16, Math.min(28, (obj ? obj.size : state.fontSize) * state.view.scale * 0.8)) + 'px';
  editor.value = obj ? obj.text : '';
  editor.hidden = false;
  editor.focus();
  if (obj) requestRender();

}

function closeEditor(commit) {
  if (!editing) return;
  const e = editing;
  editing = null;
  editor.blur();
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
editor.addEventListener('blur', () => {
  // Fermeture différée liée à la session d'édition courante : un minuteur en retard ne doit pas fermer un éditeur
  // rouvert entre-temps (Chrome peut traiter les événements de souris avant les minuteurs quand la page est occupée).
  const session = editing;
  setTimeout(() => { if (session && editing === session && !editor.hidden) closeEditor(true); }, 0);
});

// ---------------------------------------------------------------------------
// Sélection (plusieurs objets, déplacement, redimensionnement)
// ---------------------------------------------------------------------------
function setSelection(ids) {
  state.selected = new Set(ids);
  updateSelectionBox();
}

function selectedObjects() {
  const out = [];
  for (const id of state.selected) {
    const o = state.objects.get(id);
    if (o) out.push(o); else state.selected.delete(id);
  }
  return out;
}

function unionBounds(objs) {
  let b = null;
  for (const o of objs) {
    const bb = bbox(o);
    if (!bb) continue;
    if (!b) b = { ...bb };
    else {
      const x2 = Math.max(b.x + b.w, bb.x + bb.w), y2 = Math.max(b.y + b.h, bb.y + bb.h);
      b.x = Math.min(b.x, bb.x); b.y = Math.min(b.y, bb.y);
      b.w = x2 - b.x; b.h = y2 - b.y;
    }
  }
  return b;
}

function selectionBounds() {
  const objs = selectedObjects();
  return objs.length ? unionBounds(objs) : null;
}

function updateSelectionBox() {
  const b = selectionBounds();
  if (!b) { selectionEl.hidden = true; selbar.hidden = true; return; }
  const [sx, sy] = toScreen(b.x, b.y);
  const w = b.w * state.view.scale, h = b.h * state.view.scale;
  selectionEl.hidden = false;
  selectionEl.style.left = sx - 4 + 'px';
  selectionEl.style.top = sy - 4 + 'px';
  selectionEl.style.width = w + 8 + 'px';
  selectionEl.style.height = h + 8 + 'px';
  // Barre d'actions au-dessus de la sélection (ou en dessous si pas la place)
  selbar.hidden = (!!drag && drag.kind !== 'none') || !ctxmenu.hidden;
  const bw = selbar.offsetWidth || 160, bh = selbar.offsetHeight || 46;
  const handleTop = sy - 4 - (matchMedia('(pointer: coarse)').matches ? 40 : 30); // haut de la poignée de rotation
  const above = handleTop - 8 - bh;
  const top = above < 70 ? sy + h + 14 : above;
  selbar.style.left = clamp(sx + w / 2 - bw / 2, 8, window.innerWidth - bw - 8) + 'px';
  selbar.style.top = clamp(top, 70, window.innerHeight - 60) + 'px';
}

// Poignée de coin proche du point écran (sx, sy) ; renvoie l'ancre opposée en coordonnées monde.
function cornerAt(sx, sy, tol) {
  const b = selectionBounds();
  if (!b) return null;
  const corners = [
    { c: [b.x, b.y], a: [b.x + b.w, b.y + b.h] },
    { c: [b.x + b.w, b.y], a: [b.x, b.y + b.h] },
    { c: [b.x, b.y + b.h], a: [b.x + b.w, b.y] },
    { c: [b.x + b.w, b.y + b.h], a: [b.x, b.y] },
  ];
  for (const k of corners) {
    const [cx, cy] = toScreen(k.c[0], k.c[1]);
    if (dist(sx, sy, cx, cy) <= tol) return { corner: k.c, anchor: k.a };
  }
  return null;
}

function insideBounds(b, wx, wy, margin = 0) {
  return b && wx >= b.x - margin && wx <= b.x + b.w + margin && wy >= b.y - margin && wy <= b.y + b.h + margin;
}

function snapshot(obj) {
  switch (obj.type) {
    case 'stroke': return { points: obj.points.slice(), width: obj.width };
    case 'pdf': case 'image': return { x: obj.x, y: obj.y, w: obj.w, h: obj.h, rot: obj.rot || 0 };
    default: return { x: obj.x, y: obj.y, size: obj.size, rot: obj.rot || 0 };
  }
}

function restore(obj, snap) {
  for (const [k, v] of Object.entries(snap)) obj[k] = Array.isArray(v) ? v.slice() : v;
}

function moveObject(obj, dx, dy) {
  if (obj.type === 'stroke') {
    const p = obj.points;
    for (let i = 0; i < p.length; i += 2) { p[i] += dx; p[i + 1] += dy; }
  } else {
    obj.x += dx; obj.y += dy;
  }
}

// Homothétie de centre (ax, ay) et de rapport f.
function scaleObject(obj, ax, ay, f) {
  if (obj.type === 'stroke') {
    const p = obj.points;
    for (let i = 0; i < p.length; i += 2) {
      p[i] = ax + (p[i] - ax) * f;
      p[i + 1] = ay + (p[i + 1] - ay) * f;
    }
    obj.width = clamp(obj.width * f, 0.5, 200);
  } else {
    obj.x = ax + (obj.x - ax) * f;
    obj.y = ay + (obj.y - ay) * f;
    if (isRect(obj)) { obj.w *= f; obj.h *= f; }
    else obj.size = clamp(obj.size * f, 6, 400);
  }
}

// Rotation d'angle a autour de (cx, cy).
function rotateObject(obj, cx, cy, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const rot = (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  if (obj.type === 'stroke') {
    const p = obj.points;
    for (let i = 0; i < p.length; i += 2) [p[i], p[i + 1]] = rot(p[i], p[i + 1]);
  } else {
    [obj.x, obj.y] = rot(obj.x, obj.y);
    obj.rot = ((obj.rot || 0) + a) % (2 * Math.PI);
  }
}

// Position écran de la poignée de rotation (au-dessus du centre du cadre).
function rotateHandlePos() {
  const b = selectionBounds();
  if (!b) return null;
  const [sx, sy] = toScreen(b.x + b.w / 2, b.y);
  return [sx, sy - 4 - (matchMedia('(pointer: coarse)').matches ? 30 : 23)];
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Objets capturés par un lasso : traits dont un point est dedans, textes et PDF dont les quatre coins le sont.
function objectsInPolygon(pts) {
  const out = [];
  for (const obj of state.objects.values()) {
    if (obj.type === 'stroke') {
      const p = obj.points;
      for (let i = 0; i < p.length; i += 2) {
        if (pointInPolygon(p[i], p[i + 1], pts)) { out.push(obj); break; }
      }
    } else if (objectRect(obj).corners.every(([x, y]) => pointInPolygon(x, y, pts))) {
      out.push(obj);
    }
  }
  return out;
}

function patchOp(objs, before) {
  return { t: 'patch', items: objs.map((o) => ({ id: o.id, before: before.get(o.id), after: snapshot(o) })) };
}

function deleteSelection() {
  const objs = selectedObjects();
  if (objs.length) applyOp({ t: 'remove', objs });
}

function duplicateSelection() {
  const objs = selectedObjects();
  if (!objs.length) return;
  const off = 24 / state.view.scale;
  const clones = objs.map((o) => {
    const c = JSON.parse(JSON.stringify(o));
    c.id = uid(); c.ts = Date.now(); c.rev = 0;
    moveObject(c, off, off);
    return c;
  });
  applyOp({ t: 'add', objs: clones });
  setSelection(clones.map((c) => c.id));
}

// Objets touchés par un rectangle : traits dont un point est dedans, textes et PDF entièrement contenus.
function objectsInRect(r) {
  const out = [];
  for (const obj of state.objects.values()) {
    if (obj.type === 'stroke') {
      const p = obj.points;
      for (let i = 0; i < p.length; i += 2) {
        if (p[i] >= r.x && p[i] <= r.x + r.w && p[i + 1] >= r.y && p[i + 1] <= r.y + r.h) { out.push(obj); break; }
      }
    } else if (objectRect(obj).corners.every(([x, y]) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) {
      out.push(obj);
    }
  }
  return out;
}

$('#sel-del').addEventListener('click', deleteSelection);
$('#sel-dup').addEventListener('click', duplicateSelection);

// ---------------------------------------------------------------------------
// Menu contextuel de la sélection (clic droit, appui long, bouton ⋯)
// ---------------------------------------------------------------------------
const ctxmenu = $('#ctxmenu');

// Déplace la sélection dans l'ordre de superposition : 'front' | 'back' | 'forward' | 'backward'.
function reorderSelection(mode) {
  const sel = selectedObjects();
  if (!sel.length || !iCanWrite()) return;
  const all = sortedObjects();
  const selIds = new Set(sel.map((o) => o.id));
  const others = all.filter((o) => !selIds.has(o.id));
  const group = all.filter((o) => selIds.has(o.id)); // dans l'ordre actuel
  const n = group.length;
  let newZ = null;
  if (mode === 'front') {
    const top = others.length ? zOf(others[others.length - 1]) : 0;
    newZ = group.map((_, i) => top + 1 + i);
  } else if (mode === 'back') {
    const bottom = others.length ? zOf(others[0]) : 0;
    newZ = group.map((_, i) => bottom - n + i);
  } else if (mode === 'forward') {
    const topSel = zOf(group[n - 1]);
    const i = others.findIndex((o) => zOf(o) > topSel);
    if (i < 0) return; // déjà au premier plan
    const base = zOf(others[i]);
    const next = i + 1 < others.length ? zOf(others[i + 1]) : base + 1;
    newZ = group.map((_, k) => base + ((next - base) * (k + 1)) / (n + 1));
  } else if (mode === 'backward') {
    const bottomSel = zOf(group[0]);
    let i = -1;
    for (let k = others.length - 1; k >= 0; k--) if (zOf(others[k]) < bottomSel) { i = k; break; }
    if (i < 0) return; // déjà à l'arrière-plan
    const base = zOf(others[i]);
    const low = i > 0 ? zOf(others[i - 1]) : base - 1;
    newZ = group.map((_, k) => low + ((base - low) * (k + 1)) / (n + 1));
  }
  if (!newZ) return;
  applyOp({ t: 'patch', items: group.map((o, k) => ({ id: o.id, before: { z: o.z ?? null }, after: { z: newZ[k] } })) });
}

function rotateSelection(angle) {
  const sel = selectedObjects();
  const b = selectionBounds();
  if (!sel.length || !b || !iCanWrite()) return;
  const before = new Map(sel.map((o) => [o.id, snapshot(o)]));
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  for (const o of sel) rotateObject(o, cx, cy, angle);
  applyOp(patchOp(sel, before));
}

function straightenSelection() {
  const sel = selectedObjects().filter((o) => o.type !== 'stroke' && (o.rot || 0) !== 0);
  if (!sel.length || !iCanWrite()) return;
  applyOp({ t: 'patch', items: sel.map((o) => ({ id: o.id, before: { rot: o.rot }, after: { rot: 0 } })) });
}

const CTX_ITEMS = [
  { label: 'Avancer', icon: 'arrowUp', run: () => reorderSelection('forward') },
  { label: 'Reculer', icon: 'arrowDown', run: () => reorderSelection('backward') },
  { label: 'Mettre au premier plan', icon: 'front', run: () => reorderSelection('front') },
  { label: 'Mettre à l’arrière-plan', icon: 'back', run: () => reorderSelection('back') },
  { sep: true },
  { label: 'Pivoter de 90° à droite', icon: 'rotateCw', run: () => rotateSelection(Math.PI / 2) },
  { label: 'Pivoter de 90° à gauche', icon: 'rotateCcw', run: () => rotateSelection(-Math.PI / 2) },
  { label: 'Remettre droit', icon: 'reset', run: straightenSelection, when: () => selectedObjects().some((o) => o.type !== 'stroke' && (o.rot || 0) !== 0) },
  { sep: true },
  { label: 'Dupliquer', icon: 'copy', run: duplicateSelection },
  { label: 'Supprimer', icon: 'trash', danger: true, run: deleteSelection },
];

function openContextMenu(x, y) {
  if (!selectedObjects().length) return;
  ctxmenu.replaceChildren();
  for (const it of CTX_ITEMS) {
    if (it.sep) { ctxmenu.appendChild(Object.assign(document.createElement('span'), { className: 'sep' })); continue; }
    if (it.when && !it.when()) continue;
    const b = document.createElement('button');
    b.className = it.danger ? 'danger' : '';
    b.innerHTML = CTX_ICONS[it.icon] + '<span>' + it.label + '</span>';
    b.addEventListener('click', () => { closeContextMenu(); it.run(); });
    ctxmenu.appendChild(b);
  }
  ctxmenu.hidden = false;
  selbar.hidden = true; // le menu reprend déjà Dupliquer / Supprimer
  const w = ctxmenu.offsetWidth, h = ctxmenu.offsetHeight;
  ctxmenu.style.left = clamp(x, 8, window.innerWidth - w - 8) + 'px';
  ctxmenu.style.top = clamp(y, 8, window.innerHeight - h - 8) + 'px';
}
function closeContextMenu() {
  if (ctxmenu.hidden) return;
  ctxmenu.hidden = true;
  updateSelectionBox(); // réaffiche la barre de sélection s'il y a lieu
}
window.addEventListener('pointerdown', (ev) => { if (!ctxmenu.hidden && !ev.target.closest('#ctxmenu')) closeContextMenu(); });
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeContextMenu(); });
ctxmenu.addEventListener('contextmenu', (ev) => ev.preventDefault());

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  if (!insideBounds(selectionBounds(), wx, wy)) {
    const hit = hitTest(wx, wy);
    if (!hit) { closeContextMenu(); return; }
    if (state.tool !== 'select' && state.tool !== 'lasso') setTool('select');
    setSelection([hit.id]);
  }
  openContextMenu(ev.clientX, ev.clientY);
});
$('#sel-more').addEventListener('click', (ev) => {
  const r = ev.currentTarget.getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 6);
});

const CTX_ICONS = {
  arrowUp: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m5 12 7-7 7 7\" /><path d=\"M12 19V5\" /></svg>",
  arrowDown: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M12 5v14\" /><path d=\"m19 12-7 7-7-7\" /></svg>",
  front: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"8\" y=\"8\" width=\"8\" height=\"8\" rx=\"2\" /><path d=\"M4 10a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2\" /><path d=\"M14 20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2\" /></svg>",
  back: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"14\" y=\"14\" width=\"8\" height=\"8\" rx=\"2\" /><rect x=\"2\" y=\"2\" width=\"8\" height=\"8\" rx=\"2\" /><path d=\"M7 14v1a2 2 0 0 0 2 2h1\" /><path d=\"M14 7h1a2 2 0 0 1 2 2v1\" /></svg>",
  rotateCw: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\" /><path d=\"M21 3v5h-5\" /></svg>",
  rotateCcw: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\" /><path d=\"M3 3v5h5\" /></svg>",
  reset: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\" /><path d=\"M3 3v5h5\" /><path d=\"M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16\" /><path d=\"M16 16h5v5\" /></svg>",
  copy: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" /></svg>",
  trash: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M10 11v6\" /><path d=\"M14 11v6\" /><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\" /><path d=\"M3 6h18\" /><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\" /></svg>",
};

// ---------------------------------------------------------------------------
// Pointeur (souris, doigt, stylet)
// ---------------------------------------------------------------------------
let currentStroke = null;
let drag = null;
const pointers = new Map();
let pinch = null;
let spaceDown = false;
let penDown = false;
let lastDraftSent = 0;
let lastCursorSent = 0;
let lastLiveSent = 0;
let longPress = null; // { timer, x, y }

function cancelLongPress() {
  if (longPress) { clearTimeout(longPress.timer); longPress = null; }
}

function effectiveTool(ev) {
  if (spaceDown || ev.button === 1) return 'hand';
  return state.tool;
}

canvas.addEventListener('pointerdown', (ev) => {
  // Rejet de la paume : un doigt posé pendant qu'un stylet écrit est ignoré.
  if (ev.pointerType === 'touch' && penDown) return;
  if (ev.pointerType === 'pen') penDown = true;
  ev.preventDefault(); // pas d'événements souris synthétiques après un toucher (ils voleraient le focus)
  if (editing) closeEditor(true);
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  if (pointers.size === 2) {
    cancelCurrentStroke();
    if (drag && drag.before) for (const o of drag.objs) restore(o, drag.before.get(o.id)); // annule le geste en cours
    drag = null;
    marqueeEl.hidden = true;
    const [a, b] = [...pointers.values()];
    pinch = { d: dist(a.x, a.y, b.x, b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    requestRender();
    return;
  }
  if (pointers.size > 1) return;

  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  const tool = effectiveTool(ev);
  const touch = ev.pointerType === 'touch';
  const tolPx = touch ? 16 : 6;

  if (tool === 'hand') {
    drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, tx: state.view.tx, ty: state.view.ty };
    canvas.style.cursor = 'grabbing';
    return;
  }

  if ((tool === 'pen' || tool === 'marker' || tool === 'eraser' || tool === 'text') && !iCanWrite()) {
    warn('Lecture seule : le leader ne vous a pas autorisé à écrire');
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
    drag = { kind: 'erase', removed: [], touch };
    eraseAt(wx, wy, drag);
    return;
  }

  if (tool === 'text') {
    // Ouvert au relâchement : sinon le focus repart vers le canvas et ferme l'éditeur.
    const hit = hitTest(wx, wy, tolPx / state.view.scale);
    drag = { kind: 'text', wx, wy, hit: hit && hit.type === 'text' ? hit : null };
    return;
  }

  if ((tool === 'select' || tool === 'lasso') && touch) {
    // Appui long sur un objet : menu contextuel
    const target = insideBounds(selectionBounds(), wx, wy) ? null : hitTest(wx, wy, tolPx / state.view.scale);
    if (target || insideBounds(selectionBounds(), wx, wy)) {
      longPress = { x: ev.clientX, y: ev.clientY, timer: setTimeout(() => {
        longPress = null;
        if (drag && drag.before) for (const o of drag.objs) restore(o, drag.before.get(o.id));
        drag = null;
        if (target) setSelection([target.id]);
        openContextMenu(ev.clientX, ev.clientY);
        requestRender();
      }, 550) };
    }
  }
  if (tool === 'select' || tool === 'lasso') {
    const sel = selectedObjects();
    if (sel.length && iCanWrite()) {
      const rh = rotateHandlePos();
      if (rh && dist(ev.clientX, ev.clientY, rh[0], rh[1]) <= (touch ? 28 : 14)) {
        const b = selectionBounds();
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        drag = { kind: 'rotate', objs: sel, before: new Map(sel.map((o) => [o.id, snapshot(o)])), cx, cy, a0: Math.atan2(wy - cy, wx - cx) };
        selbar.hidden = true;
        return;
      }
      const c = cornerAt(ev.clientX, ev.clientY, touch ? 28 : 14);
      if (c) {
        const before = new Map(sel.map((o) => [o.id, snapshot(o)]));
        drag = { kind: 'resize', objs: sel, before, anchor: c.anchor, d0: Math.max(1e-6, dist(c.corner[0], c.corner[1], c.anchor[0], c.anchor[1])) };
        selbar.hidden = true;
        return;
      }
      if (insideBounds(selectionBounds(), wx, wy, tolPx / state.view.scale)) {
        drag = { kind: 'move', objs: sel, before: new Map(sel.map((o) => [o.id, snapshot(o)])), x0: wx, y0: wy, moved: false };
        return;
      }
    }
    const hit = hitTest(wx, wy, tolPx / state.view.scale);
    if (hit) {
      if (ev.shiftKey) {
        if (state.selected.has(hit.id)) state.selected.delete(hit.id); else state.selected.add(hit.id);
        updateSelectionBox();
      } else if (!state.selected.has(hit.id)) {
        setSelection([hit.id]);
      }
      const objs = selectedObjects();
      drag = iCanWrite() ? { kind: 'move', objs, before: new Map(objs.map((o) => [o.id, snapshot(o)])), x0: wx, y0: wy, moved: false } : null;
    } else {
      const keep = ev.shiftKey ? [...state.selected] : [];
      if (!ev.shiftKey) setSelection([]);
      if (tool === 'lasso') drag = { kind: 'lasso', pts: [wx, wy], keep };
      else drag = { kind: 'marquee', x0: wx, y0: wy, keep, sx: ev.clientX, sy: ev.clientY };
    }
  }
});

canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerType === 'touch' && penDown) return;
  if (longPress && Math.hypot(ev.clientX - longPress.x, ev.clientY - longPress.y) > 8) cancelLongPress();
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  const now = performance.now();
  if (now - lastCursorSent > 50) {
    lastCursorSent = now;
    broadcast('cursor', { x: wx, y: wy });
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
    if ((state.tool === 'select' || state.tool === 'lasso') && ev.pointerType !== 'touch') {
      const rh = rotateHandlePos();
      const c = cornerAt(ev.clientX, ev.clientY, 14);
      canvas.style.cursor = rh && dist(ev.clientX, ev.clientY, rh[0], rh[1]) <= 14 ? 'grab'
        : c ? 'nwse-resize' : insideBounds(selectionBounds(), wx, wy) || hitTest(wx, wy) ? 'move' : state.tool === 'lasso' ? 'crosshair' : 'default';
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
      const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      let added = false;
      for (const e of events.length ? events : [ev]) {
        const [x, y] = toWorld(e.clientX, e.clientY);
        const n = p.length;
        if (dist(p[n - 2], p[n - 1], x, y) * state.view.scale < 1.2) continue;
        p.push(x, y);
        added = true;
      }
      if (!added) return;
      if (now - lastDraftSent > 60) {
        lastDraftSent = now;
        broadcast('draft', currentStroke);
      }
      requestRender();
      break;
    }
    case 'erase':
      eraseAt(wx, wy, drag);
      break;
    case 'lasso': {
      const p = drag.pts;
      if (dist(p[p.length - 2], p[p.length - 1], wx, wy) * state.view.scale >= 2) p.push(wx, wy);
      requestRender();
      break;
    }
    case 'rotate': {
      let a = Math.atan2(wy - drag.cy, wx - drag.cx) - drag.a0;
      if (ev.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); // pas de 15°
      for (const o of drag.objs) { restore(o, drag.before.get(o.id)); rotateObject(o, drag.cx, drag.cy, a); }
      drag.moved = true;
      if (now - lastLiveSent > 80) { lastLiveSent = now; pushLive(drag.objs); }
      requestRender();
      break;
    }
    case 'marquee': {
      const x = Math.min(drag.sx, ev.clientX), y = Math.min(drag.sy, ev.clientY);
      marqueeEl.hidden = false;
      marqueeEl.style.left = x + 'px';
      marqueeEl.style.top = y + 'px';
      marqueeEl.style.width = Math.abs(ev.clientX - drag.sx) + 'px';
      marqueeEl.style.height = Math.abs(ev.clientY - drag.sy) + 'px';
      break;
    }
    case 'move': {
      const dx = wx - drag.x0, dy = wy - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) * state.view.scale < 3) return;
      drag.moved = true;
      selbar.hidden = true;
      for (const o of drag.objs) { restore(o, drag.before.get(o.id)); moveObject(o, dx, dy); }
      if (now - lastLiveSent > 80) { lastLiveSent = now; pushLive(drag.objs); }
      requestRender();
      break;
    }
    case 'resize': {
      const [ax, ay] = drag.anchor;
      const f = Math.max(0.02, dist(wx, wy, ax, ay) / drag.d0);
      for (const o of drag.objs) { restore(o, drag.before.get(o.id)); scaleObject(o, ax, ay, f); }
      drag.moved = true;
      if (now - lastLiveSent > 80) { lastLiveSent = now; pushLive(drag.objs); }
      requestRender();
      break;
    }
  }
});

function endPointer(ev) {
  cancelLongPress();
  if (ev.pointerType === 'pen') penDown = false;
  if (!pointers.has(ev.pointerId)) return;
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
      broadcast('draft', { end: true });
      if (s) applyOp({ t: 'add', objs: [s] });
      break;
    }
    case 'erase':
      if (d.removed.length) recordOp({ t: 'remove', objs: d.removed });
      break;
    case 'marquee': {
      marqueeEl.hidden = true;
      const [wx, wy] = toWorld(ev.clientX, ev.clientY);
      const r = { x: Math.min(d.x0, wx), y: Math.min(d.y0, wy), w: Math.abs(wx - d.x0), h: Math.abs(wy - d.y0) };
      if (r.w * state.view.scale > 4 || r.h * state.view.scale > 4) {
        setSelection([...d.keep, ...objectsInRect(r).map((o) => o.id)]);
      }
      break;
    }
    case 'lasso':
      if (d.pts.length >= 6) setSelection([...d.keep, ...objectsInPolygon(d.pts).map((o) => o.id)]);
      break;
    case 'move':
    case 'resize':
    case 'rotate':
      if (d.moved) applyOp(patchOp(d.objs, d.before));
      break;
  }
  updateSelectionBox();
  requestRender();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function cancelCurrentStroke() {
  if (currentStroke) {
    currentStroke = null;
    broadcast('draft', { end: true });
    requestRender();
  }
}

function eraseAt(wx, wy, d) {
  const radius = Math.max(d.touch ? 14 : 8, state.width * 2) / state.view.scale;
  const hit = [];
  for (const obj of state.objects.values()) {
    if (obj.type === 'stroke' && strokeHit(obj, wx, wy, radius)) hit.push(obj);
  }
  if (hit.length) {
    d.removed.push(...hit);
    applyOp({ t: 'remove', objs: hit }, false);
  }
}

canvas.addEventListener('dblclick', (ev) => {
  if ((state.tool !== 'select' && state.tool !== 'lasso') || !iCanWrite()) return;
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  const hit = hitTest(wx, wy);
  if (hit && hit.type === 'text') openEditor(0, 0, hit);
  else if (!hit && state.tool === 'select') openEditor(wx, wy, null);
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
  insertFiles(ev.dataTransfer.files, wx, wy);
});
$('#pdf-input').addEventListener('change', (ev) => {
  const [wx, wy] = toWorld(canvas.clientWidth / 2 - 400 * state.view.scale, 80);
  insertFiles(ev.target.files, wx, wy);
  ev.target.value = '';
});
// Collage d'une image (Ctrl+V) depuis le presse-papiers
window.addEventListener('paste', (ev) => {
  if (editing || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  const imgs = [...(ev.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
  if (!imgs.length) return;
  ev.preventDefault();
  const [wx, wy] = toWorld(canvas.clientWidth / 2 - 200 * state.view.scale, canvas.clientHeight / 2 - 150 * state.view.scale);
  insertFiles(imgs, wx, wy);
});

// ---------------------------------------------------------------------------
// Leader et droits d'écriture
// ---------------------------------------------------------------------------
// Protection d'usage (classe, atelier) : les clients appliquent les droits et ignorent les modifications des
// participants en lecture seule ; ce n'est pas une garantie cryptographique.
function uidOfPeer(peerKey) {
  if (!peerKey) return me.uid;
  if (String(peerKey).startsWith('r:')) return relay.peers.get(peerKey.slice(2))?.uid || '';
  const userId = peerUsers.get(peerKey) || room?.getPeers()[peerKey]?.userId;
  return (profile && userId && profile.has(userId) && profile.get(userId)?.uid) || '';
}
function canWrite(uid) {
  const a = state.access;
  if (!a || !a.leader || a.mode !== 'restricted') return true;
  return !!uid && (uid === a.leader || !!(a.writers && a.writers[uid]));
}
function iCanWrite() { return canWrite(me.uid); }
function peerCanWrite(peerKey) {
  const a = state.access;
  if (!a || !a.leader || a.mode !== 'restricted') return true;
  return canWrite(uidOfPeer(peerKey));
}
function isLeader() { return !!state.access && state.access.leader === me.uid; }
function leaderPresent() {
  if (!state.access) return false;
  if (isLeader()) return true;
  return peerIds().some((p) => uidOfPeer(p) === state.access.leader) || [...relay.peers.values()].some((p) => p.uid === state.access.leader);
}

function setAccess(access, { broadcast = true, save = true } = {}) {
  state.access = { leader: access.leader, mode: access.mode === 'restricted' ? 'restricted' : 'open', writers: { ...(access.writers || {}) }, names: { ...(access.names || {}) } };
  if (save) scheduleSave();
  if (broadcast) {
    if (accessState) accessState.set(state.access).catch(() => {});
    if (relay.peers.size) relaySend({ k: 'access', p: state.access });
  }
  applyAccess();
}
function claimLeader() {
  setAccess({ leader: me.uid, mode: 'open', writers: {}, names: { [me.uid]: me.name } });
  flash('Vous êtes le leader de la salle');
}
function leaderUpdate(patch) {
  if (!isLeader()) return;
  const a = state.access;
  setAccess({ ...a, ...patch, writers: { ...a.writers, ...(patch.writers || {}) }, names: { ...a.names, ...(patch.names || {}) } });
}

const WRITE_TOOLS = ['pen', 'marker', 'eraser', 'text'];
let lastWriteState = null;
function applyAccess() {
  const can = iCanWrite();
  document.body.classList.toggle('readonly', !can);
  for (const t of WRITE_TOOLS) document.querySelector(`.tool[data-tool="${t}"]`)?.classList.toggle('disabled', !can);
  document.querySelector('.tool.file')?.classList.toggle('disabled', !can);
  if (!can && WRITE_TOOLS.includes(state.tool)) setTool('select');
  if (lastWriteState !== null && lastWriteState !== can) {
    if (!can) warn('Le leader a passé le tableau en lecture seule pour vous', 5000);
  }
  lastWriteState = can;
  renderUsers();
}

// ---------------------------------------------------------------------------
// Curseurs et participants
// ---------------------------------------------------------------------------
function userOf(peerId) {
  if (peerId.startsWith('r:')) {
    const p = relay.peers.get(peerId.slice(2));
    return { name: p?.name || 'Anonyme', color: p?.color || '#9ca3af', viaRelay: true };
  }
  const userId = peerUsers.get(peerId) || room?.getPeers()[peerId]?.userId;
  const p = (profile && userId && profile.has(userId) && profile.get(userId)) || {};
  return { name: p.name || 'Anonyme', color: p.color || '#9ca3af' };
}

function updateRemoteCursor(peerId, msg) {
  if (!msg || typeof msg.x !== 'number') return;
  let el = cursorsEl.querySelector(`[data-user="${peerId}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'cursor';
    el.dataset.user = peerId;
    el.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-3 6z" stroke="white" stroke-width="1.5"/></svg><span></span>`;
    cursorsEl.appendChild(el);
  }
  const user = userOf(peerId);
  el.querySelector('path').setAttribute('fill', user.color);
  el.querySelector('span').textContent = user.name;
  el.querySelector('span').style.background = user.color;
  el.dataset.x = msg.x;
  el.dataset.y = msg.y;
  el.style.transform = `translate(${msg.x}px, ${msg.y}px) scale(${1 / state.view.scale})`;
}

function renderUsers() {
  const box = $('#users');
  box.replaceChildren();
  const list = [{ name: me.name, color: me.color, self: true }, ...peerIds().map(userOf), ...relayOnlyPeers().map((rid) => userOf('r:' + rid))];
  for (const u of list) {
    const a = document.createElement('div');
    a.className = 'avatar' + (u.self ? ' me' : '');
    a.style.background = u.color;
    a.textContent = (u.name || '?')[0].toUpperCase();
    a.title = u.name + (u.self ? ' (moi)' : '');
    if (u.self) a.appendChild(Object.assign(document.createElement('i'), { className: 'status' }));
    box.appendChild(a);
  }
  renderNetStatus();
  if (!net.title) box.title = list.length > 1 ? `${list.length} participants` : 'Participants';
  $('#btn-name').textContent = me.name;
  const ul = $('#users-list');
  ul.replaceChildren();
  const a = state.access;
  const head = document.createElement('li');
  head.className = 'room';
  head.innerHTML = '<span class="label">Salle</span>';
  head.appendChild(Object.assign(document.createElement('code'), { textContent: ROOM }));
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = list.length > 1 ? `${list.length} participants` : 'vous seul·e';
  head.appendChild(count);
  ul.appendChild(head);

  const rows = [{ ...list[0], uid: me.uid }, ...peerIds().map((p) => ({ ...userOf(p), uid: uidOfPeer(p) })), ...relayOnlyPeers().map((rid) => ({ ...userOf('r:' + rid), uid: relay.peers.get(rid)?.uid || '' }))];
  for (const u of rows) {
    const li = document.createElement('li');
    li.className = 'person';
    const av = document.createElement('span');
    av.className = 'av';
    av.style.background = u.color;
    av.textContent = (u.name || '?')[0].toUpperCase();
    const text = document.createElement('span');
    text.className = 'who';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = u.name + (u.self ? ' (moi)' : '');
    const sub = document.createElement('span');
    sub.className = 'sub';
    const isLead = a && a.leader && u.uid === a.leader;
    const w = canWrite(u.uid);
    const parts = [];
    if (isLead) parts.push('leader');
    else if (a && a.mode === 'restricted') parts.push(w ? 'peut écrire' : 'lecture seule');
    if (u.viaRelay) parts.push('via relais');
    sub.textContent = parts.join(' · ');
    text.append(name, sub);
    li.append(av, text);
    const actions = document.createElement('span');
    actions.className = 'actions';
    if (isLead) {
      actions.insertAdjacentHTML('beforeend', '<span class="badge leader" title="Leader de la salle">' + ICONS.crown + '</span>');
    } else if (isLeader() && u.uid) {
      if (a.mode === 'restricted') {
        const b = document.createElement('button');
        b.className = 'badge toggle' + (w ? ' on' : '');
        b.title = w ? 'Peut écrire : passer en lecture seule' : 'Lecture seule : autoriser l’écriture';
        b.innerHTML = w ? ICONS.pencil : ICONS.eye;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); leaderUpdate({ writers: { [u.uid]: !w }, names: { [u.uid]: u.name } }); });
        actions.appendChild(b);
      }
      const t = document.createElement('button');
      t.className = 'badge ghost';
      t.title = 'Transférer le rôle de leader';
      t.innerHTML = ICONS.crown;
      t.addEventListener('click', (ev) => { ev.stopPropagation(); if (confirm(`Faire de ${u.name} le leader de la salle ?`)) leaderUpdate({ leader: u.uid, names: { [u.uid]: u.name }, writers: { [me.uid]: true } }); }); // l'ancien leader garde l'écriture
      actions.appendChild(t);
    } else if (a && a.mode === 'restricted') {
      actions.insertAdjacentHTML('beforeend', `<span class="badge ${w ? 'on' : ''}" title="${w ? 'Peut écrire' : 'Lecture seule'}">${w ? ICONS.pencil : ICONS.eye}</span>`);
    }
    li.appendChild(actions);
    ul.appendChild(li);
  }

  const foot = document.createElement('li');
  foot.className = 'foot';
  if (isLeader()) {
    const restricted = a.mode === 'restricted';
    foot.innerHTML = '<span class="label">Écriture</span>';
    const seg = document.createElement('div');
    seg.className = 'segmented';
    for (const [mode, label] of [['open', 'Tout le monde'], ['restricted', 'Autorisés seulement']]) {
      const b = document.createElement('button');
      b.className = (restricted ? mode === 'restricted' : mode === 'open') ? 'on' : '';
      b.dataset.mode = mode;
      b.textContent = label;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); if (a.mode !== mode) leaderUpdate({ mode }); });
      seg.appendChild(b);
    }
    foot.appendChild(seg);
  } else if (a && a.leader) {
    const leaderName = a.names?.[a.leader] || 'un autre participant';
    foot.innerHTML = `<span class="label">Écriture</span><span class="muted">${a.mode === 'restricted' ? 'sur autorisation' : 'libre'} · leader : ${escapeHtml(leaderName)}</span>`;
    if (!leaderPresent()) {
      const b = document.createElement('button');
      b.className = 'text wide';
      b.innerHTML = ICONS.crown + '<span>Prendre la main</span>';
      b.title = 'Le leader est absent : devenir leader';
      b.addEventListener('click', (ev) => { ev.stopPropagation(); claimLeader(); });
      foot.appendChild(b);
    }
  } else {
    const b = document.createElement('button');
    b.className = 'text wide';
    b.innerHTML = ICONS.crown + '<span>Devenir leader</span>';
    b.addEventListener('click', (ev) => { ev.stopPropagation(); claimLeader(); });
    foot.appendChild(b);
  }
  ul.appendChild(foot);
}
const ICONS = {
  crown: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z\" /><path d=\"M5 21h14\" /></svg>",
  eye: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\" /><circle cx=\"12\" cy=\"12\" r=\"3\" /></svg>",
  pencil: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\" /><path d=\"m15 5 4 4\" /></svg>",
  lock: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\" /><path d=\"M7 11V7a5 5 0 0 1 10 0v4\" /></svg>",
  lockOpen: "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\" /><path d=\"M7 11V7a5 5 0 0 1 9.9-1\" /></svg>",
};
$('#users').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const ul = $('#users-list');
  ul.hidden = !ul.hidden;
  if (!ul.hidden) $('#menu').hidden = true;
});
window.addEventListener('pointerdown', (ev) => { if (!ev.target.closest('#users, #users-list')) $('#users-list').hidden = true; });

// ---------------------------------------------------------------------------
// Préambule LaTeX (macros partagées)
// ---------------------------------------------------------------------------
let katexMacros = {};
let preambleRev = 0;
let mhchemLoading = null;
const preambleDialog = $('#preamble-dialog');

function loadMhchem() {
  if (!mhchemLoading) {
    mhchemLoading = new Promise((resolve) => {
      const el = document.createElement('script');
      el.src = './vendor/katex/mhchem.min.js';
      el.onload = () => { preambleRev++; requestRender(); resolve(true); };
      el.onerror = () => resolve(false);
      document.head.appendChild(el);
    });
  }
  return mhchemLoading;
}

// Applique un préambule : renvoie { error, unsupported }.
function applyPreamble(text, { broadcast = true, save = true } = {}) {
  if (broadcast && !iCanWrite()) { warn('Lecture seule : seuls les participants autorisés modifient le préambule'); return { error: null, unsupported: [] }; }
  state.preamble = text;
  const { body, packages } = normalizePreamble(text);
  const unsupported = [];
  for (const p of packages) {
    if (p === 'mhchem') loadMhchem();
    else if (!BUILTIN_PACKAGES.has(p) && !EMULATED_PACKAGES.has(p)) unsupported.push(p);
  }
  const macros = {};
  let error = null;
  if (body) {
    try {
      katex.renderToString(body, { macros, globalGroup: true, throwOnError: true });
    } catch (err) {
      error = err.message.replace(/^KaTeX parse error: /, '');
    }
  }
  katexMacros = macros;
  preambleRev++;
  if (save) scheduleSave();
  if (broadcast && preambleState) preambleState.set(text).catch(() => {});
  if (broadcast && relayOnlyPeers().length) relaySend({ k: 'preamble', p: text });
  requestRender();
  return { error, unsupported };
}

function setPreambleStatus(text, isError = false) {
  const el = $('#preamble-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function openPreamble() {
  $('#preamble-text').value = state.preamble;
  setPreambleStatus('');
  preambleDialog.showModal();
  $('#preamble-text').focus();
}

$('#btn-preamble').addEventListener('click', openPreamble);

// Chargement d'un préambule depuis un fichier (.tex, .sty…) : appliqué directement ; en cas d'erreur, la boîte s'ouvre.
async function loadPreambleFile(file) {
  const text = await file.text();
  if (text.length > 200000) throw new Error('fichier trop volumineux');
  const { error, unsupported } = applyPreamble(text);
  if (error) {
    openPreamble();
    setPreambleStatus('Erreur : ' + error, true);
    return;
  }
  const note = unsupported.length ? ' · non pris en charge : ' + unsupported.join(', ') : '';
  if (note) warn(`Préambule « ${file.name} » : non pris en charge par KaTeX (ignoré) : ` + unsupported.join(', '), 6000);
}
$('#preamble-input').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (file) loadPreambleFile(file).catch((err) => warn('Fichier illisible : ' + err.message));
});
$('#preamble-load').addEventListener('click', () => {
  // Depuis la boîte : on remplit la zone de texte sans appliquer, l'utilisateur valide.
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.tex,.sty,.txt,.cls,text/plain';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    $('#preamble-text').value = await file.text();
    setPreambleStatus(`« ${file.name} » chargé : cliquez sur Appliquer.`);
  });
  input.click();
});
$('#preamble-download').addEventListener('click', () => {
  const text = $('#preamble-text').value;
  if (!text.trim()) { setPreambleStatus('Le préambule est vide.'); return; }
  download(new Blob([text], { type: 'text/plain' }), `preambule-${ROOM}.tex`);
});
$('#preamble-cancel').addEventListener('click', () => preambleDialog.close());
$('#preamble-apply').addEventListener('click', () => {
  const { error, unsupported } = applyPreamble($('#preamble-text').value);
  const notes = [];
  if (error) notes.push('Erreur : ' + error);
  if (unsupported.length) notes.push('Non pris en charge par KaTeX (ignoré) : ' + unsupported.join(', '));
  if (error) { setPreambleStatus(notes.join('\n'), true); return; }
  preambleDialog.close();
  if (notes.length) warn(notes.join(' · '), 6000);
});
preambleDialog.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') $('#preamble-apply').click();
  ev.stopPropagation();
});

// ---------------------------------------------------------------------------
// Enregistrer / ouvrir une session, exporter en PDF
// ---------------------------------------------------------------------------
// Messages : seuls les avertissements (erreur, action bloquée) s'affichent ; les confirmations restent silencieuses.
function warn(text, ms = 4000) {
  setHint(text);
  clearTimeout(warn.timer);
  warn.timer = setTimeout(() => setHint(''), ms);
}
function flash(text) {
  console.info(text);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}`;
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function saveSession() {
  const objects = sortedObjects();
  const data = { app: 'tableaublanc', version: 1, room: ROOM, savedAt: new Date().toISOString(), preamble: state.preamble, access: state.access, objects, files: {} };
  for (const o of objects) {
    if (isRect(o) && files.has(o.fileId) && !data.files[o.fileId]) data.files[o.fileId] = bufToBase64(files.get(o.fileId));
  }
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `tableau-${ROOM}-${stamp()}.json`);
  flash(`Session enregistrée (${objects.length} éléments)`);
}

async function openSession(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'tableaublanc' || !Array.isArray(data.objects)) throw new Error('ce n’est pas une session de tableau blanc');
  for (const [id, b64] of Object.entries(data.files || {})) {
    if (!files.has(id)) storeFile(id, base64ToBuf(b64));
  }
  if (data.access && data.access.leader && !state.access) setAccess(data.access);
  const objs = data.objects.filter((o) => o && typeof o.id === 'string' && !state.objects.has(o.id));
  if (objs.length) applyOp({ t: 'add', objs });
  let note = '';
  if (typeof data.preamble === 'string' && data.preamble.trim()) {
    if (!state.preamble.trim()) applyPreamble(data.preamble);
    else if (data.preamble.trim() !== state.preamble.trim()) note = ' · préambule de la session ignoré (la salle en a déjà un)';
  }
  fitView();
  if (note) warn('Préambule de la session ignoré : la salle en a déjà un', 6000);
}

// --- Rastérisation d'un texte (KaTeX) en PNG via SVG <foreignObject>, polices incluses.
let katexCssPromise = null;
function katexCssInline() {
  if (!katexCssPromise) {
    katexCssPromise = (async () => {
      const base = new URL('./vendor/katex/', import.meta.url);
      let css = await (await fetch(new URL('katex.min.css', base))).text();
      const names = [...new Set([...css.matchAll(/url\(fonts\/([^)]+)\.woff2\)/g)].map((m) => m[1]))];
      const data = new Map();
      await Promise.all(names.map(async (n) => {
        const buf = await (await fetch(new URL(`fonts/${n}.woff2`, base))).arrayBuffer();
        data.set(n, bufToBase64(buf));
      }));
      css = css.replace(/url\(fonts\/([^)]+)\.woff2\) format\("woff2"\)(,url\(fonts\/[^)]+\) format\("[^"]+"\))*/g,
        (_, n) => `url(data:font/woff2;base64,${data.get(n)}) format("woff2")`);
      return css;
    })();
  }
  return katexCssPromise;
}

async function rasterizeText(obj, scale = 3) {
  const el = overlay.querySelector(`[data-id="${obj.id}"]`);
  if (!el) return null;
  const css = await katexCssInline();
  const k = obj.size / 16;
  // Marge : offsetWidth est arrondi et les polices peuvent différer d'un demi-pixel ; le texte étant aligné à
  // gauche et en haut, un surplus transparent à droite et en bas est sans effet sur le placement.
  const pxW = el.offsetWidth + 16, pxH = el.offsetHeight + 8;
  const holder = document.createElement('div');
  holder.innerHTML = el.innerHTML;
  const xhtml = new XMLSerializer().serializeToString(holder).replace(/^<div[^>]*>|<\/div>$/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW * k * scale}" height="${pxH * k * scale}">
    <foreignObject width="100%" height="100%">
      <div xmlns="http://www.w3.org/1999/xhtml" style="transform-origin:0 0;transform:scale(${k * scale});width:${pxW}px;height:${pxH}px">
        <style>${css}</style>
        <div style="box-sizing:border-box;width:max-content;max-width:${pxW}px;white-space:pre-wrap;line-height:1.3;padding:4px 6px;font-size:16px;color:${obj.color};font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">${xhtml}</div>
      </div>
    </foreignObject></svg>`;
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('rendu du texte impossible'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(pxW * k * scale));
  c.height = Math.max(1, Math.round(pxH * k * scale));
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  let blob = null;
  try {
    blob = await new Promise((resolve, reject) => { try { c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'); } catch (e) { reject(e); } });
  } catch (_) {
    // Safari : le canvas est marqué « contaminé » par le SVG ; on retombe sur un rendu texte brut.
    g.clearRect(0, 0, c.width, c.height);
    g.scale(k * scale, k * scale);
    g.fillStyle = obj.color;
    g.font = '16px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'top';
    const lines = String(obj.text || '').replace(/\$+/g, '').split('\n');
    lines.forEach((line, i) => g.fillText(line, 6, 4 + i * 20.8));
    blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }
  return { png: await blob.arrayBuffer(), w: pxW * k, h: pxH * k };
}

function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
}

// Repère d'un objet rectangulaire : monde -> coordonnées locales (origine en haut à gauche, rotation annulée).
function localMapper(obj) {
  const rot = obj.rot || 0;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  return (wx, wy) => {
    const dx = wx - obj.x, dy = wy - obj.y;
    return [dx * c - dy * s, dx * s + dy * c];
  };
}

async function exportPdf() {
  setHint('Préparation du PDF…');
  const { PDFDocument, rgb, LineCapStyle, degrees } = await import('./vendor/pdf-lib.esm.min.js');
  const out = await PDFDocument.create();
  const all = sortedObjects();
  const pages = all.filter((o) => o.type === 'pdf').sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const strokes = all.filter((o) => o.type === 'stroke');
  const texts = all.filter((o) => o.type === 'text');
  const images = all.filter((o) => o.type === 'image');
  const placed = new Set();
  const imageEmbeds = new Map();
  const imageEmbed = async (o) => {
    if (!imageEmbeds.has(o.fileId)) {
      imageEmbeds.set(o.fileId, (async () => {
        const buf = files.get(o.fileId);
        if (!buf) return null;
        if (o.mime === 'image/png') return out.embedPng(buf);
        if (o.mime === 'image/jpeg') return out.embedJpg(buf);
        const bmp = await createImageBitmap(new Blob([buf], { type: o.mime }));
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
        return out.embedPng(await blob.arrayBuffer());
      })());
    }
    return imageEmbeds.get(o.fileId);
  };
  const srcDocs = new Map();
  const textImages = new Map();
  const textImage = async (t) => {
    if (!textImages.has(t.id)) {
      const r = await rasterizeText(t);
      textImages.set(t.id, r ? { ...r, img: await out.embedPng(r.png) } : null);
    }
    return textImages.get(t.id);
  };

  // Dessine traits et textes sur une page ; toPt : monde -> espace utilisateur PDF ; k : points par unité monde ;
  // extraRot : rotation (degrés) à ajouter aux images (rotation propre de la page PDF).
  const drawOn = async (page, items, toPt, k, extraRot) => {
    for (const o of items) {
      if (o.type === 'stroke') {
        const [r, g, b] = hexToRgb01(o.color);
        const p = o.points;
        if (p.length === 2) {
          const [x, y] = toPt(p[0], p[1]);
          page.drawCircle({ x, y, size: (o.width * k) / 2, color: rgb(r, g, b), opacity: o.opacity ?? 1 });
          continue;
        }
        let d = '';
        for (let i = 0; i < p.length; i += 2) {
          const [x, y] = toPt(p[i], p[i + 1]);
          d += (i ? ' L ' : 'M ') + x.toFixed(2) + ' ' + (-y).toFixed(2);
        }
        page.drawSvgPath(d, { x: 0, y: 0, borderColor: rgb(r, g, b), borderWidth: o.width * k, borderOpacity: o.opacity ?? 1, borderLineCap: LineCapStyle.Round });
      } else if (o.type === 'text' || o.type === 'image') {
        const t = o.type === 'text' ? await textImage(o) : { img: await imageEmbed(o), w: o.w, h: o.h };
        if (!t || !t.img) continue;
        const rot = o.rot || 0;
        // Coin bas-gauche de l'image dans le monde (ancre de pdf-lib), puis rotation
        const bx = o.x - t.h * Math.sin(rot), by = o.y + t.h * Math.cos(rot);
        const [x, y] = toPt(bx, by);
        page.drawImage(t.img, { x, y, width: t.w * k, height: t.h * k, rotate: degrees(-(rot * 180) / Math.PI + extraRot) });
      }
    }
  };

  for (const pg of pages) {
    if (!files.has(pg.fileId)) continue;
    let src = srcDocs.get(pg.fileId);
    if (!src) {
      src = await PDFDocument.load(files.get(pg.fileId), { ignoreEncryption: true });
      srcDocs.set(pg.fileId, src);
    }
    const [page] = await out.copyPages(src, [pg.page - 1]);
    out.addPage(page);
    const { width: W, height: H } = page.getSize();
    const r = ((page.getRotation().angle % 360) + 360) % 360;
    const DW = r === 90 || r === 270 ? H : W; // largeur affichée
    const k = DW / pg.w;
    const local = localMapper(pg);
    const toPt = (wx, wy) => {
      const [lx, ly] = local(wx, wy);
      const dx = lx * k, dy = ly * k; // repère affiché, y vers le bas
      if (r === 90) return [dy, dx];
      if (r === 180) return [W - dx, dy];
      if (r === 270) return [W - dy, H - dx];
      return [dx, H - dy];
    };
    const inside = (wx, wy) => { const [lx, ly] = local(wx, wy); return lx >= 0 && lx <= pg.w && ly >= 0 && ly <= pg.h; };
    const items = [];
    for (const s of strokes) {
      if (placed.has(s.id)) continue;
      const p = s.points;
      let on = false;
      for (let i = 0; i < p.length && !on; i += 2) on = inside(p[i], p[i + 1]);
      if (on) { items.push(s); placed.add(s.id); }
    }
    for (const t of [...images, ...texts]) {
      if (!placed.has(t.id) && inside(t.x, t.y)) { items.push(t); placed.add(t.id); }
    }
    items.sort((a, b) => zOf(a) - zOf(b));
    await drawOn(page, items, toPt, k, r);
  }

  const rest = [...images, ...strokes, ...texts].filter((o) => !placed.has(o.id)).sort((a, b) => zOf(a) - zOf(b));
  if (rest.length || !out.getPageCount()) {
    const b = unionBounds(rest) || { x: 0, y: 0, w: 800, h: 600 };
    const pad = 40;
    const scale = Math.min(1, 14000 / (b.w + 2 * pad), 14000 / (b.h + 2 * pad));
    const page = out.addPage([(b.w + 2 * pad) * scale, (b.h + 2 * pad) * scale]);
    const toPt = (wx, wy) => [(wx - b.x + pad) * scale, page.getHeight() - (wy - b.y + pad) * scale];
    await drawOn(page, rest, toPt, scale, 0);
  }

  const bytes = await out.save();
  download(new Blob([bytes], { type: 'application/pdf' }), `tableau-${ROOM}-${stamp()}.pdf`);
  setHint('');
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.style.cursor = { hand: 'grab', select: 'default', text: 'text', eraser: 'cell' }[tool] || 'crosshair';
  const isSelectTool = tool === 'select' || tool === 'lasso';
  $('#sizes').hidden = !(tool === 'pen' || tool === 'marker' || tool === 'eraser');
  $('#font-sizes').hidden = tool !== 'text';
  $('#colors').hidden = tool === 'eraser' || tool === 'hand' || isSelectTool;
  if (!isSelectTool) setSelection([]);
  setHint('');
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
  const objs = selectedObjects().filter((o) => !isRect(o));
  if (objs.length) applyOp({ t: 'patch', items: objs.map((o) => ({ id: o.id, before: { color: o.color }, after: { color: c } })) });
}
setColor(state.color);

// Tailles prédéfinies : plus faciles à viser qu'un curseur, surtout au doigt.
const STROKE_SIZES = [2, 4, 7, 12];
const FONT_SIZES = [18, 24, 36, 56];
function buildSizes(container, values, render, onPick) {
  container.replaceChildren();
  for (const v of values) {
    const b = document.createElement('button');
    b.className = 'size';
    b.dataset.value = v;
    b.title = v + ' px';
    b.appendChild(render(v));
    b.addEventListener('click', () => onPick(v));
    container.appendChild(b);
  }
}
function markActive(container, value) {
  container.querySelectorAll('.size').forEach((b) => b.classList.toggle('active', Number(b.dataset.value) === value));
}
buildSizes($('#sizes'), STROKE_SIZES, (v) => {
  const d = document.createElement('span');
  d.className = 'dot';
  const px = 3 + v * 1.25; // 5.5, 8, 11.75, 18 px : écarts bien visibles
  d.style.width = d.style.height = px + 'px';
  return d;
}, (v) => { state.width = v; markActive($('#sizes'), v); });
buildSizes($('#font-sizes'), FONT_SIZES, (v) => {
  const g = document.createElement('span');
  g.className = 'glyph';
  g.textContent = 'A';
  g.style.fontSize = (9 + v / 4) + 'px';
  return g;
}, (v) => {
  state.fontSize = v;
  markActive($('#font-sizes'), v);
  const objs = selectedObjects().filter((o) => o.type === 'text');
  if (objs.length) applyOp({ t: 'patch', items: objs.map((o) => ({ id: o.id, before: { size: o.size }, after: { size: v } })) });
});
state.width = 4;
markActive($('#sizes'), state.width);
markActive($('#font-sizes'), state.fontSize);

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-zoom-in').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.25));
$('#btn-zoom-out').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 0.8));
$('#btn-zoom-fit').addEventListener('click', fitView);
$('#btn-clear').addEventListener('click', () => {
  if (!state.objects.size) return;
  if (!iCanWrite()) { warn('Lecture seule : le leader ne vous a pas autorisé à écrire'); return; }
  if (!confirm('Effacer tout le tableau pour tout le monde ?')) return;
  const objs = [...state.objects.values()];
  for (const obj of objs) state.tombstones.set(obj.id, Date.now());
  state.objects.clear();
  overlay.replaceChildren();
  setSelection([]);
  broadcast('op', { t: 'clear' });
  recordOp({ t: 'remove', objs });
  scheduleSave();
  requestRender();
});
$('#btn-share').addEventListener('click', async () => {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    $('#btn-share span').textContent = 'Lien copié';
  } catch (_) {
    prompt('Lien de la salle :', url);
  }
  setTimeout(() => ($('#btn-share span').textContent = 'Partager'), 1800);
});
$('#btn-name').addEventListener('click', () => {
  const name = prompt('Votre nom :', me.name);
  if (name && name.trim()) {
    me.name = name.trim().slice(0, 24);
    localStorage.setItem('wb-name', me.name);
    profile?.set({ name: me.name, color: me.color });
    relayPresence();
    renderUsers();
  }
});

const menu = $('#menu');
$('#btn-menu').addEventListener('click', (ev) => { ev.stopPropagation(); menu.hidden = !menu.hidden; });
menu.addEventListener('click', (ev) => {
  const target = ev.target.closest('[data-action]');
  if (!target) return;
  menu.hidden = true;
  const el = $(target.dataset.action);
  if (el.tagName === 'LABEL') el.querySelector('input').click(); else el.click();
});
// Salles : nouvelle salle ou salle existante (code ou lien)
function goToRoom(id) {
  const url = new URL(location.href);
  url.searchParams.set('room', id);
  location.href = url.href;
}
$('#btn-new-room').addEventListener('click', () => goToRoom(Math.random().toString(36).slice(2, 8)));
$('#btn-join-room').addEventListener('click', () => {
  const answer = prompt('Code de la salle ou lien à rejoindre :', '');
  if (!answer) return;
  let id = answer.trim();
  try { const u = new URL(id); id = u.searchParams.get('room') || ''; } catch (_) { /* pas un lien */ }
  id = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!id) { warn('Code de salle invalide'); return; }
  if (id === ROOM) { warn('Vous êtes déjà dans cette salle'); return; }
  goToRoom(id);
});
$('#btn-save').addEventListener('click', () => saveSession().catch((err) => warn('Échec : ' + err.message)));
$('#btn-export-pdf').addEventListener('click', () => exportPdf().catch((err) => { console.error(err); setHint(''); warn('Échec de l’export : ' + err.message); }));
$('#session-input').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (file) openSession(file).catch((err) => warn('Fichier illisible : ' + err.message));
});
window.addEventListener('pointerdown', (ev) => { if (!menu.hidden && !ev.target.closest('#menu, #btn-menu')) menu.hidden = true; });
window.addEventListener('resize', () => updateSelectionBox());
// Hauteur réelle de la barre d'outils (variable CSS) pour placer l'infobulle au-dessus sur mobile.
new ResizeObserver(() => document.documentElement.style.setProperty('--toolbar-h', $('#toolbar').offsetHeight + 'px')).observe($('#toolbar'));
// Repli de la barre d'outils (état mémorisé)
{
  const toolbar = $('#toolbar');
  const setCollapsed = (on) => {
    toolbar.classList.toggle('collapsed', on);
    document.documentElement.style.setProperty('--toolbar-h', on ? '0px' : toolbar.offsetHeight + 'px');
    try { localStorage.setItem('wb-toolbar-collapsed', on ? '1' : '0'); } catch (_) { /* stockage indisponible */ }
  };
  $('#toolbar-toggle').addEventListener('click', () => setCollapsed(!toolbar.classList.contains('collapsed')));
  try { if (localStorage.getItem('wb-toolbar-collapsed') === '1') setCollapsed(true); } catch (_) { /* ignore */ }
}

window.addEventListener('keydown', (ev) => {
  if (editing || /^(INPUT|TEXTAREA)$/.test(ev.target.tagName) || ev.target.closest('dialog')) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
  if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); if (state.tool !== 'lasso') setTool('select'); setSelection([...state.objects.keys()]); return; }
  if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); duplicateSelection(); return; }
  if (mod) return;
  switch (ev.key) {
    case ' ':
      if (!spaceDown) { spaceDown = true; canvas.style.cursor = 'grab'; }
      ev.preventDefault();
      break;
    case 'v': case 'V': setTool('select'); break;
    case 'l': case 'L': setTool('lasso'); break;
    case 'p': case 'P': case 'c': case 'C': setTool('pen'); break;
    case 'h': case 'H': setTool('marker'); break;
    case 'e': case 'E': case 'g': case 'G': setTool('eraser'); break;
    case 't': case 'T': setTool('text'); break;
    case 'm': case 'M': setTool('hand'); break;
    case 'Delete': case 'Backspace': deleteSelection(); break;

    case 'Escape': setSelection([]); break;
  }
});
window.addEventListener('keyup', (ev) => {
  if (ev.key === ' ') { spaceDown = false; if (!drag) setTool(state.tool); }
});

// Zoom du navigateur désactivé : le pincement ne doit zoomer que le tableau.
// Safari (macOS trackpad) signale le pincement par gesture* ; sur iOS les doigts passent déjà par les
// événements pointer, on n'utilise donc gesture* que si aucun doigt n'est suivi.
let gestureScale = 1;
document.addEventListener('gesturestart', (ev) => { ev.preventDefault(); gestureScale = 1; }, { passive: false });
document.addEventListener('gesturechange', (ev) => {
  ev.preventDefault();
  if (pointers.size === 0 && ev.scale > 0) {
    zoomAt(ev.clientX, ev.clientY, ev.scale / gestureScale);
    gestureScale = ev.scale;
  }
}, { passive: false });
document.addEventListener('gestureend', (ev) => ev.preventDefault(), { passive: false });
document.addEventListener('touchmove', (ev) => {
  if (ev.touches.length > 1 || (ev.scale !== undefined && ev.scale !== 1)) ev.preventDefault();
}, { passive: false });

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
for (const b of document.querySelectorAll('button[title], label[title]')) {
  if (!b.getAttribute('aria-label') && !b.textContent.trim()) b.setAttribute('aria-label', b.title);
}


window.addEventListener('resize', resize);
resize();
setTool('pen');
updateUndoButtons();
renderUsers();
connect();
loadLocal().then(() => fitView());

// Accès à l'état pour le débogage et les tests.
window.tableaublanc = { state, files, get room() { return room; }, reconcileAll, relay, me, claimLeader, leaderUpdate, iCanWrite };
