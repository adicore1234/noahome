/**
 * /api/content — MongoDB-backed content for the site
 * -------------------------------------------------
 * GET  → מחזיר את אובייקט התוכן (JSON). אם המסד ריק — זורע מ-content.json.
 *        אם המסד לא זמין — נופל בחזרה ל-content.json (האתר לא נופל לעולם).
 * POST → שומר את התוכן. דורש כותרות x-admin-user / x-admin-pass (כמו באדמין).
 *
 * עובד גם כ-Vercel serverless function וגם דרך server.js המקומי.
 * משתני סביבה: MONGODB_URI (+MONGODB_PASSWORD אם ה-URI מכיל <password>),
 *               MONGO_DB (ברירת מחדל: noa_site), ADMIN_USER, ADMIN_PASS.
 */
const { MongoClient, ServerApiVersion } = require('mongodb');
const defaultContent = require('../content.json');

function mongoUri() {
  let u = process.env.MONGODB_URI || process.env.MONGO_URI || '';
  const p = process.env.MONGODB_PASSWORD;
  if (p && u.includes('<password>')) u = u.replace('<password>', encodeURIComponent(p));
  return u;
}

let _client = null;
async function getDb() {
  const uri = mongoUri();
  if (!uri) throw new Error('MONGODB_URI is not configured');
  if (!_client) {
    _client = new MongoClient(uri, { serverApi: ServerApiVersion.api1 });
    await _client.connect();
  }
  return _client.db(process.env.MONGO_DB || 'noa_site');
}

function authOk(req) {
  const u = process.env.ADMIN_USER || 'noahome';
  const p = process.env.ADMIN_PASS || '12345678';
  return req.headers['x-admin-user'] === u && req.headers['x-admin-pass'] === p;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-user,x-admin-pass');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const db = await getDb();
    const col = db.collection('content');

    if (req.method === 'GET') {
      const doc = await col.findOne({ key: 'site' });
      if (doc && doc.content) {
        res.setHeader('x-content-source', 'db');
        res.status(200).json(doc.content);
        return;
      }
      /* first run: seed the DB from the static file */
      await col.updateOne({ key: 'site' }, { $set: { key: 'site', content: defaultContent, updatedAt: new Date() } }, { upsert: true });
      res.setHeader('x-content-source', 'seeded');
      res.status(200).json(defaultContent);
      return;
    }

    if (req.method === 'POST') {
      if (!authOk(req)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      const body = req.body;
      if (!body || typeof body !== 'object' || !body.version) {
        res.status(400).json({ ok: false, error: 'invalid content' });
        return;
      }
      await col.updateOne({ key: 'site' }, { $set: { content: body, updatedAt: new Date() } }, { upsert: true });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    /* DB unreachable: GET falls back to the bundled file so the site stays up */
    if (req.method === 'GET') {
      res.setHeader('x-content-source', 'file-fallback');
      res.status(200).json(defaultContent);
      return;
    }
    res.status(500).json({ ok: false, error: e.message });
  }
};
