// Cliente WebRTC de voz. STUN público de Google para atravesar NAT (gratis).
// Para redes muy restrictivas añade un servidor TURN (p. ej. coturn) en ICE_SERVERS.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const $ = (id) => document.getElementById(id);
let ws, me, peer = null, remoteName = null, localStream = null, pendingOffer = null, pendingIce = [];

const status = (t) => ($('status').textContent = t);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

$('join').onclick = () => {
  const name = $('name').value.trim();
  if (!name) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'register', name }));
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => { status('Desconectado del servidor'); cleanup(); };
};

const send = (msg) => ws.send(JSON.stringify(msg));

async function onMessage(msg) {
  switch (msg.type) {
    case 'registered':
      me = msg.name; $('me').textContent = me; show('login', false); show('app', true); break;
    case 'error': alert(msg.error); break;
    case 'users': renderUsers(msg.users); break;
    case 'unavailable': status(`${msg.to} no está disponible`); cleanup(); break;
    case 'offer':
      if (peer || pendingOffer) return send({ type: 'reject', to: msg.from }); // ocupado
      pendingOffer = msg; pendingIce = [];
      $('caller').textContent = msg.from; show('incoming', true); break;
    case 'answer':
      await peer?.setRemoteDescription(msg.sdp); await flushIce(); status(`En llamada con ${remoteName}`); break;
    case 'ice':
      if (peer?.remoteDescription) await peer.addIceCandidate(msg.candidate);
      else pendingIce.push(msg.candidate);
      break;
    case 'reject': status(`${msg.from} rechazó o está ocupado`); cleanup(); break;
    case 'hangup': status(`${msg.from} colgó`); cleanup(); break;
  }
}

function renderUsers(list) {
  const ul = $('users'); ul.innerHTML = '';
  for (const u of list.filter((n) => n !== me)) {
    const li = document.createElement('li');
    const span = document.createElement('span'); span.textContent = u;
    const btn = document.createElement('button'); btn.className = 'call'; btn.textContent = 'Llamar';
    btn.onclick = () => startCall(u);
    li.append(span, btn); ul.append(li);
  }
}

async function createPeer(other) {
  remoteName = other;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach((t) => peer.addTrack(t, localStream));
  peer.ontrack = (e) => ($('remote').srcObject = e.streams[0]);
  peer.onicecandidate = (e) => e.candidate && send({ type: 'ice', to: other, candidate: e.candidate });
  peer.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(peer?.connectionState)) { status('Llamada terminada'); cleanup(); }
  };
  show('hangup', true);
}

async function startCall(other) {
  if (peer) return;
  try {
    status(`Llamando a ${other}…`);
    await createPeer(other);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    send({ type: 'offer', to: other, sdp: peer.localDescription });
  } catch (err) { status(`Error: ${err.message}`); cleanup(); }
}

$('accept').onclick = async () => {
  const { from, sdp } = pendingOffer; pendingOffer = null; show('incoming', false);
  try {
    await createPeer(from);
    await peer.setRemoteDescription(sdp); await flushIce();
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    send({ type: 'answer', to: from, sdp: peer.localDescription });
    status(`En llamada con ${from}`);
  } catch (err) { status(`Error: ${err.message}`); cleanup(); }
};

$('decline').onclick = () => { send({ type: 'reject', to: pendingOffer.from }); pendingOffer = null; show('incoming', false); };
$('hangup').onclick = () => { if (remoteName) send({ type: 'hangup', to: remoteName }); status('Llamada terminada'); cleanup(); };

async function flushIce() { for (const c of pendingIce) await peer.addIceCandidate(c); pendingIce = []; }

function cleanup() {
  peer?.close(); peer = null; remoteName = null; pendingOffer = null; pendingIce = [];
  localStream?.getTracks().forEach((t) => t.stop()); localStream = null;
  $('remote').srcObject = null; show('hangup', false); show('incoming', false);
}
