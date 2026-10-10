// Web Push: avisa al celular aunque la app esté cerrada. Requiere HTTPS en el navegador.
import webpush from 'web-push';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const VAPID_FILE = process.env.VAPID_FILE || 'data/vapid.json';
const SUBS_FILE = process.env.PUSH_FILE || 'data/push.json';

function load(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function save(file, data) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2)); }

// Claves VAPID: se generan una vez y se guardan; si las cambias, hay que volver a suscribir el celular.
let vapid = load(VAPID_FILE, null);
if (!vapid) { vapid = webpush.generateVAPIDKeys(); save(VAPID_FILE, vapid); }
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:jarvis@example.com', vapid.publicKey, vapid.privateKey);

let subs = load(SUBS_FILE, []);

export const publicKey = () => vapid.publicKey;

export function addSubscription(sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return false;
  subs = subs.filter((s) => s.endpoint !== sub.endpoint);
  subs.push(sub); save(SUBS_FILE, subs); return true;
}

export async function notifyAll(payload) {
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s, body, { TTL: 60, urgency: 'high' }); // la llamada caduca en 1 min
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { // suscripción caducada
        subs = subs.filter((x) => x.endpoint !== s.endpoint); save(SUBS_FILE, subs);
      } else console.error('Push falló:', e.statusCode || e.message);
    }
  }));
}
