// Servidor: sirve la app web, la señalización WebRTC (/) y el asistente de voz (/assistant).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { turn, seed } from './src/brain.js';
import { synthesize, piperConfigured } from './src/tts.js';
import { startScheduler } from './src/scheduler.js';
import { publicKey, addSubscription, notifyAll } from './src/push.js';

const PORT = process.env.PORT || 3000;
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
};
const TOKEN = process.env.ACCESS_TOKEN || randomBytes(12).toString('hex');
const tokenOk = (t) => { const a = Buffer.from(String(t)), b = Buffer.from(TOKEN); return a.length === b.length && timingSafeEqual(a, b); };

const readJson = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 20000) { reject(new Error('demasiado grande')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks))); } catch (e) { reject(e); } });
});
const authOk = (req) => tokenOk((req.headers.authorization || '').replace(/^Bearer /, ''));

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    if (!authOk(req)) { res.writeHead(401).end(); return; }
    if (req.method === 'GET' && req.url === '/api/push-key') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ key: publicKey() })); return; }
    if (req.method === 'POST' && req.url === '/api/subscribe') {
      try { res.writeHead(addSubscription(await readJson(req)) ? 204 : 400).end(); } catch { res.writeHead(400).end(); }
      return;
    }
    // Aviso de un agente (Hermes, colector del HUD...) al celular: push, sin llamada ni voz.
    if (req.method === 'POST' && req.url === '/api/notify') {
      try {
        const { title, body, from } = await readJson(req);
        if (!body) { res.writeHead(400).end(); return; }
        await notifyAll({ title: String(title || (from ? `🤖 ${from}` : '🤖 Agente')).slice(0, 80), body: String(body).slice(0, 300) });
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
      return;
    }
    res.writeHead(404).end(); return;
  }
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

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

// ---------- Llamadas de voz entre usuarios (WebRTC, señalización) ----------
const p2p = new WebSocketServer({ noServer: true });
const users = new Map();
const broadcastUsers = () => { const list = [...users.keys()]; for (const ws of users.values()) send(ws, { type: 'users', users: list }); };

p2p.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'register') {
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name || users.has(name)) return send(ws, { type: 'error', error: 'Nombre vacío o en uso' });
      ws.name = name; users.set(name, ws);
      send(ws, { type: 'registered', name });
      return broadcastUsers();
    }
    if (!ws.name) return;
    if (['offer', 'answer', 'ice', 'hangup', 'reject'].includes(msg.type)) {
      const target = users.get(msg.to);
      if (target) send(target, { ...msg, from: ws.name, to: undefined });
      else send(ws, { type: 'unavailable', to: msg.to });
    }
  });
  ws.on('close', () => { if (ws.name && users.get(ws.name) === ws) { users.delete(ws.name); broadcastUsers(); } });
});

// ---------- Asistente de voz ----------
const assistant = new WebSocketServer({ noServer: true });
const clients = new Set();
const calls = new Map(); // callId -> { id, line, tries, timer, taken }
let callSeq = 0;

async function say(ws, text, end = false) {
  const wav = await synthesize(text);
  send(ws, { type: 'say', text, audio: wav ? wav.toString('base64') : null, end });
}

function ring(call) {
  call.taken = false;
  for (const ws of clients) send(ws, { type: 'ring', callId: call.id, reason: call.reason });
  // Timbre insistente: iOS no permite sonido largo en un push, así que se simula
  // con una ráfaga de 3 avisos (0 s, 5 s, 10 s) sobre el mismo hilo (tag) — cada uno re-suena.
  notifyAll({ title: '📞 Jarvis te está llamando', body: call.line, callId: call.id });
  setTimeout(() => notifyAll({ title: '📞 Jarvis sigue llamando…', body: call.line, callId: call.id }), 5000);
  setTimeout(() => notifyAll({ title: '📞 Última llamada de Jarvis', body: call.line, callId: call.id }), 10000);
  clearTimeout(call.timer);
  call.timer = setTimeout(() => {
    if (call.taken) return;
    for (const ws of clients) send(ws, { type: 'ring-cancel', callId: call.id });
    if (++call.tries < 3) call.retry = setTimeout(() => ring(call), 5 * 60000); // reintenta en 5 min
    else calls.delete(call.id);
  }, 45000);
}

function incoming({ reason, line }) {
  const call = { id: ++callSeq, reason, line, tries: 0 };
  calls.set(call.id, call);
  ring(call);
}

startScheduler(incoming);

assistant.on('connection', (ws) => {
  clients.add(ws);
  ws.messages = [];
  ws.chain = Promise.resolve(); // procesa un turno a la vez
  send(ws, { type: 'ready', piper: piperConfigured() });
  for (const c of calls.values()) if (!c.taken) send(ws, { type: 'ring', callId: c.id, reason: c.reason }); // llamadas pendientes

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    ws.chain = ws.chain.then(async () => {
      if (msg.type === 'answer') {
        const call = calls.get(msg.callId);
        if (!call || call.taken) return send(ws, { type: 'ring-cancel', callId: msg.callId });
        call.taken = true; clearTimeout(call.timer); clearTimeout(call.retry); calls.delete(call.id);
        for (const other of clients) if (other !== ws) send(other, { type: 'ring-cancel', callId: call.id });
        ws.messages = []; seed(ws.messages, call.line);
        await say(ws, call.line);
      } else if (msg.type === 'decline') {
        // se deja que el temporizador reintente más tarde
        send(ws, { type: 'ring-cancel', callId: msg.callId });
      } else if (msg.type === 'dial') {
        ws.messages = [];
        const hello = 'Dime, ¿en qué te ayudo?';
        seed(ws.messages, hello);
        await say(ws, hello);
      } else if (msg.type === 'user' && typeof msg.text === 'string' && msg.text.trim()) {
        let reply;
        try { reply = await turn(ws.messages, msg.text.trim().slice(0, 1000)); }
        catch (e) { console.error('Error del cerebro:', e.message); reply = 'Tuve un problema para pensar eso. Inténtalo otra vez.'; }
        const end = reply.includes('[FIN]');
        await say(ws, reply.replace('[FIN]', '').trim() || 'Hasta luego.', end);
      } else if (msg.type === 'hangup') {
        ws.messages = [];
      }
    }).catch((e) => console.error('Error en mensaje:', e));
  });
  ws.on('close', () => clients.delete(ws));
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/assistant') {
    if (!tokenOk(url.searchParams.get('token') || '')) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    assistant.handleUpgrade(req, socket, head, (ws) => assistant.emit('connection', ws, req));
  } else {
    p2p.handleUpgrade(req, socket, head, (ws) => p2p.emit('connection', ws, req));
  }
});

server.listen(PORT, () => {
  console.log(`JarvisOS en http://localhost:${PORT}`);
  console.log(`Asistente: http://localhost:${PORT}/assistant.html#${TOKEN}`);
  if (!process.env.ACCESS_TOKEN) console.log('(token temporal; fija ACCESS_TOKEN en .env para que no cambie)');
  if (!piperConfigured()) console.log('Piper no configurado (PIPER_MODEL): usaré la voz del navegador como respaldo.');
  console.log('Cerebro: Claude CLI (suscripción) — sin API key.');
});
