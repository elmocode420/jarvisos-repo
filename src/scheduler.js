// Revisa cada 20 s qué recordatorios/reuniones tocan y dispara una "llamada" al teléfono.
import { store } from './store.js';

const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const hhmm = (ms) => new Date(ms).toLocaleTimeString('es', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

export function startScheduler(onCall) {
  const tick = () => {
    const now = Date.now();
    const db = store.data();
    for (const r of db.reminders) {
      if (!r.fired && r.at <= now) {
        store.markFired('reminders', r.id, 'fired');
        onCall({ reason: 'reminder', line: `Hola, te llamo para recordarte: ${r.text}.` });
      }
    }
    for (const m of db.meetings) {
      if (!m.notified && m.start - m.remindMinutes * 60000 <= now && m.start > now - 5 * 60000) {
        store.markFired('meetings', m.id, 'notified');
        const mins = Math.max(0, Math.round((m.start - now) / 60000));
        onCall({ reason: 'meeting', line: `Hola, en ${mins} minutos, a las ${hhmm(m.start)}, tienes: ${m.title}.` });
      }
    }
  };
  tick();
  return setInterval(tick, 20000);
}
