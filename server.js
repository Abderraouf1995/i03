// io3 Community — serveur (API + chat temps réel)
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// En production, DATA_DIR pointe vers un disque persistant (ex. /var/data)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Secret JWT (env ou généré une fois) ----------
const secretFile = path.join(DATA_DIR, '.jwt_secret');
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (fs.existsSync(secretFile)
    ? fs.readFileSync(secretFile, 'utf8')
    : (() => {
        const s = crypto.randomBytes(48).toString('hex');
        fs.writeFileSync(secretFile, s);
        return s;
      })());

// ---------- Base de données ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'io3.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  version TEXT NOT NULL CHECK (version IN ('4X2','4X4')),
  city TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL CHECK (version IN ('4X2','4X4')),
  distance_km REAL NOT NULL,
  battery_start INTEGER NOT NULL,
  battery_end INTEGER NOT NULL,
  consumption REAL,            -- kWh/100 km affiché par la voiture (optionnel)
  temp_c REAL,
  route_type TEXT NOT NULL,    -- ville / route / autoroute / mixte
  avg_speed REAL,
  climate INTEGER NOT NULL DEFAULT 0,
  drive_mode TEXT,             -- eco / normal / sport
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT,
  trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Autonomie estimée pour 100 % de batterie à partir du % consommé
const estRange = (t) => {
  const used = t.battery_start - t.battery_end;
  return used > 0 ? Math.round((t.distance_km / used) * 100) : null;
};
const withRange = (t) => (t ? { ...t, climate: !!t.climate, est_range_km: estRange(t) } : t);

const TRIP_SELECT = `
  SELECT t.*, u.username FROM trips t JOIN users u ON u.id = t.user_id`;
const MSG_SELECT = `
  SELECT m.id, m.text, m.trip_id, m.created_at, u.username, u.version AS user_version
  FROM messages m JOIN users u ON u.id = m.user_id`;

const hydrateMessage = (m) => {
  if (!m) return m;
  const trip = m.trip_id ? db.prepare(`${TRIP_SELECT} WHERE t.id = ?`).get(m.trip_id) : null;
  return { ...m, trip: withRange(trip) || null };
};

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
// Derrière le proxy HTTPS de l'hébergeur : vraie IP client (anti-bruteforce) et protocole
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sign = (u) => jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: '30d' });
const publicUser = (u) => ({ id: u.id, username: u.username, email: u.email, version: u.version, city: u.city, created_at: u.created_at });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user) throw new Error('no user');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée, reconnecte-toi.' });
  }
}

// Petit limiteur anti-bruteforce en mémoire
const attempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of attempts) if (!list.some((t) => now - t < 15 * 60_000)) attempts.delete(k);
}, 10 * 60_000).unref();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60_000);
  if (list.length >= 20) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 min.' });
  list.push(now);
  attempts.set(key, list);
  next();
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

// ---- Auth ----
app.post('/api/register', rateLimit, (req, res) => {
  const username = str(req.body.username, 30);
  const email = str(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const version = req.body.version === '4X4' ? '4X4' : '4X2';
  const city = str(req.body.city, 60) || null;

  if (!/^[\p{L}0-9_.-]{3,30}$/u.test(username))
    return res.status(400).json({ error: "Pseudo : 3 à 30 caractères (lettres, chiffres, _ . -)." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email invalide.' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' });

  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(username, email);
  if (exists) return res.status(409).json({ error: 'Pseudo ou email déjà utilisé.' });

  const hash = bcrypt.hashSync(password, 10);
  const r = db
    .prepare('INSERT INTO users (username, email, password_hash, version, city) VALUES (?,?,?,?,?)')
    .run(username, email, hash, version, city);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/login', rateLimit, (req, res) => {
  const login = str(req.body.login, 120);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', auth, (req, res) => {
  const version = req.body.version === '4X4' ? '4X4' : req.body.version === '4X2' ? '4X2' : req.user.version;
  const city = req.body.city !== undefined ? str(req.body.city, 60) || null : req.user.city;
  db.prepare('UPDATE users SET version = ?, city = ? WHERE id = ?').run(version, city, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ---- Trajets ----
app.get('/api/trips', auth, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.version === '4X2' || req.query.version === '4X4') { where.push('t.version = ?'); args.push(req.query.version); }
  if (req.query.mine === '1') { where.push('t.user_id = ?'); args.push(req.user.id); }
  const sql = `${TRIP_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC, t.id DESC LIMIT 200`;
  res.json({ trips: db.prepare(sql).all(...args).map(withRange) });
});

app.post('/api/trips', auth, (req, res) => {
  const b = req.body;
  const t = {
    version: b.version === '4X4' ? '4X4' : '4X2',
    distance_km: num(b.distance_km),
    battery_start: num(b.battery_start),
    battery_end: num(b.battery_end),
    consumption: num(b.consumption),
    temp_c: num(b.temp_c),
    route_type: ['ville', 'route', 'autoroute', 'mixte'].includes(b.route_type) ? b.route_type : 'mixte',
    avg_speed: num(b.avg_speed),
    climate: b.climate ? 1 : 0,
    drive_mode: ['eco', 'normal', 'sport'].includes(b.drive_mode) ? b.drive_mode : null,
    notes: str(b.notes, 1000) || null,
  };
  if (!(t.distance_km > 0 && t.distance_km < 2000)) return res.status(400).json({ error: 'Distance invalide (km).' });
  if (!(t.battery_start >= 0 && t.battery_start <= 100 && t.battery_end >= 0 && t.battery_end <= 100))
    return res.status(400).json({ error: 'Batterie : valeurs entre 0 et 100 %.' });
  if (t.battery_end >= t.battery_start) return res.status(400).json({ error: 'La batterie de fin doit être inférieure à celle du départ.' });
  if (t.consumption !== null && !(t.consumption > 0 && t.consumption < 60)) return res.status(400).json({ error: 'Consommation invalide (kWh/100 km).' });
  if (t.temp_c !== null && !(t.temp_c > -40 && t.temp_c < 60)) return res.status(400).json({ error: 'Température invalide.' });
  if (t.avg_speed !== null && !(t.avg_speed > 0 && t.avg_speed < 250)) return res.status(400).json({ error: 'Vitesse moyenne invalide.' });

  const r = db
    .prepare(`INSERT INTO trips (user_id, version, distance_km, battery_start, battery_end, consumption, temp_c, route_type, avg_speed, climate, drive_mode, notes)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, t.version, t.distance_km, t.battery_start, t.battery_end, t.consumption, t.temp_c, t.route_type, t.avg_speed, t.climate, t.drive_mode, t.notes);
  const trip = withRange(db.prepare(`${TRIP_SELECT} WHERE t.id = ?`).get(r.lastInsertRowid));

  if (b.share) postMessage(req.user.id, str(b.share_text, 500) || null, trip.id);
  res.status(201).json({ trip });
});

app.delete('/api/trips/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM trips WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Trajet introuvable.' });
  res.json({ ok: true });
});

// ---- Statistiques 4X2 vs 4X4 ----
app.get('/api/stats', auth, (req, res) => {
  const out = {};
  for (const v of ['4X2', '4X4']) {
    const rows = db.prepare('SELECT * FROM trips WHERE version = ?').all(v);
    const ranges = rows.map(estRange).filter((x) => x);
    const cons = rows.map((r) => r.consumption).filter((x) => x);
    const byRoute = {};
    for (const rt of ['ville', 'route', 'autoroute', 'mixte']) {
      const rr = rows.filter((r) => r.route_type === rt).map(estRange).filter((x) => x);
      byRoute[rt] = rr.length ? Math.round(rr.reduce((a, b) => a + b, 0) / rr.length) : null;
    }
    const cold = rows.filter((r) => r.temp_c !== null && r.temp_c < 10).map(estRange).filter((x) => x);
    const warm = rows.filter((r) => r.temp_c !== null && r.temp_c >= 10).map(estRange).filter((x) => x);
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    out[v] = {
      trips: rows.length,
      total_km: Math.round(rows.reduce((a, r) => a + r.distance_km, 0)),
      avg_range_km: avg(ranges),
      max_range_km: ranges.length ? Math.max(...ranges) : null,
      avg_consumption: cons.length ? Math.round((cons.reduce((a, b) => a + b, 0) / cons.length) * 10) / 10 : null,
      by_route: byRoute,
      cold_range_km: avg(cold),
      warm_range_km: avg(warm),
    };
  }
  out.members = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json(out);
});

// ---- Chat ----
app.get('/api/messages', auth, (req, res) => {
  const rows = db.prepare(`${MSG_SELECT} ORDER BY m.id DESC LIMIT 100`).all().reverse();
  res.json({ messages: rows.map(hydrateMessage) });
});

app.post('/api/trips/:id/share', auth, (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(Number(req.params.id));
  if (!trip) return res.status(404).json({ error: 'Trajet introuvable.' });
  const msg = postMessage(req.user.id, str(req.body.text, 500) || null, trip.id);
  res.status(201).json({ message: msg });
});

const server = http.createServer(app);
const io = new Server(server);

function postMessage(userId, text, tripId = null) {
  const r = db.prepare('INSERT INTO messages (user_id, text, trip_id) VALUES (?,?,?)').run(userId, text, tripId);
  const msg = hydrateMessage(db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(r.lastInsertRowid));
  io.emit('message', msg);
  return msg;
}

io.use((socket, next) => {
  try {
    const p = jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(p.id);
    if (!user) throw new Error();
    socket.user = user;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

const online = new Map();
const broadcastOnline = () => io.emit('online', [...new Set(online.values())]);

io.on('connection', (socket) => {
  online.set(socket.id, socket.user.username);
  broadcastOnline();
  let last = 0;
  socket.on('message', (text) => {
    const t = str(text, 1000);
    const now = Date.now();
    if (!t || now - last < 500) return; // anti-spam simple
    last = now;
    postMessage(socket.user.id, t);
  });
  socket.on('disconnect', () => {
    online.delete(socket.id);
    broadcastOnline();
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`io3 Community → http://localhost:${PORT}`));
