'use strict';

require('../env');

const fs = require('fs');
const path = require('path');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI nao definido no .env');
  }

  const dbName = process.env.MONGODB_DB || 'benedito_claudio';
  const collectionName = process.env.MONGODB_COLLECTION || 'app_state';
  const docId = process.env.MONGODB_DOC_ID || 'state';
  const force = process.argv.includes('--force');

  const localFile = path.join(__dirname, '..', 'database.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  } catch (err) {
    throw new Error('nao consegui ler database.json: ' + err.message);
  }

  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

  try {
    await client.connect();
    const coll = client.db(dbName).collection(collectionName);

    const existing = await coll.findOne({ _id: docId });
    if (existing && !force) {
      console.log('Ja existe um documento no cluster (id: "' + docId + '"). Nada foi alterado.');
      console.log('Para sobrescrever com o database.json local, rode: npm run migrate -- --force');
      return;
    }

    await coll.replaceOne(
      { _id: docId },
      { _id: docId, data, updatedAt: new Date().toISOString() },
      { upsert: true }
    );

    console.log('Migracao concluida para o cluster MongoDB.');
    console.log('  Banco:         ' + dbName);
    console.log('  Colecao:       ' + collectionName);
    console.log('  Alunos:        ' + (Array.isArray(data.users) ? data.users.length : 0));
    console.log('  Modelo oculos: ' + (data.glassesModel ? 'sim' : 'nao'));
  } finally {
    await client.close().catch(() => {});
  }
}

main()
  .then(() => {
    console.log('Pronto. Agora rode "npm start" e o sistema usara o cluster.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Erro:', err.message);
    process.exit(1);
  });
