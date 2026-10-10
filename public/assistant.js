// Cliente del asistente: timbre, llamada, voz (Piper vía servidor o voz del navegador) y reconocimiento de voz.
const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const setOrb = (c) => ($('orb').className = c || '');
const setStatus = (t) => ($('status').textContent = t);

const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const token = location.hash.slice(1) || store.get('jarvis-token') || '';
if (location.hash) { store.set('jarvis-token', token); history.replaceState(null, '', location.pathname); }

let ws, swReg, actx, ringTimer, currentCallId = null, inCall = false, listening = false, recog, silentTurns = 0, currentAudio = null;

// ---------- Timbre ----------
function ringtoneStart() {
  ringtoneStop();
  const beep = () => {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 880; g.gain.value = 0.15; o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.35);
    navigator.vibrate?.([300, 150, 300]);
  };
  beep(); ringTimer = setInterval(beep, 1500);
}
const ringtoneStop = () => { clearInterval(ringTimer); ringTimer = null; navigator.vibrate?.(0); };

// ---------- Activación ----------
// El primer toque en "Activar" pide permisos (notificaciones/Push). Después la app se reconecta sola al abrirse,
// por ejemplo al tocar la notificación de una llamada.
function ensureAudio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  actx.resume?.();
}

const b64ToBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function enablePush() {
  if (!swReg || !('PushManager' in window) || Notification.permission !== 'granted') return false;
  const { key } = await (await fetch('/api/push-key', { headers: { Authorization: `Bearer ${token}` } })).json();
  const sub = (await swReg.pushManager.getSubscription()) || await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  const r = await fetch('/api/subscribe', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
  return r.ok;
}

async function boot(fromClick) {
  if ('serviceWorker' in navigator) swReg = await navigator.serviceWorker.register('sw.js').catch(() => null);
  if (fromClick && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  const pushOk = await enablePush().catch((e) => { console.warn('Push no disponible:', e.message); return false; });
  store.set('jarvis-active', '1');
  show('start', false);
  connect();
  if (fromClick) setStatus(pushOk ? 'Listo. Te llamaré aunque tengas la app cerrada.' : 'Listo, pero sin avisos con la app cerrada (revisa permisos y que uses HTTPS).');
}

$('start').onclick = () => { ensureAudio(); boot(true); };
if (store.get('jarvis-active') === '1' && token) boot(false);

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/assistant?token=${encodeURIComponent(token)}`);
  ws.onopen = () => {};
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => { setStatus('Desconectado. Reintentando…'); setOrb(''); show('idleBtns', false); setTimeout(connect, 3000); };
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function onMessage(msg) {
  switch (msg.type) {
    case 'ready': if (!inCall && !currentCallId) setStatus('Listo. Te llamaré cuando toque.'); show('idleBtns', !inCall && !currentCallId); break;
    case 'ring':
      if (inCall || currentCallId) return;
      currentCallId = msg.callId; setOrb('ring'); setStatus('📞 Jarvis te está llamando…');
      show('ringBtns', true); show('idleBtns', false); ringtoneStart();
      break;
    case 'ring-cancel':
      if (msg.callId === currentCallId) { currentCallId = null; ringtoneStop(); show('ringBtns', false); if (!inCall) { setOrb(''); setStatus('Llamada perdida.'); show('idleBtns', true); } }
      break;
    case 'say': speak(msg); break;
  }
}

// ---------- Llamada ----------
$('accept').onclick = () => { ensureAudio(); ringtoneStop(); show('ringBtns', false); beginCall(); send({ type: 'answer', callId: currentCallId }); currentCallId = null; };
$('decline').onclick = () => { ringtoneStop(); show('ringBtns', false); send({ type: 'decline', callId: currentCallId }); currentCallId = null; setOrb(''); setStatus('Rechazada. Insistiré en unos minutos.'); show('idleBtns', true); };
$('dial').onclick = () => { ensureAudio(); beginCall(); send({ type: 'dial' }); };
$('hangup').onclick = () => endCall();
$('textForm').onsubmit = (e) => { e.preventDefault(); const t = $('textIn').value.trim(); if (!t) return; $('textIn').value = ''; stopListening(); userSaid(t); };

function beginCall() { inCall = true; silentTurns = 0; $('transcript').textContent = ''; show('idleBtns', false); show('hangup', true); show('textForm', true); setStatus('En llamada…'); }
function endCall() {
  inCall = false; stopListening(); currentAudio?.pause(); speechSynthesis?.cancel();
  send({ type: 'hangup' }); setOrb(''); show('hangup', false); show('textForm', false); show('idleBtns', true); setStatus('Llamada terminada.');
}

function userSaid(text) { log('Tú', text); setOrb(''); setStatus('Pensando…'); send({ type: 'user', text }); }
function log(who, text) { $('transcript').textContent = `${who}: ${text}`; }

// ---------- Voz de Jarvis ----------
async function speak({ text, audio, end }) {
  if (!inCall) return;
  log('Jarvis', text); setOrb('talk'); setStatus('Jarvis habla…'); stopListening();
  await new Promise((resolve) => {
    if (audio) {
      currentAudio = new Audio(`data:audio/wav;base64,${audio}`);
      currentAudio.onended = resolve; currentAudio.onerror = resolve;
      currentAudio.play().catch(resolve);
    } else if ('speechSynthesis' in window) { // respaldo si Piper no está configurado
      const u = new SpeechSynthesisUtterance(text); u.lang = 'es-MX'; u.onend = resolve; u.onerror = resolve; speechSynthesis.speak(u);
    } else resolve();
  });
  if (!inCall) return;
  if (end) return endCall();
  startListening();
}

// ---------- Oído (reconocimiento de voz del navegador) ----------
function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setStatus('Tu navegador no tiene reconocimiento de voz; escribe abajo.'); return; }
  recog = new SR(); recog.lang = 'es-MX'; recog.interimResults = false; recog.maxAlternatives = 1;
  let heard = false;
  recog.onresult = (e) => { heard = true; userSaid(e.results[0][0].transcript); };
  recog.onerror = () => {};
  recog.onend = () => {
    listening = false;
    if (!inCall || heard) return;
    if (++silentTurns >= 3) { setStatus('No te escucho. Cuelgo.'); return endCall(); }
    startListening();
  };
  silentTurns = heard ? 0 : silentTurns;
  try { recog.start(); listening = true; setOrb('listen'); setStatus('Te escucho…'); } catch {}
}
function stopListening() { if (recog && listening) { recog.onend = null; try { recog.abort(); } catch {} } listening = false; }
