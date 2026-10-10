// Memoria del asistente: tareas, recordatorios y reuniones en un JSON local.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE = process.env.DB_FILE || 'data/db.json';
const empty = () => ({ seq: 0, tasks: [], reminders: [], meetings: [] });

let db = empty();
if (existsSync(FILE)) {
  try { db = { ...empty(), ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch (e) { console.error('db.json ilegible, empiezo vacía:', e.message); }
}

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
  renameSync(FILE + '.tmp', FILE); // escritura atómica
}

const nextId = () => ++db.seq;

export const store = {
  data: () => db,
  addTask({ title, due = null, notes = '' }) {
    const t = { id: nextId(), title, due, notes, done: false, created: Date.now(), doneAt: null };
    db.tasks.push(t); save(); return t;
  },
  completeTask(id) {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.done = true; t.doneAt = Date.now(); save(); return t;
  },
  addReminder({ text, at }) {
    const r = { id: nextId(), text, at, fired: false };
    db.reminders.push(r); save(); return r;
  },
  addMeeting({ title, start, notes = '', remindMinutes = 10 }) {
    const m = { id: nextId(), title, start, notes, remindMinutes, notified: false };
    db.meetings.push(m); save(); return m;
  },
  cancel(kind, id) {
    const list = db[kind];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return false;
    list.splice(i, 1); save(); return true;
  },
  markFired(kind, id, flag) {
    const x = db[kind].find((y) => y.id === id);
    if (x) { x[flag] = true; save(); }
  },
};
