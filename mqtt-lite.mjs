// Client MQTT 3.1.1 minimal sur WebSocket (CONNECT, SUBSCRIBE, PUBLISH QoS 0, PING).
// Suffisant pour le relais de secours ; aucune dépendance.

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodeLength(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function utf8Field(str) {
  const b = enc.encode(str);
  return [b.length >> 8, b.length & 0xff, ...b];
}

function packet(type, flags, body) {
  const len = encodeLength(body.length);
  const buf = new Uint8Array(1 + len.length + body.length);
  buf[0] = (type << 4) | flags;
  buf.set(len, 1);
  buf.set(body, 1 + len.length);
  return buf;
}

// Ouvre une connexion ; renvoie { publish, subscribe, close, url }. onMessage(topic, bytes).
export function connectMqtt(url, { clientId, keepAlive = 60, onMessage, onOpen, onClose } = {}) {
  const ws = new WebSocket(url, ['mqtt']);
  ws.binaryType = 'arraybuffer';
  let open = false;
  let closed = false;
  let pingTimer = null;
  let packetId = 1;
  let buffer = new Uint8Array(0);

  const send = (bytes) => { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); };

  ws.onopen = () => {
    const id = (clientId || 'tb-' + Math.random().toString(36).slice(2, 12)).slice(0, 23);
    const body = new Uint8Array([
      ...utf8Field('MQTT'), 4, 0x02, keepAlive >> 8, keepAlive & 0xff, // flags : clean session
      ...utf8Field(id),
    ]);
    send(packet(1, 0, body));
  };

  ws.onmessage = (ev) => {
    const chunk = new Uint8Array(ev.data);
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer); merged.set(chunk, buffer.length);
    buffer = merged;
    // Plusieurs paquets MQTT peuvent partager une trame WebSocket.
    for (;;) {
      if (buffer.length < 2) return;
      let mult = 1, len = 0, pos = 1;
      for (;;) {
        if (pos >= buffer.length) return;
        const b = buffer[pos++];
        len += (b & 0x7f) * mult;
        mult *= 128;
        if (!(b & 0x80)) break;
      }
      if (buffer.length < pos + len) return;
      const type = buffer[0] >> 4;
      const body = buffer.subarray(pos, pos + len);
      buffer = buffer.slice(pos + len);
      if (type === 2) { // CONNACK
        if (body[1] !== 0) { ws.close(); return; }
        open = true;
        pingTimer = setInterval(() => send(new Uint8Array([0xc0, 0])), (keepAlive * 1000) / 2);
        onOpen?.();
      } else if (type === 3) { // PUBLISH
        const qos = (buffer[0] >> 1) & 3; // (en-tête déjà consommé : QoS lu sur le premier octet d'origine)
        const tlen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        const payloadStart = 2 + tlen + (qos ? 2 : 0);
        onMessage?.(topic, body.slice(payloadStart));
      }
      // SUBACK (9), PINGRESP (13) : rien à faire.
    }
  };

  ws.onclose = () => { if (!closed) { closed = true; clearInterval(pingTimer); onClose?.(); } };
  ws.onerror = () => { try { ws.close(); } catch (_) { /* déjà fermé */ } };

  return {
    url,
    get isOpen() { return open && ws.readyState === WebSocket.OPEN; },
    subscribe(topic) {
      const id = packetId++ & 0xffff || 1;
      send(packet(8, 2, new Uint8Array([id >> 8, id & 0xff, ...utf8Field(topic), 0])));
    },
    publish(topic, bytes) {
      const t = utf8Field(topic);
      const body = new Uint8Array(t.length + bytes.length);
      body.set(t); body.set(bytes, t.length);
      send(packet(3, 0, body));
    },
    close() {
      closed = true;
      clearInterval(pingTimer);
      try { send(new Uint8Array([0xe0, 0])); ws.close(); } catch (_) { /* ignore */ }
    },
  };
}
