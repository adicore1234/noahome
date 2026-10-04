/**
 * /api/content — תוכן דפי נחיתה לפי slug (Pagely)
 * ------------------------------------------------
 * GET  /api/content?slug=noa  → תוכן הדף של היוזר (ציבורי). דף לא קיים/מושהה → 404.
 * POST /api/content?slug=noa  → שמירת תוכן. דורש Authorization: Bearer <token>.
 *                              יוזר שומר רק את הדף של עצמו; סופר-אדמין — כל דף דרך ?slug=.
 *
 * עובד גם כ-Vercel serverless וגם דרך local-server.js.
 * משתני סביבה: MONGODB_URI (+MONGODB_PASSWORD), MONGO_DB.
 */
'use strict';
const lib = require('./_lib.js');
const noaContent = require('../content.json'); /* הגיבוי הסטטי של הדף המקורי */

module.exports = async function handler(req, res) {
  /* התוכן ניתן לעריכה — אף שכבת CDN/דפדפן לא שומרת אותו.
     כל עמודי המערכת מוגשים מאותו מקור — אין CORS ל cross-origin. */
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }

    /* אימות לפני פתיחת ה-Mongo — כדי לא לחשוף שגיאות חיבור ללא-מורשים */
    if (req.method === 'POST') {
      const db0 = await lib.getDb().catch(() => null);
      const s0 = db0 ? await lib.getSession(req, db0).catch(() => null) : null;
      if (!s0) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    }

    const db = await lib.getDb();
    await lib.ensureReady(db);
    const col = db.collection('content');

    const u = new URL(req.url, 'http://localhost');
    const slug = String(u.searchParams.get('slug') || '').trim().toLowerCase();

    /* ---------- GET (ציבורי) ---------- */
    if (req.method === 'GET') {
      if (!slug) {
        res.status(400).json({ ok: false, error: 'missing slug' });
        return;
      }
      const user = await db.collection('users').findOne({ slug }, { projection: { status: 1, displayName: 1, theme: 1 } });
      if (!user || user.status === 'suspended') {
        res.status(404).json({ ok: false, error: 'not_found' });
        return;
      }
      if (user.theme) res.setHeader('x-user-theme', user.theme);
      const doc = await col.findOne({ slug });
      if (doc && doc.content) {
        res.setHeader('x-content-source', 'db');
        res.status(200).json(doc.content);
        return;
      }
      /* ליוזר קיים אין עדיין מסמך תוכן — זורעים תבנית */
      const tpl = lib.templateContent(user.displayName, user.theme);
      await col.updateOne({ slug }, { $set: { slug, content: tpl, updatedAt: new Date() } }, { upsert: true });
      res.setHeader('x-content-source', 'seeded');
      res.status(200).json(tpl);
      return;
    }

    /* ---------- POST (דורש סשן) ---------- */
    const s = await lib.getSession(req, db);
    if (!s) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

    let target;
    if (s.role === 'superadmin') {
      target = slug;
      if (!lib.validSlug(target)) {
        res.status(400).json({ ok: false, error: 'missing or invalid slug' });
        return;
      }
      const u2 = await db.collection('users').findOne({ slug: target }, { projection: { _id: 1 } });
      if (!u2) { res.status(404).json({ ok: false, error: 'no such user' }); return; }
    } else {
      target = s.slug; /* יוזר רגיל — תמיד רק הדף של עצמו */
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || !body.version) {
      res.status(400).json({ ok: false, error: 'invalid content' });
      return;
    }
    await col.updateOne(
      { slug: target },
      { $set: { slug: target, content: body, updatedAt: new Date() } },
      { upsert: true }
    );
    res.status(200).json({ ok: true });
    return;

  } catch (e) {
    /* המסד לא זמין: לדף המקורי (noa) יש גיבוי סטטי כדי שהאתר לא ייפול */
    if (req.method === 'GET') {
      const u = new URL(req.url, 'http://localhost');
      const slug = String(u.searchParams.get('slug') || '').trim().toLowerCase();
      if (slug === 'noa') {
        res.setHeader('x-content-source', 'file-fallback');
        res.status(200).json(noaContent);
        return;
      }
    }
    res.status(503).json({ ok: false, error: 'db unavailable' });
  }
};
