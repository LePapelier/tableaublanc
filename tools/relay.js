// Mini relais Nostr (sous-ensemble suffisant pour la signalisation Trystero).
// Usage : node tools/relay.js [port]   puis ouvrir l'application avec ?relay=ws://localhost:4444
// Sert aux tests locaux ou à un déploiement privé ; les relais publics suffisent sinon.
'use strict';
const { WebSocketServer } = require('ws');

const port = Number(process.argv[2]) || 4444;
const wss = new WebSocketServer({ port });
const recent = []; // événements récents, rejoués aux abonnements avec « since »
const TTL = 5 * 60 * 1000;

function matches(filter, ev) {
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (filter.since && ev.created_at < filter.since) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (!k.startsWith('#')) continue;
    const tag = k.slice(1);
    if (!ev.tags.some(([t, val]) => t === tag && v.includes(val))) return false;
  }
  return true;
}

wss.on('connection', (ws) => {
  const subs = new Map();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const [type, a, b] = msg;
    if (type === 'EVENT') {
      const ev = a;
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      const now = Date.now();
      recent.push({ ev, at: now });
      while (recent.length && now - recent[0].at > TTL) recent.shift();
      for (const client of wss.clients) {
        if (client.readyState !== client.OPEN) continue;
        for (const [subId, filter] of client.subs || []) {
          if (matches(filter, ev)) client.send(JSON.stringify(['EVENT', subId, ev]));
        }
      }
    } else if (type === 'REQ') {
      subs.set(a, b);
      for (const { ev } of recent) if (matches(b, ev)) ws.send(JSON.stringify(['EVENT', a, ev]));
      ws.send(JSON.stringify(['EOSE', a]));
    } else if (type === 'CLOSE') {
      subs.delete(a);
    }
  });
  ws.subs = subs;
});

console.log(`Relais Nostr minimal sur ws://localhost:${port}`);
