// Voz de salida con Piper (gratis, local). Devuelve un WAV en Buffer, o null si Piper no está listo
// (el cliente entonces usa la voz del navegador como respaldo).
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const BIN = process.env.PIPER_BIN || 'piper';
const MODEL = process.env.PIPER_MODEL; // ruta al .onnx, p. ej. voices/es_MX-claude-high.onnx

export const piperConfigured = () => Boolean(MODEL && existsSync(MODEL));

export async function synthesize(text) {
  if (!piperConfigured()) return null;
  const out = join(tmpdir(), `jarvis-${randomUUID()}.wav`);
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(BIN, ['-m', MODEL, '-f', out], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`piper salió con ${code}: ${err.slice(-300)}`))));
      p.stdin.end(text.replace(/\s+/g, ' ').trim());
    });
    return await readFile(out);
  } catch (e) {
    console.error('Piper falló:', e.message);
    return null;
  } finally {
    rm(out, { force: true }).catch(() => {});
  }
}
