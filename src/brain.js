// Cerebro del asistente — versión Claude CLI (opción B, 2026-10-11).
// En vez del SDK (API key de paga), usa `claude -p` con la suscripción de Jose Lu.
// Mismo contrato que el original: turn(messages, userText) → texto a decir; seed().
// El original con SDK quedó en brain-sdk.js.bak por si algún día hay API key.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { store } from './store.js';

const CLAUDE = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001'; // voz = latencia corta
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const OWNER = process.env.OWNER_NAME || 'jefe';

const fmt = (ms) => (ms == null ? null : new Date(ms).toLocaleString('es', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' }));
const parseWhen = (s) => { const ms = new Date(s).getTime(); if (Number.isNaN(ms)) throw new Error(`Fecha inválida: ${s}`); return ms; };

/* ---------- operaciones sobre la agenda (idénticas al original) ---------- */
function runOp(name, input) {
  switch (name) {
    case 'add_task': {
      const t = store.addTask({ title: input.title, due: input.due ? parseWhen(input.due) : null, notes: input.notes || '' });
      return `Tarea ${t.id} creada.`;
    }
    case 'complete_task': return store.completeTask(input.id) ? 'Hecho.' : 'No existe esa tarea.';
    case 'add_reminder': {
      const r = store.addReminder({ text: input.text, at: parseWhen(input.at) });
      return `Recordatorio ${r.id} para ${fmt(r.at)}.`;
    }
    case 'add_meeting': {
      const m = store.addMeeting({ title: input.title, start: parseWhen(input.start), notes: input.notes || '', remindMinutes: input.remind_minutes ?? 10 });
      return `Reunión ${m.id} el ${fmt(m.start)}.`;
    }
    case 'cancel_item': return store.cancel(input.kind, input.id) ? 'Cancelado.' : 'No existe.';
    default: throw new Error(`Operación desconocida: ${name}`);
  }
}

/* ---------- foto del estado para que las consultas no necesiten ops ---------- */
function snapshot() {
  const db = store.data();
  const now = Date.now();
  const since = now - 7 * 86400000;
  return {
    tareas_pendientes: db.tasks.filter((t) => !t.done).map((t) => ({ id: t.id, title: t.title, due: fmt(t.due) })),
    tareas_hechas_7dias: db.tasks.filter((t) => t.done && t.doneAt >= since).map((t) => t.title),
    tareas_vencidas: db.tasks.filter((t) => !t.done && t.due && t.due < now).map((t) => t.title),
    reuniones: db.meetings.filter((m) => m.start >= now).sort((a, b) => a.start - b.start)
      .map((m) => ({ id: m.id, title: m.title, start: fmt(m.start) })),
    recordatorios: db.reminders.filter((r) => !r.fired).sort((a, b) => a.at - b.at)
      .map((r) => ({ id: r.id, text: r.text, at: fmt(r.at) })),
  };
}

const system = () => `Eres Jarvis, el asistente personal de voz de ${OWNER}. Hablas por teléfono, en español natural y cercano.
Reglas de voz: respuestas cortas (1-3 frases), sin markdown, sin listas con viñetas, sin emojis; di las fechas de forma hablada ("mañana a las nueve"). Si hay varias cosas, menciona las 2-3 más importantes y ofrece seguir.
Ahora es ${new Date().toLocaleString('es', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' })} (zona ${TZ}). Usa esa referencia para "hoy", "mañana", etc.
Si ${OWNER} se despide o pide colgar, despídete en una frase corta y añade al final exactamente la marca [FIN].`;

const protocolo = `Respondes ÚNICAMENTE con un objeto JSON válido (sin texto fuera del JSON, sin markdown):
{"say":"lo que vas a decir por voz","ops":[]}
En "ops" van SOLO las modificaciones de agenda que ${OWNER} pidió, con esta forma {"tool":"...","input":{...}}:
- add_task {title, due? (ISO local sin zona, ej. 2026-10-11T18:00), notes?}
- complete_task {id}
- add_reminder {text, at (ISO local)}  ← a esa hora el asistente LLAMA a ${OWNER}
- add_meeting {title, start (ISO local), notes?, remind_minutes?}
- cancel_item {kind: "reminders"|"meetings", id}
Para CONSULTAS (qué tengo hoy, mis tareas, progreso) usa el ESTADO que te doy — no inventes datos y no uses ops.
Si falta un dato esencial (por ejemplo la hora), pregúntalo en "say" y no mandes la op todavía.
Redacta "say" dando por hecho que las ops se aplican.`;

/* ---------- contexto del vault (horario y plan) ----------
   Se lee del disco y se cachea 5 min: Jarvis no abre herramientas por turno
   (eso lo haría lentísimo), recibe el horario ya masticado en el prompt. */
const VAULT = process.env.VAULT_DIR || `${process.env.HOME}/Documents/Obsidian Vault`;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
let vaultCache = { at: 0, text: '' };

const section = (md, heading) => {
  const i = md.indexOf(heading); if (i === -1) return '';
  const rest = md.slice(i + heading.length);
  const j = rest.search(/\n---\s*\n|\n## /);
  return (j === -1 ? rest : rest.slice(0, j)).trim();
};
const localDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // YYYY-MM-DD
  const wd = new Date(new Date(d.toLocaleString('en-US', { timeZone: TZ })).getTime()).getDay();
  return { iso: p, dia: DIAS[wd] };
};
const slim = (s, max) => (s.length > max ? s.slice(0, max) + '…' : s);

function vaultContext() {
  if (Date.now() - vaultCache.at < 5 * 60000 && vaultCache.text) return vaultCache.text;
  const parts = [];
  try {
    const sem = readFileSync(`${VAULT}/plan/🗓️ Semana tipo.md`, 'utf8');
    parts.push('HORARIO DE CLASES POR DÍA (UVM):\n' + section(sem, '## Cuándo cabe el gimnasio'));
    parts.push('MATERIAS Y SALONES:\n' + section(sem, '## Las materias'));
    parts.push('SEMANA TIPO (hora por hora, columnas = lunes a viernes):\n' + section(sem, '## La semana'));
  } catch (e) { parts.push('(no pude leer el horario del vault: ' + e.message + ')'); }
  for (const off of [0, 1]) {
    const { iso, dia } = localDate(off);
    try { parts.push(`PLAN DEL ${off ? 'DÍA SIGUIENTE' : 'DÍA'} (${dia} ${iso}):\n` + slim(readFileSync(`${VAULT}/plan/${iso}.md`, 'utf8').trim(), 1500)); }
    catch { /* sin plan escrito para ese día */ }
  }
  vaultCache = { at: Date.now(), text: slim(parts.join('\n\n'), 9000) };
  return vaultCache.text;
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    // Arranque mínimo: sin MCP, sin skills, sin herramientas, sin persistir sesión, cwd neutro.
    // (--bare quedaría más rápido pero ignora la suscripción: exige API key.)
    const child = execFile(CLAUDE, ['-p', prompt, '--model', MODEL, '--strict-mcp-config', '--disable-slash-commands',
      '--no-session-persistence', '--tools', ''],
      { timeout: 90000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env }, cwd: tmpdir() },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve((stdout || '').trim());
      });
    child.stdin.end();   // sin esto, claude espera 3 s a stdin en cada turno
  });
}

function parseJson(text) {
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('sin JSON');
  return JSON.parse(text.slice(a, b + 1));
}

/** Procesa un turno. `messages` = historial [{role, content:string}]. Devuelve el texto a decir. */
export async function turn(messages, userText) {
  messages.push({ role: 'user', content: userText });
  const hist = messages.slice(-12)
    .map((m) => `${m.role === 'user' ? OWNER : 'Jarvis'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');
  const prompt = `${system()}

${protocolo}

HOY es ${localDate(0).dia} ${localDate(0).iso}; MAÑANA es ${localDate(1).dia} ${localDate(1).iso}.
Para clases, horarios, materias, salones o tu día usa el VAULT de ${OWNER} (abajo): es la fuente de verdad del horario escolar. Si el día pedido es sábado o domingo, no hay clases. Nunca digas "no tienes clases" sin revisar el horario por día.

VAULT DE ${OWNER}:
${vaultContext()}

ESTADO ACTUAL DE LA AGENDA DE JARVIS (tareas, recordatorios y reuniones que ${OWNER} te pidió; fuente de verdad, no inventes):
${JSON.stringify(snapshot())}

CONVERSACIÓN:
${hist}

JSON de tu turno:`;
  let say = 'Perdona, me enredé. ¿Me lo repites?';
  try {
    const out = await callClaude(prompt);
    const res = parseJson(out);
    say = String(res.say || say);
    const fallas = [];
    for (const op of (Array.isArray(res.ops) ? res.ops : [])) {
      try { runOp(op.tool, op.input || {}); }
      catch (e) { fallas.push(e.message); }
    }
    if (fallas.length) say += ` Ojo: algo no quedó agendado (${fallas[0]}); dímelo otra vez con la fecha completa.`;
  } catch (e) {
    console.error('brain(cli):', e.message);
  }
  messages.push({ role: 'assistant', content: say });
  return say;
}

/** Para llamadas iniciadas por el asistente: deja el contexto de lo ya dicho. */
export function seed(messages, openingLine) {
  messages.push({ role: 'user', content: '[La llamada acaba de ser contestada.]' });
  messages.push({ role: 'assistant', content: openingLine });
}
