'use strict';

require('./env');

const path = require('path');
const fsp = require('fs/promises');

const SCHOOL_NAME = process.env.SCHOOL_NAME || 'Benedito Cláudio';
const MODE = process.env.MONGODB_URI ? 'mongo' : 'json';

const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp' : __dirname);
const DB_FILE = path.join(DATA_DIR, 'database.json');
const BACKUP_FILE = path.join(DATA_DIR, 'database.backup.json');
const SEED_DB = path.join(__dirname, 'database.json');

const MONGO_DB = process.env.MONGODB_DB || 'benedito_claudio';
const MONGO_COLLECTION = process.env.MONGODB_COLLECTION || 'app_state';
const MONGO_DOC_ID = process.env.MONGODB_DOC_ID || 'state';

let cache = null;
let writeChain = Promise.resolve();

let mongoClient = null;
let mongoColl = null;
let connectPromise = null;

function emptyDb() {
  const now = new Date().toISOString();
  return {
    meta: { version: 3, engine: MODE, school: SCHOOL_NAME, createdAt: now, updatedAt: now },
    users: [],
    attendance: { sessions: {} },
    glassesModel: null,
  };
}

function normalizeDb(data) {
  if (!data || typeof data !== 'object') return emptyDb();
  if (!Array.isArray(data.users)) data.users = [];
  if (!data.meta || typeof data.meta !== 'object') data.meta = { version: 3, engine: MODE };
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

async function connectMongo() {
  if (mongoColl) return;
  if (!connectPromise) {
    connectPromise = (async () => {
      const { MongoClient } = require('mongodb');
      mongoClient = new MongoClient(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
      });
      await mongoClient.connect();
      mongoColl = mongoClient.db(MONGO_DB).collection(MONGO_COLLECTION);
    })().catch((err) => {
      connectPromise = null;
      throw err;
    });
  }
  await connectPromise;
}

async function readFresh() {
  await connectMongo();

  let doc = await mongoColl.findOne({ _id: MONGO_DOC_ID });

  // Documentos antigos (migrados do JSON) nao tinham o campo de versao.
  // Inicializa "rev" uma unica vez para o controle de concorrencia funcionar.
  if (doc && typeof doc.rev !== 'number') {
    await mongoColl.updateOne(
      { _id: MONGO_DOC_ID, rev: { $exists: false } },
      { $set: { rev: 0 } }
    );
    doc = await mongoColl.findOne({ _id: MONGO_DOC_ID });
  }

  const data = normalizeDb(doc && doc.data ? doc.data : null);
  const rev = doc && Number.isInteger(doc.rev) ? doc.rev : 0;
  cache = data;
  return { data, rev, exists: !!doc };
}

async function readDb() {
  if (MODE === 'mongo') {
    const { data } = await readFresh();
    return data;
  }

  if (cache) return cache;

  try {
    const raw = await fsp.readFile(DB_FILE, 'utf8');
    cache = normalizeDb(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (SEED_DB !== DB_FILE) {
        try {
          await fsp.copyFile(SEED_DB, DB_FILE);
          cache = normalizeDb(JSON.parse(await fsp.readFile(DB_FILE, 'utf8')));
          return cache;
        } catch (_) {
          /* segue com banco vazio */
        }
      }
      cache = emptyDb();
      await writeDb();
    } else {
      console.error('[db] database.json invalido, recomecando:', err.message);
      try {
        await fsp.rename(DB_FILE, `${DB_FILE}.corrupt-${Date.now()}`);
      } catch (_) {
        /* ignora */
      }
      cache = emptyDb();
      await writeDb();
    }
  }
  return cache;
}

async function updateDb(mutator) {
  if (MODE !== 'mongo') {
    const data = await readDb();
    const result = mutator(data);
    if (data.meta) data.meta.updatedAt = new Date().toISOString();
    await writeDb();
    return result;
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const { data, rev, exists } = await readFresh();
    const result = mutator(data);
    if (!data.meta || typeof data.meta !== 'object') data.meta = {};
    data.meta.updatedAt = new Date().toISOString();
    const now = data.meta.updatedAt;

    try {
      if (exists) {
        const res = await mongoColl.replaceOne(
          { _id: MONGO_DOC_ID, rev },
          { _id: MONGO_DOC_ID, rev: rev + 1, data, updatedAt: now }
        );
        if (res.matchedCount === 1) return result;
      } else {
        const res = await mongoColl.updateOne(
          { _id: MONGO_DOC_ID },
          { $setOnInsert: { rev: 0, data, updatedAt: now } },
          { upsert: true }
        );
        if (res.upsertedCount === 1) return result;
      }
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
    }
  }

  throw new Error('Nao foi possivel salvar por concorrencia. Tente novamente.');
}

function writeDb() {
  const snapshot = cache;
  writeChain = writeChain
    .then(async () => {
      if (MODE === 'mongo') {
        await connectMongo();
        await mongoColl.replaceOne(
          { _id: MONGO_DOC_ID },
          { _id: MONGO_DOC_ID, data: snapshot, updatedAt: new Date().toISOString() },
          { upsert: true }
        );
        return;
      }
      try {
        await fsp.mkdir(DATA_DIR, { recursive: true });
      } catch (_) {
        /* ignora */
      }
      try {
        await fsp.copyFile(DB_FILE, BACKUP_FILE);
      } catch (_) {
        /* ainda nao existe */
      }
      const tmp = `${DB_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await fsp.rename(tmp, DB_FILE);
    })
    .catch((err) => console.error('[db] falha ao salvar:', err.message));
  return writeChain;
}

const ready =
  MODE === 'mongo'
    ? connectMongo().then(() => {
        console.log('[db] conectado ao cluster MongoDB');
      })
    : (async () => {
        try {
          await fsp.mkdir(DATA_DIR, { recursive: true });
        } catch (_) {
          /* ignora */
        }
      })();

ready.catch(() => {});

module.exports = { readDb, writeDb, updateDb, ready, mode: MODE };
