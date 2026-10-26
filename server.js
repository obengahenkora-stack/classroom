require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  AccessToken,
  RoomServiceClient,
  WebhookReceiver,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
} = require('livekit-server-sdk');

const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  HOST_PASSWORD,
  SESSION_SECRET = 'dev-secret',
  PORT = 3000,
  MAX_PARTICIPANTS = 550,
} = process.env;

for (const [k, v] of Object.entries({ LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, HOST_PASSWORD })) {
  if (!v) {
    console.error(`Missing ${k} in .env (see .env.example)`);
    process.exit(1);
  }
}

const httpUrl = LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const roomService = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const egress = new EgressClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const webhookReceiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// ---------- tiny JSON persistence (rooms + attendance survive restarts) ----------
// On a host with a persistent disk, set DATA_DIR to the disk's mount path (e.g. /var/data).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
let db = { rooms: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (_) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(db), () => {}), 500);
}

// ---------- helpers ----------
const app = express();
// The host (Render, Railway, ...) puts a proxy in front of the app. Trust it so req.ip
// is the student's real address and req.secure reflects HTTPS.
app.set('trust proxy', 1);

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += alphabet[crypto.randomInt(alphabet.length)];
    if (!db.rooms[c]) return c;
  }
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}
function makeHostCookie() {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  return `${exp}.${sign(String(exp))}`;
}
function isHost(req) {
  const m = /(?:^|;\s*)host=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function requireHost(req, res, next) {
  if (!isHost(req)) return res.status(401).json({ error: 'Host login required' });
  next();
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Simple per-IP rate limit for the public join endpoint
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const rec = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    // Many students may share one campus IP, so keep the limit generous.
    if (rec.length >= max) return res.status(429).json({ error: 'Too many attempts, wait a moment.' });
    rec.push(now);
    hits.set(ip, rec);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const f = arr.filter((t) => now - t < 60000);
    f.length ? hits.set(ip, f) : hits.delete(ip);
  }
}, 60000).unref();

// ---------- LiveKit webhook (must be raw body, registered before express.json) ----------
app.post('/api/livekit-webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const event = await webhookReceiver.receive(req.body.toString(), req.get('Authorization'));
    const code = event.room && event.room.name;
    const room = db.rooms[code];
    if (room && event.participant && event.event === 'participant_left') {
      markLeft(room, event.participant.identity);
    }
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(400);
  }
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function markLeft(room, identity) {
  const rec = room.attendance.find((a) => a.identity === identity && !a.leftAt);
  if (rec) {
    rec.leftAt = new Date().toISOString();
    save();
  }
}

// ---------- host auth ----------
app.post('/api/host/login', rateLimit(10, 60000), (req, res) => {
  const given = Buffer.from(String(req.body.password || ''));
  const real = Buffer.from(HOST_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  res.setHeader(
    'Set-Cookie',
    `host=${makeHostCookie()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}${req.secure ? '; Secure' : ''}`
  );
  res.json({ ok: true });
});
app.post('/api/host/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'host=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/host/me', (req, res) => res.json({ host: isHost(req) }));

// ---------- host: rooms ----------
app.post('/api/host/rooms', requireHost, async (req, res) => {
  const title = cleanName(req.body.title) || 'Class session';
  const code = makeCode();
  try {
    await roomService.createRoom({
      name: code,
      maxParticipants: Number(MAX_PARTICIPANTS),
      emptyTimeout: 60 * 30,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Could not create room on LiveKit: ' + e.message });
  }
  db.rooms[code] = { code, title, createdAt: new Date().toISOString(), attendance: [], recording: null };
  save();
  res.json({ code, title });
});

app.get('/api/host/rooms', requireHost, (req, res) => {
  const list = Object.values(db.rooms)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({
      code: r.code,
      title: r.title,
      createdAt: r.createdAt,
      attended: new Set(r.attendance.map((a) => a.name.toLowerCase())).size,
      recording: !!(r.recording && r.recording.active),
    }));
  res.json(list);
});

app.post('/api/host/rooms/:code/token', requireHost, async (req, res) => {
  const room = db.rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const identity = 'host-' + room.code;
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: 'Teacher',
    ttl: '12h',
    metadata: JSON.stringify({ role: 'host' }),
  });
  at.addGrant({
    roomJoin: true,
    room: room.code,
    roomAdmin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  res.json({ token: await at.toJwt(), url: LIVEKIT_URL, identity, title: room.title, code: room.code });
});

app.delete('/api/host/rooms/:code', requireHost, async (req, res) => {
  const room = db.rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  try {
    await roomService.deleteRoom(room.code);
  } catch (_) {}
  const now = new Date().toISOString();
  room.attendance.forEach((a) => {
    if (!a.leftAt) a.leftAt = now;
  });
  save();
  res.json({ ok: true });
});

// Host actions on individual participants
app.post('/api/host/rooms/:code/allow-speak', requireHost, async (req, res) => {
  const { identity, allow } = req.body;
  if (!identity) return res.status(400).json({ error: 'identity required' });
  try {
    await roomService.updateParticipant(req.params.code, identity, undefined, {
      canSubscribe: true,
      canPublish: !!allow,
      canPublishData: true,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/host/rooms/:code/remove', requireHost, async (req, res) => {
  try {
    await roomService.removeParticipant(req.params.code, req.body.identity);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- host: attendance ----------
app.get('/api/host/rooms/:code/attendance.csv', requireHost, (req, res) => {
  const room = db.rooms[req.params.code];
  if (!room) return res.status(404).send('Room not found');
  const rows = [['Official name', 'Joined at (UTC)', 'Left at (UTC)', 'Minutes present']];
  for (const a of room.attendance) {
    const end = a.leftAt ? new Date(a.leftAt) : new Date();
    const mins = Math.max(0, Math.round((end - new Date(a.joinedAt)) / 60000));
    rows.push([a.name, a.joinedAt, a.leftAt || 'still in class', mins]);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${room.code}.csv"`);
  res.send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n'));
});

// ---------- host: recording (needs LiveKit Egress, see README) ----------
app.post('/api/host/rooms/:code/record/start', requireHost, async (req, res) => {
  const room = db.rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.recording && room.recording.active) return res.status(400).json({ error: 'Already recording' });
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filepath = `recordings/${room.code}-${stamp}.mp4`;
    const output = new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath });
    const info = await egress.startRoomCompositeEgress(room.code, output, { layout: 'speaker' });
    room.recording = { active: true, egressId: info.egressId, filepath, startedAt: new Date().toISOString() };
    save();
    res.json({ ok: true, filepath });
  } catch (e) {
    res.status(500).json({
      error: 'Recording failed to start. Is LiveKit Egress enabled for your project? ' + e.message,
    });
  }
});
app.post('/api/host/rooms/:code/record/stop', requireHost, async (req, res) => {
  const room = db.rooms[req.params.code];
  if (!room || !room.recording || !room.recording.active) return res.status(400).json({ error: 'Not recording' });
  try {
    await egress.stopEgress(room.recording.egressId);
    room.recording.active = false;
    room.recording.stoppedAt = new Date().toISOString();
    save();
    res.json({ ok: true, filepath: room.recording.filepath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- public: student join ----------
// Generous limit: a whole campus may share one public IP address and join at once.
app.post('/api/join', rateLimit(1500, 60000), async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const name = cleanName(req.body.name);
  const room = db.rooms[code];
  if (!room) return res.status(404).json({ error: 'No class found with that code.' });
  if (name.split(' ').filter(Boolean).length < 2 || name.length < 5) {
    return res.status(400).json({ error: 'Please type your full official name (first and last name).' });
  }

  const identity = 'stu-' + crypto.randomBytes(6).toString('hex');
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: '6h',
    metadata: JSON.stringify({ role: 'student' }),
  });
  // Students watch and listen, and can chat (data messages) but not publish video/audio
  // until the teacher grants permission.
  at.addGrant({
    roomJoin: true,
    room: code,
    canSubscribe: true,
    canPublish: false,
    canPublishData: true,
  });

  room.attendance.push({ identity, name, joinedAt: new Date().toISOString(), leftAt: null });
  save();
  res.json({
    token: await at.toJwt(),
    url: LIVEKIT_URL,
    identity,
    name,
    title: room.title,
    hostIdentity: 'host-' + code,
  });
});

// Beacon so attendance "left" time is accurate even without webhooks
app.post('/api/leave', express.text({ type: '*/*' }), (req, res) => {
  try {
    const { code, identity } = JSON.parse(req.body);
    const room = db.rooms[String(code).toUpperCase()];
    if (room && /^stu-[0-9a-f]+$/.test(identity)) markLeft(room, identity);
  } catch (_) {}
  res.sendStatus(204);
});

app.listen(PORT, () => console.log(`Classroom running on http://localhost:${PORT}`));
