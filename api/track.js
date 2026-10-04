/**
 * /api/track — תיעוד צפיות בדפי נחיתה (Pagely)
 * ------------------------------------------------
 * POST {slug, day, ref} → רושם ביקור באוסף pageviews (ציבורי, ללא אימות).
 *   · מאומת שה-slug קיים ופעיל — ביקור בדף לא-קיים לא נרשם.
 *   · הדף עצמו דואג לא לספור כפילויות (פעם אחת לכל סשן-דפדפן) ולא לספור
 *     את התצוגה החיה בעורך (iframe).
 *
 * הנתונים נצרכים על-ידי /api/users (סופר-אדמין): עמודת צפיות בטבלה
 * ופירוט יומי + ביקורים אחרונים באקשן stats.
 */
'use strict';
const lib = require('./_lib.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const slug = String(b.slug || '').trim().toLowerCase();
    if (!slug) { res.status(400).json({ ok: false, error: 'missing slug' }); return; }

    const db = await lib.getDb();
    await lib.ensureReady(db);

    const user = await db.collection('users').findOne({ slug }, { projection: { status: 1 } });
    if (!user || user.status === 'suspended') {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }

    const day = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(b.day || '')) ? String(b.day) : new Date().toLocaleDateString('en-CA');
    await db.collection('pageviews').insertOne({
      slug,
      at: new Date(),
      day,
      ref: String(b.ref || '').slice(0, 300)
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
