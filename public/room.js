/* global LivekitClient */
const { Room, RoomEvent, Track, ParticipantEvent } = LivekitClient;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isHostMode = params.get('host') === '1';

let session = null;       // { token, url, identity, code, title, role, hostIdentity }
let room = null;
let isHost = false;
const raised = new Map(); // identity -> true (hand raised)
let chatLocked = false;
let lastChatAt = 0;
let recording = false;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.display = 'none'), ms);
}
async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------------------------------------------------------------- startup
(async function start() {
  try {
    if (isHostMode) {
      const code = (params.get('code') || '').toUpperCase();
      const data = await api(`/api/host/rooms/${code}/token`);
      session = { ...data, role: 'host', name: 'Teacher' };
      isHost = true;
    } else {
      session = JSON.parse(sessionStorage.getItem('session') || 'null');
      if (!session) {
        location.href = '/';
        return;
      }
    }
  } catch (e) {
    alert(e.message + (isHostMode ? '\nPlease log in again.' : ''));
    location.href = isHostMode ? '/host.html' : '/';
    return;
  }

  $('title').textContent = session.title || 'Class';
  $('me').textContent = session.name;
  if (!isHost) $('peopleTabBtn').style.display = 'none';
  buildControls();
  await connect();
})();

// ---------------------------------------------------------------- connection
async function connect() {
  room = new Room({
    adaptiveStream: true, // only download the resolution that is actually displayed
    dynacast: true,       // teacher's camera only encodes layers someone is watching
    videoCaptureDefaults: { resolution: LivekitClient.VideoPresets.h720 },
    publishDefaults: { simulcast: true, videoCodec: 'vp8' },
  });

  room
    .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
    .on(RoomEvent.LocalTrackPublished, (pub) => {
      if (pub.track && pub.track.kind === 'video') addVideoTile(pub.track, room.localParticipant, pub.source);
      updateControlStates();
    })
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.track) removeTile(pub.track.sid || pub.trackSid);
      removeTile(pub.trackSid);
      updateControlStates();
    })
    .on(RoomEvent.ParticipantConnected, onCountChange)
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      raised.delete(p.identity);
      onCountChange();
    })
    .on(RoomEvent.DataReceived, onData)
    .on(RoomEvent.ParticipantPermissionsChanged, (prev, p) => {
      if (p === room.localParticipant) onLocalPermissionsChanged();
    })
    .on(RoomEvent.Reconnecting, () => toast('Connection lost, reconnecting...', 8000))
    .on(RoomEvent.Reconnected, () => toast('Reconnected'))
    .on(RoomEvent.Disconnected, () => {
      $('title').textContent = 'Class ended or disconnected';
      toast('You have left the class.', 10000);
      $('controls').innerHTML = '<a class="btn" href="' + (isHost ? '/host.html' : '/') + '">Back</a>';
    });

  try {
    await room.connect(session.url, session.token);
  } catch (e) {
    alert('Could not connect: ' + e.message);
    location.href = isHost ? '/host.html' : '/';
    return;
  }

  // Tracks already published before we connected
  room.remoteParticipants.forEach((p) => {
    p.trackPublications.forEach((pub) => {
      if (pub.isSubscribed && pub.track) onTrackSubscribed(pub.track, pub, p);
    });
  });

  onCountChange();
  addSys(isHost ? 'You are the host. Turn on your camera or share your screen to begin.' : 'You joined the class.');

  // Tell the server when a student leaves (for the attendance "left" time).
  if (!isHost) {
    window.addEventListener('pagehide', () => {
      navigator.sendBeacon('/api/leave', JSON.stringify({ code: session.code, identity: session.identity }));
    });
  }
}

// ---------------------------------------------------------------- media tiles
function onTrackSubscribed(track, pub, participant) {
  if (track.kind === Track.Kind.Video) {
    addVideoTile(track, participant, pub.source);
  } else if (track.kind === Track.Kind.Audio) {
    const el = track.attach();
    el.dataset.sid = pub.trackSid;
    document.body.appendChild(el);
  }
}
function onTrackUnsubscribed(track, pub) {
  track.detach().forEach((el) => el.remove());
  removeTile(pub.trackSid);
}
function addVideoTile(track, participant, source) {
  const sid = track.sid || track.mediaStreamTrack.id;
  if (document.querySelector(`[data-tile="${CSS.escape(sid)}"]`)) return;
  const tile = document.createElement('div');
  tile.className = 'tile' + (source === Track.Source.ScreenShare ? ' screen' : '');
  tile.dataset.tile = sid;
  const el = track.attach();
  el.muted = participant === room.localParticipant ? true : el.muted;
  tile.appendChild(el);
  const label = document.createElement('div');
  label.className = 'label';
  const who = participant === room.localParticipant ? 'You' : participant.name || 'Speaker';
  label.textContent = source === Track.Source.ScreenShare ? who + ' (screen)' : who;
  tile.appendChild(label);
  $('stage').appendChild(tile);
  updateWaiting();
}
function removeTile(sid) {
  if (!sid) return;
  const t = document.querySelector(`[data-tile="${CSS.escape(sid)}"]`);
  if (t) t.remove();
  updateWaiting();
}
function updateWaiting() {
  $('waiting').style.display = document.querySelector('.tile') ? 'none' : 'flex';
}

// ---------------------------------------------------------------- counts / people
function onCountChange() {
  const n = room.remoteParticipants.size + 1;
  $('count').textContent = n + (n === 1 ? ' in class' : ' in class');
  if (isHost) renderPeople();
}

function renderPeople() {
  const q = $('filter').value.trim().toLowerCase();
  const list = [];
  room.remoteParticipants.forEach((p) => list.push(p));
  list.sort((a, b) => {
    const ra = raised.has(a.identity) ? 0 : 1;
    const rb = raised.has(b.identity) ? 0 : 1;
    return ra - rb || (a.name || '').localeCompare(b.name || '');
  });
  const shown = list.filter((p) => !q || (p.name || '').toLowerCase().includes(q)).slice(0, 200);
  const handCount = [...raised.keys()].length;
  $('peopleTabBtn').textContent = handCount ? `People (${handCount} ✋)` : 'People';
  $('plist').innerHTML =
    shown
      .map((p) => {
        const speaking = p.permissions && p.permissions.canPublish;
        const isRaised = raised.has(p.identity);
        return `<div class="person ${isRaised ? 'raised' : ''}">
          <span class="nm" title="${esc(p.name)}">${isRaised ? '✋ ' : ''}${esc(p.name || p.identity)}</span>
          <button class="small ${speaking ? 'ghost' : ''}" data-act="speak" data-id="${esc(p.identity)}" data-allow="${speaking ? 0 : 1}">${speaking ? 'Mute' : 'Allow'}</button>
          <button class="small danger" data-act="remove" data-id="${esc(p.identity)}">Remove</button>
        </div>`;
      })
      .join('') ||
    '<div class="hint" style="padding:10px">No students match.</div>';
}
$('filter').addEventListener('input', () => isHost && renderPeople());

$('plist').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  try {
    if (b.dataset.act === 'speak') {
      await api(`/api/host/rooms/${session.code}/allow-speak`, { identity: id, allow: b.dataset.allow === '1' });
      raised.delete(id);
      setTimeout(renderPeople, 400);
    } else if (b.dataset.act === 'remove') {
      if (!confirm('Remove this student from the class?')) return;
      await api(`/api/host/rooms/${session.code}/remove`, { identity: id });
    }
  } catch (ex) {
    toast(ex.message);
  }
});

// ---------------------------------------------------------------- chat + hand raise (data channel)
const enc = new TextEncoder();
const dec = new TextDecoder();

function addMessage(name, text, fromHost) {
  const m = document.createElement('div');
  m.className = 'msg' + (fromHost ? ' host' : '');
  m.innerHTML = `<div class="who">${esc(name)}${fromHost ? ' (teacher)' : ''}</div><div>${esc(text)}</div>`;
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.appendChild(m);
  // keep the DOM light in a 500-person chat
  while (box.children.length > 300) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function addSys(text) {
  const m = document.createElement('div');
  m.className = 'msg sys';
  m.textContent = text;
  $('messages').appendChild(m);
}

function onData(payload, participant, kind, topic) {
  let msg;
  try {
    msg = JSON.parse(dec.decode(payload));
  } catch (_) {
    return;
  }
  // Use the server-verified participant name, never a name inside the payload.
  const senderName = participant ? participant.name || 'Student' : 'Student';
  const fromHost = participant && participant.identity === session.hostIdentity || (participant && participant.identity.startsWith('host-'));

  if (topic === 'chat') {
    if (typeof msg.text !== 'string') return;
    addMessage(senderName, msg.text.slice(0, 400), fromHost);
  } else if (topic === 'hand' && isHost && participant) {
    if (msg.raised) {
      raised.set(participant.identity, true);
      toast(`✋ ${senderName} raised a hand`);
    } else {
      raised.delete(participant.identity);
    }
    renderPeople();
  } else if (topic === 'chatlock' && fromHost) {
    chatLocked = !!msg.locked;
    updateChatState();
    addSys(chatLocked ? 'The teacher turned chat off.' : 'The teacher turned chat on.');
  } else if (topic === 'recording' && fromHost) {
    setRecording(!!msg.active);
  }
}

function updateChatState() {
  const disabled = !isHost && chatLocked;
  $('chatInput').disabled = disabled;
  $('chatSend').disabled = disabled;
  $('chatInput').placeholder = disabled ? 'Chat is turned off' : 'Type a message';
}

$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || !room) return;
  const now = Date.now();
  if (!isHost && now - lastChatAt < 2000) {
    toast('Please wait a moment before sending again.');
    return;
  }
  lastChatAt = now;
  $('chatInput').value = '';
  const data = enc.encode(JSON.stringify({ text }));
  await room.localParticipant.publishData(data, { reliable: true, topic: 'chat' });
  addMessage('You', text, isHost);
});

async function sendToAll(topic, obj) {
  await room.localParticipant.publishData(enc.encode(JSON.stringify(obj)), { reliable: true, topic });
}

// ---------------------------------------------------------------- controls
let handUp = false;

function btn(id, label, cls = '') {
  return `<button id="${id}" class="${cls}">${label}</button>`;
}

function buildControls() {
  if (isHost) {
    $('controls').innerHTML = [
      btn('bMic', 'Mic', 'ghost'),
      btn('bCam', 'Camera', 'ghost'),
      btn('bScreen', 'Share screen', 'ghost'),
      btn('bChat', 'Turn chat off', 'ghost'),
      btn('bRec', 'Start recording', 'ghost'),
      `<a class="btn ghost" href="/api/host/rooms/${session.code}/attendance.csv">Attendance CSV</a>`,
      btn('bEnd', 'End class', 'danger'),
    ].join('');

    $('bMic').onclick = () => toggleLocal('mic');
    $('bCam').onclick = () => toggleLocal('cam');
    $('bScreen').onclick = () => toggleLocal('screen');
    $('bChat').onclick = async () => {
      chatLocked = !chatLocked;
      $('bChat').textContent = chatLocked ? 'Turn chat on' : 'Turn chat off';
      await sendToAll('chatlock', { locked: chatLocked });
      addSys(chatLocked ? 'You turned student chat off.' : 'You turned student chat on.');
    };
    $('bRec').onclick = async () => {
      try {
        if (!recording) {
          await api(`/api/host/rooms/${session.code}/record/start`);
          setRecording(true);
          await sendToAll('recording', { active: true });
        } else {
          await api(`/api/host/rooms/${session.code}/record/stop`);
          setRecording(false);
          await sendToAll('recording', { active: false });
          toast('Recording stopped and is being saved.');
        }
      } catch (ex) {
        toast(ex.message, 6000);
      }
    };
    $('bEnd').onclick = async () => {
      if (!confirm('End the class for everyone?')) return;
      try {
        await fetch(`/api/host/rooms/${session.code}`, { method: 'DELETE' });
      } catch (_) {}
      location.href = '/host.html';
    };
  } else {
    $('controls').innerHTML = [
      btn('bHand', '✋ Raise hand', 'ghost'),
      btn('bMic', 'Mic', 'ghost" style="display:none'),
      btn('bCam', 'Camera', 'ghost" style="display:none'),
      btn('bLeave', 'Leave', 'danger'),
    ].join('');

    $('bHand').onclick = async () => {
      handUp = !handUp;
      $('bHand').textContent = handUp ? '✋ Lower hand' : '✋ Raise hand';
      try {
        await room.localParticipant.publishData(enc.encode(JSON.stringify({ raised: handUp })), {
          reliable: true,
          topic: 'hand',
          destinationIdentities: [session.hostIdentity],
        });
      } catch (ex) {
        toast('Could not send. Check your connection.');
      }
    };
    $('bMic').onclick = () => toggleLocal('mic');
    $('bCam').onclick = () => toggleLocal('cam');
    $('bLeave').onclick = async () => {
      if (!confirm('Leave this class?')) return;
      try {
        navigator.sendBeacon('/api/leave', JSON.stringify({ code: session.code, identity: session.identity }));
        await room.disconnect();
      } catch (_) {}
      location.href = '/';
    };
  }
  updateChatState();
}

async function toggleLocal(what) {
  const lp = room.localParticipant;
  try {
    if (what === 'mic') await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled);
    if (what === 'cam') await lp.setCameraEnabled(!lp.isCameraEnabled);
    if (what === 'screen') await lp.setScreenShareEnabled(!lp.isScreenShareEnabled, { audio: true });
  } catch (ex) {
    toast('Could not turn that on: ' + ex.message, 5000);
  }
  updateControlStates();
}

function updateControlStates() {
  if (!room) return;
  const lp = room.localParticipant;
  const set = (id, on, onLabel, offLabel) => {
    const b = $(id);
    if (!b) return;
    b.textContent = on ? onLabel : offLabel;
    b.classList.toggle('off', false);
    b.classList.toggle('ghost', !on);
  };
  set('bMic', lp.isMicrophoneEnabled, 'Mute mic', 'Mic off');
  set('bCam', lp.isCameraEnabled, 'Stop camera', 'Camera off');
  if (isHost) set('bScreen', lp.isScreenShareEnabled, 'Stop sharing', 'Share screen');
}

function onLocalPermissionsChanged() {
  if (isHost) return;
  const can = room.localParticipant.permissions && room.localParticipant.permissions.canPublish;
  $('bMic').style.display = can ? '' : 'none';
  $('bCam').style.display = can ? '' : 'none';
  if (can) {
    toast('The teacher allowed you to speak. Use the Mic and Camera buttons.', 6000);
    handUp = false;
    $('bHand').textContent = '✋ Raise hand';
    updateControlStates();
  } else {
    // Permission revoked: media is unpublished by the server automatically.
    toast('The teacher turned your microphone off.');
  }
}

function setRecording(active) {
  recording = active;
  $('recPill').style.display = active ? '' : 'none';
  if (isHost && $('bRec')) $('bRec').textContent = active ? 'Stop recording' : 'Start recording';
}

// ---------------------------------------------------------------- tabs
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab));
    if (b.dataset.tab === 'people' && isHost) renderPeople();
  });
});
