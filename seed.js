// One-time seed: loads seed_data.json into the `testcases` collection.
// Safe to re-run — it replaces each case by its own id, no duplicates.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}
const DB_NAME = process.env.MONGODB_DB || 'uat_tracker';

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_data.json'), 'utf8'));
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(DB_NAME);
  const col = db.collection('testcases');

  let n = 0;
  for (const app of Object.keys(data)) {
    const rows = data[app];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await col.updateOne(
        { _id: row.id },
        { $set: { ...row, app, order: i } },
        { upsert: true }
      );
      n++;
    }
  }
  await col.createIndex({ app: 1, order: 1 });
  await db.collection('results').createIndex({ app: 1 });
  await db.collection('history').createIndex({ app: 1, caseId: 1, changedAt: -1 });
  console.log(`Seeded ${n} test cases into "${DB_NAME}.testcases".`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
