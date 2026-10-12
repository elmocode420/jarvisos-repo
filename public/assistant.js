// Cliente del asistente: timbre, llamada, voz (Piper vía servidor o voz del navegador) y reconocimiento de voz.
const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const setOrb = (c) => ($('orb').className = c || '');
const setStatus = (t) => ($('status').textContent = t);

const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
// Token: #hash, ?t= (sobrevive al "añadir a pantalla de inicio" de iOS) o el guardado.
const qs = new URLSearchParams(location.search);
let token = location.hash.slice(1) || qs.get('t') || store.get('jarvis-token') || '';
if (token) store.set('jarvis-token', token);
if (location.hash) history.replaceState(null, '', location.pathname + location.search); // el ?t se queda: el marcador de iOS lo hereda

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

$('start').onclick = () => {
  ensureAudio();
  if (!token) { // plan C (PWA de iOS sin token): pedirlo una sola vez
    const t = (prompt('Pega tu código de acceso de Jarvis:') || '').trim();
    if (!t) { setStatus('Sin código de acceso no puedo conectar.'); return; }
    token = t; store.set('jarvis-token', token);
  }
  boot(true);
};
if (store.get('jarvis-active') === '1' && token) boot(false);

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/assistant?token=${encodeURIComponent(token)}`);
  let opened = false;
  ws.onopen = () => { opened = true; };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = async () => {
    setOrb(''); show('idleBtns', false);
    let why = 'Desconectado. Reintentando…';
    if (!opened) { // nunca llegó a abrir: distinguir token inválido de servidor/red caídos
      try {
        const r = await fetch('/api/push-key', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
        if (r.status === 401) why = 'Código de acceso inválido o vencido. Borra el icono de la pantalla de inicio y vuelve a instalarlo con el enlace nuevo.';
        else if (!r.ok) why = `El servidor respondió ${r.status}. Reintentando…`;
      } catch { why = 'No alcanzo a Jarvis: revisa que Tailscale esté encendido y que la Mac esté despierta. Reintentando…'; }
    }
    setStatus(why);
    setTimeout(connect, 3000);
  };
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

function beginCall() { inCall = true; silentTurns = 0; thinking = false; speaking = false; farewell = false; $('transcript').textContent = ''; show('idleBtns', false); show('hangup', true); show('textForm', true); setStatus('En llamada…'); }
function endCall() {
  inCall = false; thinking = false; speaking = false; farewell = false; clearTimeout(thinkTimer);
  stopListening(); currentAudio?.pause(); speechSynthesis?.cancel();
  send({ type: 'hangup' }); setOrb(''); show('hangup', false); show('textForm', false); show('idleBtns', true); setStatus('Llamada terminada.');
}

// Turnos: el micrófono solo está abierto cuando NI Jarvis piensa NI Jarvis habla.
//   tú hablas → mic OFF · Jarvis piensa → mic OFF · Jarvis responde → mic OFF · termina → mic ON
let thinking = false, speaking = false, farewell = false, thinkTimer = null;
// Despedida: frase corta (≤6 palabras) para no colgar por un "nos vemos" dentro de una orden larga.
const FAREWELL = /(adi[oó]s|hasta luego|hasta pronto|nos vemos|chao|chau|bye|cuelga|eso es todo|es todo por ahora|ya es todo)/i;
const isFarewell = (t) => t.trim().split(/\s+/).length <= 6 && FAREWELL.test(t);

function userSaid(text) {
  stopListening();                       // mic apagado desde que terminas de hablar
  thinking = true; farewell = isFarewell(text);
  log('Tú', text); setOrb(''); setStatus('Pensando… (micrófono apagado)');
  send({ type: 'user', text });
  clearTimeout(thinkTimer);              // red de seguridad: si no llega respuesta, no te quedas mudo
  thinkTimer = setTimeout(() => {
    if (!inCall || !thinking) return;
    thinking = false;
    if (farewell) return endCall();
    setStatus('Jarvis no respondió. Te vuelvo a escuchar…'); startListening();
  }, 60000);
}
function log(who, text) { $('transcript').textContent = `${who}: ${text}`; }

// ---------- Voz de Jarvis ----------
async function speak({ text, audio, end }) {
  if (!inCall) return;
  clearTimeout(thinkTimer); thinking = false; speaking = true;
  log('Jarvis', text); setOrb('talk'); setStatus('Jarvis habla… (micrófono apagado)'); stopListening();
  await new Promise((resolve) => {
    if (audio) {
      currentAudio = new Audio(`data:audio/wav;base64,${audio}`);
      currentAudio.onended = resolve; currentAudio.onerror = resolve;
      currentAudio.play().catch(resolve);
    } else if ('speechSynthesis' in window) { // respaldo si Piper no está configurado
      const u = new SpeechSynthesisUtterance(text); u.lang = 'es-MX'; u.onend = resolve; u.onerror = resolve; speechSynthesis.speak(u);
    } else resolve();
  });
  speaking = false;
  if (!inCall) return;
  if (end || farewell) { farewell = false; return endCall(); }  // despedida: se cierra la llamada y el mic
  startListening();                      // terminó de hablar → el mic vuelve a abrirse
}

// ---------- Oído (reconocimiento de voz del navegador) ----------
function startListening() {
  if (!inCall || thinking || speaking || listening) return;   // nunca abrir el mic mientras Jarvis piensa o habla
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
