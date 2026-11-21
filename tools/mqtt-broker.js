// Broker MQTT minimal sur WebSocket pour les tests locaux : node tools/mqtt-broker.js [port]
// Puis ouvrir l'application avec ?mqtt=ws://localhost:1884
'use strict';
const http = require('http');
const WebSocket = require('ws');
const { Aedes } = require('aedes');

const port = Number(process.argv[2]) || 1884;
Aedes.createBroker().then((aedes) => {
  const server = http.createServer();
  const wss = new WebSocket.Server({ server });
  wss.on('connection', (socket) => aedes.handle(WebSocket.createWebSocketStream(socket)));
  server.listen(port, () => console.log(`Broker MQTT (WebSocket) sur ws://localhost:${port}`));
});
