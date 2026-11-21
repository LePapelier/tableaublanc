// Tableau blanc collaboratif — serveur minimal (HTTP statique + WebSocket).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD = 50 * 1024 * 1024; // 50 Mo

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Bibliothèques front servies directement depuis node_modules.
const VENDOR = {
  '/vendor/katex/': path.join(ROOT, 'node_modules', 'katex', 'dist'),
  '/vendor/pdfjs/': path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build'),
  '/uploads/': UPLOAD_DIR,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Salles : état en mémoire + persistance JSON (écriture différée).
// ---------------------------------------------------------------------------

const rooms = new Map(); // id -> { objects: Map<id, obj>, clients: Set<ws>, saveTimer }

function roomFile(id) {
  return path.join(DATA_DIR, `room-${id}.json`);
}

function isRoomId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

function getRoom(id) {
  let room = rooms.get(id);
  if (room) return room;
  room = { id, objects: new Map(), clients: new Set(), saveTimer: null };
  try {
    const raw = fs.readFileSync(roomFile(id), 'utf8');
    const saved = JSON.parse(raw);
    for (const obj of saved.objects || []) {
      if (obj && typeof obj.id === 'string') room.objects.set(obj.id, obj);
    }
  } catch (_) {
    /* nouvelle salle */
  }
  rooms.set(id, room);
  return room;
}

function scheduleSave(room) {
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    const payload = JSON.stringify({ objects: [...room.objects.values()] });
    fs.writeFile(roomFile(room.id), payload, (err) => {
      if (err) console.error('Sauvegarde impossible :', err.message);
    });
  }, 1000);
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const client of room.clients) {
    if (client !== except && client.readyState === client.OPEN) client.send(data);
  }
}

function presence(room) {
  return [...room.clients].map((c) => ({ id: c.userId, name: c.userName, color: c.userColor }));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Introuvable');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': filePath.startsWith(PUBLIC_DIR) ? 'no-cache' : 'public, max-age=86400',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function safeJoin(base, rel) {
  const target = path.normalize(path.join(base, rel));
  return target.startsWith(base + path.sep) || target === base ? target : null;
}

function handleUpload(req, res) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > MAX_UPLOAD) return send(res, 413, 'Fichier trop volumineux (max 50 Mo)');
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return send(res, 400, "Ce n'est pas un PDF");
    const name = crypto.randomBytes(12).toString('hex') + '.pdf';
    fs.writeFile(path.join(UPLOAD_DIR, name), buf, (err) => {
      if (err) return send(res, 500, 'Écriture impossible');
      send(res, 200, JSON.stringify({ url: `/uploads/${name}` }), { 'Content-Type': 'application/json' });
    });
  });
  req.on('error', () => send(res, 400, 'Transfert interrompu'));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'POST' && pathname === '/upload') return handleUpload(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Méthode non autorisée');

  for (const [prefix, dir] of Object.entries(VENDOR)) {
    if (pathname.startsWith(prefix)) {
      const target = safeJoin(dir, pathname.slice(prefix.length));
      return target ? serveFile(res, target) : send(res, 403, 'Interdit');
    }
  }

  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = safeJoin(PUBLIC_DIR, rel);
  if (!target) return send(res, 403, 'Interdit');
  serveFile(res, target);
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');
  if (!isRoomId(roomId)) return ws.close(1008, 'Salle invalide');

  const room = getRoom(roomId);
  ws.userId = crypto.randomBytes(6).toString('hex');
  ws.userName = (url.searchParams.get('name') || 'Anonyme').slice(0, 24);
  ws.userColor = /^#[0-9a-fA-F]{6}$/.test(url.searchParams.get('color') || '') ? url.searchParams.get('color') : '#3b82f6';
  room.clients.add(ws);

  ws.send(JSON.stringify({ t: 'init', you: ws.userId, objects: [...room.objects.values()], users: presence(room) }));
  broadcast(room, { t: 'presence', users: presence(room) }, ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'add': {
        const obj = msg.obj;
        if (!obj || typeof obj.id !== 'string' || typeof obj.type !== 'string') return;
        obj.by = ws.userId;
        room.objects.set(obj.id, obj);
        scheduleSave(room);
        broadcast(room, { t: 'add', obj }, ws);
        break;
      }
      case 'update': {
        const obj = room.objects.get(msg.id);
        if (!obj || !msg.patch || typeof msg.patch !== 'object') return;
        for (const [k, v] of Object.entries(msg.patch)) {
          if (k !== 'id' && k !== 'type') obj[k] = v;
        }
        scheduleSave(room);
        broadcast(room, { t: 'update', id: msg.id, patch: msg.patch }, ws);
        break;
      }
      case 'remove': {
        const ids = Array.isArray(msg.ids) ? msg.ids : [msg.id];
        const removed = ids.filter((id) => room.objects.delete(id));
        if (!removed.length) return;
        scheduleSave(room);
        broadcast(room, { t: 'remove', ids: removed }, ws);
        break;
      }
      case 'clear': {
        room.objects.clear();
        scheduleSave(room);
        broadcast(room, { t: 'clear' }, ws);
        break;
      }
      case 'draft': // trait en cours de tracé (éphémère)
      case 'cursor': {
        msg.user = ws.userId;
        broadcast(room, msg, ws);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcast(room, { t: 'presence', users: presence(room) });
    broadcast(room, { t: 'leave', user: ws.userId });
    if (!room.clients.size && !room.saveTimer) rooms.delete(room.id);
  });
});

server.listen(PORT, () => {
  console.log(`Tableau blanc disponible sur http://localhost:${PORT}`);
});
