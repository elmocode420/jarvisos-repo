// Servidor de señalización: sirve el cliente y reenvía mensajes WebRTC entre usuarios.
// El audio NO pasa por aquí: va directo entre navegadores (P2P).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3000;
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('No encontrado');
  }
});

const wss = new WebSocketServer({ server });
const users = new Map(); // nombre -> socket

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcastUsers = () => {
  const list = [...users.keys()];
  for (const ws of users.values()) send(ws, { type: 'users', users: list });
};

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name || users.has(name)) return send(ws, { type: 'error', error: 'Nombre vacío o en uso' });
      ws.name = name;
      users.set(name, ws);
      send(ws, { type: 'registered', name });
      return broadcastUsers();
    }

    if (!ws.name) return;
    // offer / answer / ice / hangup / reject: se reenvían al destinatario
    if (['offer', 'answer', 'ice', 'hangup', 'reject'].includes(msg.type)) {
      const target = users.get(msg.to);
      if (target) send(target, { ...msg, from: ws.name, to: undefined });
      else send(ws, { type: 'unavailable', to: msg.to });
    }
  });

  ws.on('close', () => {
    if (ws.name && users.get(ws.name) === ws) { users.delete(ws.name); broadcastUsers(); }
  });
});

server.listen(PORT, () => console.log(`JarvisOS Voice en http://localhost:${PORT}`));
