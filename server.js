'use strict';

const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const express = require('express');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const SCHOOL_NAME = process.env.SCHOOL_NAME || 'Benedito Cláudio';

const CLASSROOMS = ['8D'];
const CLASSROOM_SET = new Set(CLASSROOMS);

const DB_FILE = path.join(ROOT, 'database.json');
const AUTH_FILE = path.join(ROOT, '.auth.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'views');
const FACEAPI_DIST = path.join(ROOT, 'node_modules', '@vladmandic', 'face-api', 'dist');
const FACEAPI_MODELS = path.join(ROOT, 'node_modules', '@vladmandic', 'face-api', 'model');

const SESSION_COOKIE = 'bc_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err && err.stack ? err.stack : err);
});

let dbCache = null;
let writeChain = Promise.resolve();

function emptyDb() {
  const now = new Date().toISOString();
  return {
    meta: { version: 2, engine: 'json', school: SCHOOL_NAME, createdAt: now, updatedAt: now },
    users: [],
    attendance: { sessions: {} },
    glassesModel: null,
  };
}

function normalizeDb(data) {
  if (!data || typeof data !== 'object') return emptyDb();
  if (!Array.isArray(data.users)) data.users = [];
  if (!data.meta || typeof data.meta !== 'object') data.meta = { version: 2, engine: 'json' };
  if (!data.attendance || typeof data.attendance !== 'object') data.attendance = { sessions: {} };
  if (!data.attendance.sessions || typeof data.attendance.sessions !== 'object') {
    data.attendance.sessions = {};
  }

  const sessions = data.attendance.sessions;
  const isFlat = Object.keys(sessions).some(
    (k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && sessions[k] && sessions[k].date
  );
  if (isFlat) {
    const nested = {};
    for (const [key, value] of Object.entries(sessions)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && value && value.date) {
        const room = value.classroom || 'Sem sala';
        if (!nested[room]) nested[room] = {};
        nested[room][key] = value;
      } else {
        nested[key] = value;
      }
    }
    data.attendance.sessions = nested;
  }
  if (!('glassesModel' in data)) data.glassesModel = null;
  return data;
}

async function readDb() {
  if (dbCache) return dbCache;
  try {
    const raw = await fsp.readFile(DB_FILE, 'utf8');
    dbCache = normalizeDb(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      dbCache = emptyDb();
      await writeDb();
    } else {
      console.error('[db] database.json invalido, criando backup e recomecando:', err.message);
      try {
        await fsp.rename(DB_FILE, `${DB_FILE}.corrupt-${Date.now()}`);
      } catch (_) {

      }
      dbCache = emptyDb();
      await writeDb();
    }
  }
  return dbCache;
}

function writeDb() {
  const snapshot = JSON.stringify(dbCache, null, 2);
  writeChain = writeChain
    .then(async () => {

      try {
        await fsp.copyFile(DB_FILE, path.join(ROOT, 'database.backup.json'));
      } catch (_) {

      }
      const tmp = `${DB_FILE}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, DB_FILE);
    })
    .catch((err) => console.error('[db] falha ao salvar:', err.message));
  return writeChain;
}

function sanitizeString(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function todayLocal(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeDescriptors(body) {
  const raw = [];
  if (Array.isArray(body.descriptors)) raw.push(...body.descriptors);
  if (typeof body.descriptor === 'string') raw.push(body.descriptor);

  const out = [];
  for (const item of raw) {
    let arr = item;
    if (typeof item === 'string') {
      try {
        arr = JSON.parse(item);
      } catch (_) {
        return { error: 'descriptor invalido: nao e um JSON valido' };
      }
    }
    if (!Array.isArray(arr) || arr.length !== 128) {
      return { error: 'descriptor invalido: esperado vetor de 128 numeros' };
    }
    if (!arr.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return { error: 'descriptor invalido: contem valores nao numericos' };
    }
    out.push(JSON.stringify(arr));
  }
  if (out.length === 0) return { error: 'descriptor obrigatorio (vetor facial)' };
  return { descriptors: out };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    classroom: user.classroom || null,
    rollNumber: user.rollNumber == null ? null : user.rollNumber,
    photo: user.photo || null,
    descriptors: user.descriptors,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    sampleCount: Array.isArray(user.descriptors) ? user.descriptors.length : 0,
  };
}

function sanitizePhoto(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('data:image/')) return undefined;
  if (value.length > 800000) return undefined;
  return value;
}

function byRoll(a, b) {
  const ra = a.rollNumber == null ? Infinity : a.rollNumber;
  const rb = b.rollNumber == null ? Infinity : b.rollNumber;
  if (ra !== rb) return ra - rb;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

let authConfig = null;

async function loadAuth() {
  try {
    authConfig = JSON.parse(await fsp.readFile(AUTH_FILE, 'utf8'));
    if (!authConfig.secret || !authConfig.hash || !authConfig.salt) throw new Error('incompleto');
  } catch (_) {
    const password = process.env.TEACHER_PASSWORD || 'benedito';
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    authConfig = {
      salt,
      hash,
      secret: crypto.randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    await fsp.writeFile(AUTH_FILE, JSON.stringify(authConfig, null, 2));
    if (!process.env.TEACHER_PASSWORD) {
      console.log(`[auth] Senha inicial do professor: "${password}" (troque definindo TEACHER_PASSWORD)`);
    }
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyPassword(password) {
  if (!authConfig || typeof password !== 'string') return false;
  const hash = crypto.scryptSync(password, authConfig.salt, 64).toString('hex');
  return safeEqual(hash, authConfig.hash);
}

function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', authConfig.secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !authConfig) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', authConfig.secret).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof obj.exp === 'number' && obj.exp > Date.now();
  } catch (_) {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isTeacher(req) {
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}

function requireTeacher(req, res, next) {
  if (isTeacher(req)) return next();
  res.status(401).json({ error: 'Acesso restrito ao professor. Faca login.' });
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${
    SESSION_TTL_MS / 1000
  }; SameSite=Strict`;
}

function roomSessions(db, classroom) {
  if (!db.attendance.sessions[classroom]) db.attendance.sessions[classroom] = {};
  return db.attendance.sessions[classroom];
}

function getSession(db, classroom, date) {
  return (db.attendance.sessions[classroom] || {})[date] || null;
}

function ensureSession(db, classroom, date, open, durationMin) {
  const room = roomSessions(db, classroom);
  if (!room[date]) {
    room[date] = {
      date,
      classroom,
      open: open !== false,
      openedAt: new Date().toISOString(),
      closedAt: null,
      durationMin: null,
      expiresAt: null,
      records: {},
    };
  }
  return room[date];
}

function resolveSession(session, nowMs) {
  const now = nowMs || Date.now();
  if (!session) return false;
  if (session.open && session.expiresAt && now >= Date.parse(session.expiresAt)) {
    session.open = false;
    session.closedAt = session.expiresAt;
    session.autoClosed = true;
    return true;
  }
  return false;
}

function sessionActive(session, nowMs) {
  const now = nowMs || Date.now();
  return !!(session && session.open && (!session.expiresAt || now < Date.parse(session.expiresAt)));
}

function sessionRemainingMs(session, nowMs) {
  if (!session || !session.open || !session.expiresAt) return null;
  const now = nowMs || Date.now();
  return Math.max(0, Date.parse(session.expiresAt) - now);
}

function isSessionOpen(db, classroom, date) {
  return sessionActive(getSession(db, classroom, date));
}

function roomStudents(db, classroom) {
  return db.users.filter((u) => u.classroom === classroom).sort(byRoll);
}

function buildSheet(db, date, classroom) {
  const now = Date.now();
  const session = getSession(db, classroom, date);
  const active = sessionActive(session, now);
  const students = roomStudents(db, classroom).map((u) => {
    const rec = session && session.records[u.id];
    let status = 'absent';
    if (rec) status = 'present';
    else if (active) status = 'pending';
    return {
      id: u.id,
      name: u.name,
      classroom: u.classroom,
      rollNumber: u.rollNumber == null ? null : u.rollNumber,
      photo: u.photo || null,
      present: !!rec,
      status,
      at: rec ? rec.at : null,
      by: rec ? rec.by : null,
    };
  });
  const present = students.filter((s) => s.status === 'present').length;
  const pending = students.filter((s) => s.status === 'pending').length;
  const absent = students.filter((s) => s.status === 'absent').length;
  const total = students.length;
  return {
    date,
    classroom,
    isToday: date === todayLocal(),
    session: session
      ? {
          open: active,
          openedAt: session.openedAt,
          closedAt: session.closedAt,
          durationMin: session.durationMin || null,
          expiresAt: session.expiresAt || null,
          remainingMs: sessionRemainingMs(session, now),
        }
      : null,
    students,
    totals: { total, present, pending, absent, rate: total ? present / total : 0 },
  };
}

function buildRoomsStatus(db) {
  const date = todayLocal();
  const now = Date.now();
  return CLASSROOMS.map((classroom) => {
    const session = getSession(db, classroom, date);
    const active = sessionActive(session, now);
    const total = db.users.filter((u) => u.classroom === classroom).length;
    const present = session
      ? Object.values(session.records).filter((r) => r.present !== false).length
      : 0;
    return {
      classroom,
      open: active,
      hasSession: !!session,
      openedAt: session ? session.openedAt : null,
      closedAt: session ? session.closedAt : null,
      durationMin: session && session.durationMin ? session.durationMin : null,
      expiresAt: session && session.expiresAt ? session.expiresAt : null,
      remainingMs: sessionRemainingMs(session, now),
      present,
      total,
      rate: total ? present / total : 0,
    };
  });
}

function buildReport(db, classroom) {
  const allRooms = Object.keys(db.attendance.sessions);
  let dates;
  if (classroom) {
    dates = Object.keys(db.attendance.sessions[classroom] || {}).sort();
  } else {
    const set = new Set();
    for (const room of allRooms) for (const d of Object.keys(db.attendance.sessions[room])) set.add(d);
    dates = [...set].sort();
  }

  const source = db.users.filter((u) => !classroom || u.classroom === classroom).sort(byRoll);
  const students = source.map((u) => {
    const sessions = u.classroom ? db.attendance.sessions[u.classroom] || {} : {};
    const byDate = {};
    let present = 0;
    let absent = 0;
    let pending = 0;
    for (const d of dates) {
      const s = sessions[d];
      if (!s) {
        byDate[d] = '';
        continue;
      }
      const rec = s.records[u.id];
      if (rec && rec.present !== false) {
        present++;
        byDate[d] = 'P';
      } else if (sessionActive(s)) {

        pending++;
        byDate[d] = '-';
      } else {
        absent++;
        byDate[d] = 'F';
      }
    }
    const total = present + absent;
    return {
      id: u.id,
      name: u.name,
      classroom: u.classroom || null,
      rollNumber: u.rollNumber == null ? null : u.rollNumber,
      photo: u.photo || null,
      present,
      absent,
      pending,
      total,
      rate: total ? present / total : 0,
      byDate,
    };
  });

  const rooms = classroom ? [classroom] : allRooms;
  const sessions = dates.map((d) => {
    let present = 0;
    let total = 0;
    let active = false;
    for (const room of rooms) {
      const s = db.attendance.sessions[room] && db.attendance.sessions[room][d];
      if (!s) continue;
      if (sessionActive(s)) active = true;
      total += db.users.filter((u) => u.classroom === room).length;
      present += Object.values(s.records).filter((r) => r.present !== false).length;
    }
    return { date: d, present, total, rate: total ? present / total : 0, open: active };
  });

  return { school: SCHOOL_NAME, classroom: classroom || null, days: dates, sessions, students };
}

app.get('/api/config', async (_req, res) => {
  res.json({ school: SCHOOL_NAME, today: todayLocal(), now: new Date().toISOString(), classrooms: CLASSROOMS });
});

app.get('/api/health', async (_req, res) => {
  const db = await readDb();
  res.json({ ok: true, engine: 'json', school: SCHOOL_NAME, students: db.users.length, today: todayLocal() });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ authenticated: isTeacher(req), school: SCHOOL_NAME });
});

app.post('/api/auth/login', async (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!verifyPassword(password)) {
    await new Promise((r) => setTimeout(r, 350));
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  res.setHeader('Set-Cookie', sessionCookie(signSession()));
  res.json({ authenticated: true });
});

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`);
  res.json({ ok: true });
});

app.get('/api/users', async (_req, res) => {
  const db = await readDb();
  res.json({ users: db.users.map(publicUser), total: db.users.length });
});

app.get('/api/users/:id', async (req, res) => {
  const db = await readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Aluno nao encontrado' });
  res.json({ user: publicUser(user) });
});

app.post('/api/users', requireTeacher, async (req, res) => {
  const body = req.body || {};
  const name = sanitizeString(body.name, 120);
  const rollNumber = Number(body.rollNumber);
  const classroom = sanitizeString(body.classroom, 4);

  if (!name) return res.status(400).json({ error: 'Nome completo obrigatorio' });
  if (!classroom || !CLASSROOM_SET.has(classroom)) {
    return res.status(400).json({ error: 'Selecione uma sala valida' });
  }
  if (!Number.isInteger(rollNumber) || rollNumber < 1 || rollNumber > 9999) {
    return res.status(400).json({ error: 'Numero da chamada invalido (1 a 9999)' });
  }

  const desc = normalizeDescriptors(body);
  if (desc.error) return res.status(400).json({ error: desc.error });

  const photo = sanitizePhoto(body.photo);
  if (photo === undefined) return res.status(400).json({ error: 'Foto invalida' });

  const db = await readDb();
  if (db.users.some((u) => u.classroom === classroom && u.rollNumber === rollNumber)) {
    return res
      .status(409)
      .json({ error: `O numero ${rollNumber} ja esta em uso na sala ${classroom}` });
  }

  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    name,
    classroom,
    rollNumber,
    photo,
    descriptors: desc.descriptors,
    createdAt: now,
    updatedAt: now,
  };
  db.users.push(user);
  db.meta.updatedAt = now;
  await writeDb();
  res.status(201).json({ user: publicUser(user) });
});

app.put('/api/users/:id', requireTeacher, async (req, res) => {
  const db = await readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Aluno nao encontrado' });

  const body = req.body || {};
  if (body.name !== undefined) {
    const name = sanitizeString(body.name, 120);
    if (!name) return res.status(400).json({ error: 'Nome invalido' });
    user.name = name;
  }
  if (body.classroom !== undefined) {
    const classroom = sanitizeString(body.classroom, 4);
    if (!classroom || !CLASSROOM_SET.has(classroom)) {
      return res.status(400).json({ error: 'Sala invalida' });
    }
    user.classroom = classroom;
  }
  if (body.rollNumber !== undefined) {
    const rollNumber = Number(body.rollNumber);
    if (!Number.isInteger(rollNumber) || rollNumber < 1 || rollNumber > 9999) {
      return res.status(400).json({ error: 'Numero da chamada invalido' });
    }
    if (
      db.users.some(
        (u) => u.id !== user.id && u.classroom === user.classroom && u.rollNumber === rollNumber
      )
    ) {
      return res
        .status(409)
        .json({ error: `O numero ${rollNumber} ja esta em uso na sala ${user.classroom}` });
    }
    user.rollNumber = rollNumber;
  }
  if (body.descriptor !== undefined || body.descriptors !== undefined) {
    const desc = normalizeDescriptors(body);
    if (desc.error) return res.status(400).json({ error: desc.error });
    user.descriptors = desc.descriptors;
  }
  if (body.photo !== undefined) {
    const photo = sanitizePhoto(body.photo);
    if (photo === undefined) return res.status(400).json({ error: 'Foto invalida' });
    user.photo = photo;
  }

  user.updatedAt = new Date().toISOString();
  db.meta.updatedAt = user.updatedAt;
  await writeDb();
  res.json({ user: publicUser(user) });
});

app.delete('/api/users/:id', requireTeacher, async (req, res) => {
  const db = await readDb();
  const idx = db.users.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Aluno nao encontrado' });
  const [removed] = db.users.splice(idx, 1);

  for (const room of Object.values(db.attendance.sessions)) {
    for (const session of Object.values(room)) {
      if (session && session.records) delete session.records[removed.id];
    }
  }
  db.meta.updatedAt = new Date().toISOString();
  await writeDb();
  res.json({ removed: removed.id });
});

app.post('/api/attendance/mark', async (req, res) => {
  const studentId = req.body && req.body.studentId;
  const db = await readDb();
  const student = db.users.find((u) => u.id === studentId);
  if (!student) return res.status(404).json({ error: 'Aluno nao encontrado' });
  if (!student.classroom) {
    return res.status(400).json({ error: 'Aluno sem sala definida. Procure o professor.' });
  }

  const date = todayLocal();
  const session = getSession(db, student.classroom, date);
  if (resolveSession(session)) await writeDb();
  if (!sessionActive(session)) {
    return res
      .status(409)
      .json({ error: `Chamada encerrada para a sala ${student.classroom}.`, closed: true });
  }

  let newlyMarked = false;
  if (!session.records[studentId]) {
    session.records[studentId] = { present: true, at: new Date().toISOString(), by: 'face' };
    db.meta.updatedAt = new Date().toISOString();
    await writeDb();
    newlyMarked = true;
  }
  res.json({
    newlyMarked,
    student: publicUser(student),
    sheet: buildSheet(db, date, student.classroom),
  });
});

app.get('/api/attendance/today', async (req, res) => {
  const db = await readDb();
  const classroom = sanitizeString(req.query.classroom, 4);
  if (!classroom || !CLASSROOM_SET.has(classroom)) {
    return res.status(400).json({ error: 'Informe a sala' });
  }
  if (resolveSession(getSession(db, classroom, todayLocal()))) await writeDb();
  res.json(buildSheet(db, todayLocal(), classroom));
});

app.get('/api/attendance/rooms', async (_req, res) => {
  const db = await readDb();
  const date = todayLocal();
  let changed = false;
  for (const room of CLASSROOMS) {
    if (resolveSession(getSession(db, room, date))) changed = true;
  }
  if (changed) await writeDb();
  res.json({ date, rooms: buildRoomsStatus(db) });
});

app.get('/api/attendance/sessions', requireTeacher, async (req, res) => {
  const db = await readDb();
  const classroom = sanitizeString(req.query.classroom, 4);
  const rooms = classroom && CLASSROOM_SET.has(classroom) ? [classroom] : Object.keys(db.attendance.sessions);
  const out = [];
  for (const room of rooms) {
    for (const date of Object.keys(db.attendance.sessions[room] || {})) {
      const s = db.attendance.sessions[room][date];
      out.push({
        classroom: room,
        date,
        open: sessionActive(s),
        openedAt: s.openedAt,
        closedAt: s.closedAt,
        durationMin: s.durationMin || null,
        expiresAt: s.expiresAt || null,
        present: Object.values(s.records).filter((r) => r.present !== false).length,
      });
    }
  }
  out.sort((a, b) => (a.date === b.date ? a.classroom.localeCompare(b.classroom) : b.date.localeCompare(a.date)));
  res.json({ sessions: out });
});

app.get('/api/attendance/sheet', requireTeacher, async (req, res) => {
  const db = await readDb();
  const classroom = sanitizeString(req.query.classroom, 4);
  if (!classroom || !CLASSROOM_SET.has(classroom)) {
    return res.status(400).json({ error: 'Informe a sala' });
  }
  const date = sanitizeString(req.query.date, 10) || todayLocal();
  res.json(buildSheet(db, date, classroom));
});

app.get('/api/attendance/report', requireTeacher, async (req, res) => {
  const db = await readDb();
  const classroom = sanitizeString(req.query.classroom, 4);
  res.json(buildReport(db, classroom && CLASSROOM_SET.has(classroom) ? classroom : null));
});

app.post('/api/attendance/session/open', requireTeacher, async (req, res) => {
  const body = req.body || {};
  const classroom = sanitizeString(body.classroom, 4);
  if (!classroom || !CLASSROOM_SET.has(classroom)) {
    return res.status(400).json({ error: 'Sala invalida' });
  }
  const db = await readDb();
  const date = sanitizeString(body.date, 10) || todayLocal();

  let durationMin = Number(body.durationMin);
  if (!Number.isFinite(durationMin) || durationMin <= 0) durationMin = 0;
  if (durationMin > 24 * 60) durationMin = 24 * 60;

  const session = ensureSession(db, classroom, date, true);
  session.open = true;
  session.closedAt = null;
  session.autoClosed = false;
  session.durationMin = durationMin > 0 ? Math.round(durationMin) : null;
  session.expiresAt = durationMin > 0 ? new Date(Date.now() + durationMin * 60000).toISOString() : null;
  db.meta.updatedAt = new Date().toISOString();
  await writeDb();
  res.json(buildSheet(db, date, classroom));
});

app.post('/api/attendance/session/close', requireTeacher, async (req, res) => {
  const body = req.body || {};
  const classroom = sanitizeString(body.classroom, 4);
  if (!classroom || !CLASSROOM_SET.has(classroom)) {
    return res.status(400).json({ error: 'Sala invalida' });
  }
  const db = await readDb();
  const date = sanitizeString(body.date, 10) || todayLocal();
  const session = ensureSession(db, classroom, date, true);
  session.open = false;
  session.closedAt = new Date().toISOString();
  db.meta.updatedAt = new Date().toISOString();
  await writeDb();
  res.json(buildSheet(db, date, classroom));
});

app.put('/api/attendance/record', requireTeacher, async (req, res) => {
  const body = req.body || {};
  const db = await readDb();
  const student = db.users.find((u) => u.id === body.studentId);
  if (!student) return res.status(404).json({ error: 'Aluno nao encontrado' });
  if (!student.classroom) return res.status(400).json({ error: 'Aluno sem sala definida' });

  const date = sanitizeString(body.date, 10) || todayLocal();
  const session = ensureSession(db, student.classroom, date, true);

  if (body.present) {
    session.records[student.id] = { present: true, at: new Date().toISOString(), by: 'manual' };
  } else {
    delete session.records[student.id];
  }
  db.meta.updatedAt = new Date().toISOString();
  await writeDb();
  res.json(buildSheet(db, date, student.classroom));
});

app.get('/api/glasses-model', async (_req, res) => {
  const db = await readDb();
  res.json({ model: db.glassesModel || null });
});

app.put('/api/glasses-model', async (req, res) => {
  const model = req.body && req.body.model;
  const error = validateGlassesModel(model);
  if (error) return res.status(400).json({ error });

  const db = await readDb();
  const now = new Date().toISOString();
  db.glassesModel = { ...model, savedAt: now };
  db.meta.updatedAt = now;
  await writeDb();
  res.json({ model: db.glassesModel });
});

app.delete('/api/glasses-model', async (_req, res) => {
  const db = await readDb();
  db.glassesModel = null;
  db.meta.updatedAt = new Date().toISOString();
  await writeDb();
  res.json({ ok: true });
});

function isNumArray(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function validateGlassesModel(model) {
  if (!model || typeof model !== 'object') return 'modelo ausente';
  const { inputSize, hiddenSize, W1, b1, W2, b2, mean, std } = model;
  if (!Number.isInteger(inputSize) || inputSize < 1 || inputSize > 64) return 'inputSize invalido';
  if (!Number.isInteger(hiddenSize) || hiddenSize < 1 || hiddenSize > 64) return 'hiddenSize invalido';
  if (!Array.isArray(W1) || W1.length !== inputSize || !W1.every((row) => isNumArray(row, hiddenSize))) {
    return 'W1 invalido';
  }
  if (!isNumArray(b1, hiddenSize)) return 'b1 invalido';
  if (!Array.isArray(W2) || W2.length !== hiddenSize || !W2.every((row) => isNumArray(row, 1))) {
    return 'W2 invalido';
  }
  if (!isNumArray(b2, 1)) return 'b2 invalido';
  if (!isNumArray(mean, inputSize)) return 'mean invalido';
  if (!isNumArray(std, inputSize)) return 'std invalido';
  return null;
}

app.get('/login', (_req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'login.html'));
});

app.get('/panel', (req, res) => {
  if (!isTeacher(req)) return res.redirect('/login');
  res.redirect(`/room?classroom=${encodeURIComponent(CLASSROOMS[0])}`);
});

app.get('/room', (req, res) => {
  if (!isTeacher(req)) return res.redirect('/login');
  res.sendFile(path.join(VIEWS_DIR, 'room.html'));
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`);
  res.redirect('/login');
});

app.use('/face-api', express.static(FACEAPI_DIST, { fallthrough: false }));
app.use('/models', express.static(FACEAPI_MODELS, { fallthrough: false }));
app.use(express.static(PUBLIC_DIR));

app.use((err, _req, res, _next) => {
  console.error('[server] erro:', err.message);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

Promise.all([readDb(), loadAuth()]).then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log(`  ${SCHOOL_NAME} - Sistema de chamada por reconhecimento facial`);
    console.log(`  -> http://localhost:${PORT}`);
    console.log(`  Painel do professor: http://localhost:${PORT}/panel`);
    console.log('');
  });
});
