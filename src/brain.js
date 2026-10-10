// Cerebro del asistente: Claude con herramientas para leer y modificar tu agenda.
import Anthropic from '@anthropic-ai/sdk';
import { store } from './store.js';

const client = new Anthropic(); // usa ANTHROPIC_API_KEY
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'low'; // respuestas rápidas: es una llamada de voz
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const OWNER = process.env.OWNER_NAME || 'jefe';

const fmt = (ms) => (ms == null ? null : new Date(ms).toLocaleString('es', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' }));
// El modelo manda fechas locales sin zona ("2026-10-11T09:00"); new Date las interpreta en la zona del servidor (TZ).
const parseWhen = (s) => { const ms = new Date(s).getTime(); if (Number.isNaN(ms)) throw new Error(`Fecha inválida: ${s}`); return ms; };

const tools = [
  { name: 'add_task', description: 'Crea una tarea pendiente.', input_schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, due: { type: 'string', description: 'Fecha límite local ISO, ej. 2026-10-11T18:00 (opcional)' }, notes: { type: 'string' } } } },
  { name: 'complete_task', description: 'Marca una tarea como hecha.', input_schema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'integer' } } } },
  { name: 'list_tasks', description: 'Lista las tareas. Por defecto solo las pendientes.', input_schema: { type: 'object', additionalProperties: false, properties: { include_done: { type: 'boolean' } } } },
  { name: 'add_reminder', description: 'Programa un recordatorio: a esa hora el asistente llama por teléfono.', input_schema: { type: 'object', additionalProperties: false, required: ['text', 'at'], properties: { text: { type: 'string' }, at: { type: 'string', description: 'Fecha y hora local ISO, ej. 2026-10-11T09:30' } } } },
  { name: 'add_meeting', description: 'Agenda una reunión. Se avisa por llamada unos minutos antes.', input_schema: { type: 'object', additionalProperties: false, required: ['title', 'start'], properties: { title: { type: 'string' }, start: { type: 'string', description: 'Inicio local ISO' }, notes: { type: 'string' }, remind_minutes: { type: 'integer', description: 'Minutos de antelación del aviso (por defecto 10)' } } } },
  { name: 'list_agenda', description: 'Lista reuniones y recordatorios pendientes.', input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'cancel_item', description: 'Cancela un recordatorio o reunión por id.', input_schema: { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['reminders', 'meetings'] }, id: { type: 'integer' } } } },
  { name: 'progress_report', description: 'Resumen de progreso: tareas hechas y pendientes, y qué se completó en los últimos días.', input_schema: { type: 'object', additionalProperties: false, properties: { days: { type: 'integer' } } } },
];

function runTool(name, input) {
  const db = store.data();
  switch (name) {
    case 'add_task': {
      const t = store.addTask({ title: input.title, due: input.due ? parseWhen(input.due) : null, notes: input.notes });
      return `Tarea ${t.id} creada.`;
    }
    case 'complete_task': return store.completeTask(input.id) ? 'Hecho.' : 'No existe esa tarea.';
    case 'list_tasks': {
      const rows = db.tasks.filter((t) => input.include_done || !t.done).map((t) => ({ id: t.id, title: t.title, due: fmt(t.due), done: t.done }));
      return JSON.stringify(rows);
    }
    case 'add_reminder': {
      const r = store.addReminder({ text: input.text, at: parseWhen(input.at) });
      return `Recordatorio ${r.id} para ${fmt(r.at)}.`;
    }
    case 'add_meeting': {
      const m = store.addMeeting({ title: input.title, start: parseWhen(input.start), notes: input.notes, remindMinutes: input.remind_minutes ?? 10 });
      return `Reunión ${m.id} el ${fmt(m.start)}.`;
    }
    case 'list_agenda': {
      const now = Date.now();
      return JSON.stringify({
        meetings: db.meetings.filter((m) => m.start >= now).sort((a, b) => a.start - b.start).map((m) => ({ id: m.id, title: m.title, start: fmt(m.start) })),
        reminders: db.reminders.filter((r) => !r.fired).sort((a, b) => a.at - b.at).map((r) => ({ id: r.id, text: r.text, at: fmt(r.at) })),
      });
    }
    case 'cancel_item': return store.cancel(input.kind, input.id) ? 'Cancelado.' : 'No existe.';
    case 'progress_report': {
      const since = Date.now() - (input.days ?? 7) * 86400000;
      return JSON.stringify({
        pendientes: db.tasks.filter((t) => !t.done).length,
        hechas_en_periodo: db.tasks.filter((t) => t.done && t.doneAt >= since).map((t) => t.title),
        hechas_total: db.tasks.filter((t) => t.done).length,
        vencidas: db.tasks.filter((t) => !t.done && t.due && t.due < Date.now()).map((t) => t.title),
      });
    }
    default: return `Herramienta desconocida: ${name}`;
  }
}

const system = () => `Eres Jarvis, el asistente personal de voz de ${OWNER}. Hablas por teléfono, en español natural y cercano.
Reglas de voz: respuestas cortas (1-3 frases), sin markdown, sin listas con viñetas, sin emojis; di las fechas de forma hablada ("mañana a las nueve"). Si hay varias cosas, menciona las 2-3 más importantes y ofrece seguir.
Gestionas tareas, recordatorios, reuniones y progreso con tus herramientas; úsalas en vez de inventar datos. Si falta un dato esencial (la hora de un recordatorio), pregúntalo.
Ahora es ${new Date().toLocaleString('es', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' })} (zona ${TZ}). Usa esa referencia para "hoy", "mañana", etc., y manda las fechas a las herramientas en formato local ISO sin zona.
Si ${OWNER} se despide o dice que cuelgues, despídete en una frase corta y añade al final exactamente la marca [FIN].`;

/** Procesa un turno del usuario. `messages` es el historial de la llamada (se modifica). Devuelve el texto a decir. */
export async function turn(messages, userText) {
  messages.push({ role: 'user', content: userText });
  for (let i = 0; i < 8; i++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: 2000, system: system(), tools, messages,
      output_config: { effort: EFFORT },
    });
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'refusal') return 'Perdona, con eso no puedo ayudarte.';
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      return res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    }
    messages.push({
      role: 'user',
      content: uses.map((u) => {
        try { return { type: 'tool_result', tool_use_id: u.id, content: runTool(u.name, u.input) }; }
        catch (e) { return { type: 'tool_result', tool_use_id: u.id, content: e.message, is_error: true }; }
      }),
    });
  }
  return 'Me enredé con eso, ¿lo intentamos de nuevo?';
}

/** Para llamadas iniciadas por el asistente: registra lo que ya dijo para que el modelo tenga el contexto. */
export function seed(messages, openingLine) {
  messages.push({ role: 'user', content: '[La llamada acaba de ser contestada.]' });
  messages.push({ role: 'assistant', content: openingLine });
}
