require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var. Set it before starting the server.');
  process.exit(1);
}
const DB_NAME = process.env.MONGODB_DB || 'uat_tracker';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ENV_ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';

if (!ADMIN_PASSWORD) {
  console.warn('Warning: ADMIN_PASSWORD not set. The admin role (summary, history, changing the tester password) is unreachable until you set it.');
}
if (!ENV_ACCESS_PASSWORD) {
  console.warn('Warning: ACCESS_PASSWORD not set. Testers cannot log in until you set it (or an admin sets one from the app).');
}

let clientPromise;
function getDb() {
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    clientPromise = client.connect().then((c) => c.db(DB_NAME));
  }
  return clientPromise;
}

async function effectiveAccessPassword(db) {
  const settings = await db.collection('settings').findOne({ _id: 'global' });
  return (settings && settings.accessPassword) || ENV_ACCESS_PASSWORD;
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// --- auth middleware -------------------------------------------------
function requireRole(minRole) {
  return async function (req, res, next) {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'not_authenticated' });
      const db = await getDb();
      const session = await db.collection('sessions').findOne({ _id: token });
      if (!session) return res.status(401).json({ error: 'not_authenticated' });
      if (minRole === 'admin' && session.role !== 'admin') {
        return res.status(403).json({ error: 'admin_only' });
      }
      req.role = session.role;
      req.token = token;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

const app = express();
app.set('trust proxy', true); // Vercel sits in front of this — read the real client IP from X-Forwarded-For, not the proxy's own.
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Passive forensic trail — never surfaced in the main UI, not shown to
// testers, only readable by querying the database directly (or a future
// admin-only endpoint). Supplements the self-typed tester name; doesn't
// replace it.
function clientInfo(req) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] || '' };
}

// POST /api/auth  { password }
app.post('/api/auth', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });
    const db = await getDb();
    let role = null;
    if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) role = 'admin';
    else {
      const accessPassword = await effectiveAccessPassword(db);
      if (accessPassword && password === accessPassword) role = 'tester';
    }
    if (!role) return res.status(401).json({ error: 'wrong_password' });
    const token = newToken();
    await db.collection('sessions').insertOne({ _id: token, role, createdAt: new Date() });
    res.json({ token, role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Everything below this line needs at least a tester session.
app.use('/api', requireRole('tester'));

// Lets the client confirm a stored session is still valid (and its role).
app.get('/api/me', (req, res) => res.json({ role: req.role }));

// Ends the current session server-side.
app.post('/api/logout', async (req, res) => {
  try {
    const db = await getDb();
    await db.collection('sessions').deleteOne({ _id: req.token });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/testcases', async (req, res) => {
  try {
    const db = await getDb();
    const filter = req.query.app ? { app: req.query.app } : {};
    const docs = await db.collection('testcases').find(filter).sort({ order: 1 }).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/results', async (req, res) => {
  try {
    const db = await getDb();
    const filter = {};
    if (req.query.app) filter.app = req.query.app;
    if (req.query.platform) filter.platform = req.query.platform;
    const docs = await db.collection('results').find(filter).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PLATFORMS = ['ios', 'android'];
function slug(s){ return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'anon'; }

// A case+platform an admin has accepted is frozen for everyone — including
// admins going through the normal submit routes — until it's reopened.
// That's the whole point: no more "went back in and changed it by mistake".
function acceptanceId(appId, caseId, platform){ return `${appId}__${caseId}__${platform}`; }
async function isLocked(db, appId, caseId, platform){
  const doc = await db.collection('acceptances').findOne({ _id: acceptanceId(appId, caseId, platform) });
  return !!(doc && doc.accepted);
}

// GET /api/acceptances — which case+platform combos are locked. Readable
// by testers too, so the UI can show them as locked/read-only.
app.get('/api/acceptances', async (req, res) => {
  try {
    const db = await getDb();
    const filter = {};
    if (req.query.app) filter.app = req.query.app;
    if (req.query.platform) filter.platform = req.query.platform;
    const docs = await db.collection('acceptances').find(filter).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/results  { caseId, app, platform, tester, result?, comments? }
// `platform` is required — the same case can hold an independent outcome
// per platform, so it's part of the document's identity, not optional.
app.post('/api/results', async (req, res) => {
  try {
    const { caseId, app: appId, platform, tester, result, comments } = req.body || {};
    if (!caseId || !appId || !tester || !platform) {
      return res.status(400).json({ error: 'caseId, app, platform, and tester are required' });
    }
    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: `platform must be one of: ${PLATFORMS.join(', ')}` });
    }
    const db = await getDb();
    if (await isLocked(db, appId, caseId, platform)) {
      return res.status(423).json({ error: 'An admin has accepted and locked this case. Ask them to reopen it before recording a new result.' });
    }
    const docId = `${caseId}__${platform}__${slug(tester)}`;
    const now = new Date();
    const patch = { caseId, app: appId, platform, tester, updatedAt: now };
    if (result !== undefined) patch.result = result;
    if (comments !== undefined) patch.comments = comments;
    await db.collection('results').updateOne({ _id: docId }, { $set: patch }, { upsert: true });
    // Append-only audit trail — every change, never overwritten.
    await db.collection('history').insertOne({ caseId, app: appId, platform, tester, result, comments, changedAt: now, ...clientInfo(req) });
    res.json({ ok: true, id: docId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Screenshots attached to a case (base64 data URIs, stored in Mongo —
// fine at this scale; capped below to keep documents small).
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // ~3MB raw, before base64 inflation

app.get('/api/attachments', async (req, res) => {
  try {
    const db = await getDb();
    const filter = {};
    if (req.query.app) filter.app = req.query.app;
    if (req.query.caseId) filter.caseId = req.query.caseId;
    if (req.query.platform) filter.platform = req.query.platform;
    const docs = await db.collection('attachments')
      .find(filter, { projection: { image: 0, ip: 0, userAgent: 0 } }) // list view never sends image bytes or forensic fields
      .sort({ createdAt: -1 }).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attachments/:id/image', async (req, res) => {
  try {
    const db = await getDb();
    const doc = await db.collection('attachments').findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).end();
    res.json({ image: doc.image, mimeType: doc.mimeType });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/attachments', async (req, res) => {
  try {
    const { caseId, app: appId, platform, tester, image, filename, mimeType } = req.body || {};
    if (!caseId || !appId || !tester || !image || !platform) {
      return res.status(400).json({ error: 'caseId, app, platform, tester, and image are required' });
    }
    const approxBytes = Math.ceil(image.length * 0.75);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Image too large — please attach a smaller screenshot (under ~3MB).' });
    }
    const db = await getDb();
    if (await isLocked(db, appId, caseId, platform)) {
      return res.status(423).json({ error: 'An admin has accepted and locked this case. Ask them to reopen it before adding a screenshot.' });
    }
    const doc = {
      caseId, app: appId, platform, tester, image, filename: filename || 'screenshot.png',
      mimeType: mimeType || 'image/png', createdAt: new Date(), ...clientInfo(req),
    };
    const r = await db.collection('attachments').insertOne(doc);
    res.json({ ok: true, id: r.insertedId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/attachments/:id', async (req, res) => {
  try {
    const db = await getDb();
    const doc = await db.collection('attachments').findOne({ _id: new ObjectId(req.params.id) });
    if (doc && await isLocked(db, doc.app, doc.caseId, doc.platform)) {
      return res.status(423).json({ error: 'An admin has accepted and locked this case. Ask them to reopen it before removing a screenshot.' });
    }
    await db.collection('attachments').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// General, per-app notes (not tied to one test case).
app.get('/api/comments', async (req, res) => {
  try {
    const db = await getDb();
    const filter = req.query.app ? { app: req.query.app } : {};
    const docs = await db.collection('comments').find(filter, { projection: { ip: 0, userAgent: 0 } }).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/comments', async (req, res) => {
  try {
    const { app: appId, tester, text } = req.body || {};
    if (!appId || !tester || !text || !text.trim()) {
      return res.status(400).json({ error: 'app, tester, and text are required' });
    }
    const db = await getDb();
    const doc = { app: appId, tester, text: text.trim(), createdAt: new Date(), ...clientInfo(req) };
    const r = await db.collection('comments').insertOne(doc);
    res.json({ ok: true, id: r.insertedId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read-only change history for testers and integrations (e.g. the UAT MCP
// server), newest first, with cursor pagination.
// GET /api/history?app=&caseId=&platform=&limit=&cursor=
// → { items: [...], nextCursor: string | null }
app.get('/api/history', async (req, res) => {
  try {
    const filter = {};
    if (req.query.app) filter.app = String(req.query.app);
    if (req.query.caseId) filter.caseId = String(req.query.caseId);
    if (req.query.platform) filter.platform = String(req.query.platform);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    if (req.query.cursor) {
      // Cursor = "<changedAt ISO>|<ObjectId>" of the last item on the previous page.
      const [iso, id] = String(req.query.cursor).split('|');
      const at = new Date(iso);
      if (isNaN(at.getTime()) || !ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'invalid cursor' });
      }
      filter.$or = [{ changedAt: { $lt: at } }, { changedAt: at, _id: { $lt: new ObjectId(id) } }];
    }
    const db = await getDb();
    const docs = await db.collection('history')
      .find(filter).sort({ changedAt: -1, _id: -1 }).limit(limit + 1).toArray();
    const items = docs.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = docs.length > limit && last ? `${new Date(last.changedAt).toISOString()}|${last._id}` : null;
    res.json({ items, nextCursor });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- admin-only ---------------------------------------------------------
app.use('/api/admin', requireRole('admin'));

app.post('/api/admin/password', async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'newPassword must be at least 4 characters' });
    }
    const db = await getDb();
    await db.collection('settings').updateOne(
      { _id: 'global' },
      { $set: { accessPassword: newPassword, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/accept  { app, caseId, platform }
// Locks that case+platform: no tester (or admin, via the normal routes)
// can change its result, comments, or screenshots until it's reopened.
app.post('/api/admin/accept', async (req, res) => {
  try {
    const { app: appId, caseId, platform } = req.body || {};
    if (!appId || !caseId || !platform) {
      return res.status(400).json({ error: 'app, caseId, and platform are required' });
    }
    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: `platform must be one of: ${PLATFORMS.join(', ')}` });
    }
    const db = await getDb();
    await db.collection('acceptances').updateOne(
      { _id: acceptanceId(appId, caseId, platform) },
      { $set: { app: appId, caseId, platform, accepted: true, acceptedAt: new Date() }, $unset: { reopenedAt: '' } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/reopen  { app, caseId, platform }
app.post('/api/admin/reopen', async (req, res) => {
  try {
    const { app: appId, caseId, platform } = req.body || {};
    if (!appId || !caseId || !platform) {
      return res.status(400).json({ error: 'app, caseId, and platform are required' });
    }
    const db = await getDb();
    await db.collection('acceptances').updateOne(
      { _id: acceptanceId(appId, caseId, platform) },
      { $set: { app: appId, caseId, platform, accepted: false, reopenedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Forensic-only views — the ip/userAgent fields every write already
// carries, just never shown on the tester-facing endpoints above.
app.get('/api/admin/comments', async (req, res) => {
  try {
    const db = await getDb();
    const filter = req.query.app ? { app: req.query.app } : {};
    const docs = await db.collection('comments').find(filter).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/attachments', async (req, res) => {
  try {
    const db = await getDb();
    const filter = {};
    if (req.query.app) filter.app = req.query.app;
    if (req.query.caseId) filter.caseId = req.query.caseId;
    const docs = await db.collection('attachments').find(filter, { projection: { image: 0 } }).sort({ createdAt: -1 }).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/history', async (req, res) => {
  try {
    const db = await getDb();
    const filter = {};
    if (req.query.app) filter.app = req.query.app;
    if (req.query.platform) filter.platform = req.query.platform;
    const docs = await db.collection('history').find(filter).sort({ changedAt: -1 }).limit(300).toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/summary', async (req, res) => {
  try {
    const db = await getDb();
    const apps = await db.collection('testcases').distinct('app');
    const summary = [];
    for (const appId of apps) {
      const total = await db.collection('testcases').countDocuments({ app: appId });
      for (const platform of PLATFORMS) {
        // One row per case: its most recently updated result, across every tester, on this platform.
        const latestPerCase = await db.collection('results').aggregate([
          { $match: { app: appId, platform } },
          { $sort: { updatedAt: -1 } },
          { $group: { _id: '$caseId', result: { $first: '$result' } } },
        ]).toArray();
        const counts = { Pass: 0, Fail: 0, Blocked: 0, 'N/A': 0 };
        latestPerCase.forEach((r) => { if (counts[r.result] !== undefined) counts[r.result]++; });
        const done = latestPerCase.filter((r) => r.result && r.result !== 'Not run').length;
        summary.push({
          app: appId, platform, total, done,
          pass: counts.Pass, fail: counts.Fail, blocked: counts.Blocked, na: counts['N/A'],
          notRun: total - done,
          pct: total ? Math.round((done / total) * 100) : 0,
        });
      }
    }
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/healthz', (req, res) => res.send('ok'));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`UAT Tracker listening on http://localhost:${port}`));
}

module.exports = app;
