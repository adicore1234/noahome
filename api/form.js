/**
 * /api/form — טופס המילוי שהלקוח ממלא בעצמו (Pagely)
 * ----------------------------------------------------
 * POST {action:'auth', slug, t}            → אימות הקישור האישי + החזרת התוכן הנוכחי למילוי מראש
 * POST {action:'save', slug, t, patch}     → החלת הטופס על תוכן הדף (רק שדות מאושרים, סניטציה מלאה)
 *
 * ההזדהות היא באמצעות הטוקן האישי של היוזר (לא סשן) — הקישור מגיע מהסופר-אדמין
 * בלבד: /f/<slug>?t=<token>. הטוקן הוא הזיהוי היחיד (ה-slug בנתיב רק לראוטינג).
 * כל לוגיקת הגישה למסד, האימות והסניטציה מרוכזות ב-_lib (formUserByToken/
 * formLoad/formApply); ה-endpoint הזה טהור מגישה ישירה למסד ומבקשות רשת.
 * עובד גם כ-Vercel serverless וגם דרך local-server.js.
 */
'use strict';
const lib = require('./_lib.js');

/* מגבלת קצה גלובלית (best-effort, לכל מופע): עד 90 בקשות טופס לדקה */
const _hits = [];
function overLimit() {
  const now = Date.now();
  while (_hits.length && now - _hits[0] > 60000) _hits.shift();
  if (_hits.length >= 90) return true;
  _hits.push(now);
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method not allowed' }); return; }
    if (overLimit()) { res.status(429).json({ ok: false, error: 'עומס גבוה — נסו שוב בעוד דקה' }); return; }
    const action = String((req.body && req.body.action) || '');
    const db = await lib.getDb();
    await lib.ensureReady(db);

    /* ---------- auth: אימות קישור + החזרת תוכן למילוי מראש ---------- */
    if (action === 'auth') {
      const r = await lib.formLoad(req, db);
      if (!r) {
        res.status(401).json({ ok: false, error: 'הקישור לא תקין או שפג תוקפו. בקשו מהמנהל קישור חדש' });
        return;
      }
      res.status(200).json({ ok: true, displayName: r.user.displayName, theme: r.user.theme, content: r.content });
      return;
    }

    /* ---------- save: החלת הטופס (רשימת שדות מאושרת בלבד, בתוך _lib) ---------- */
    if (action === 'save') {
      const patch = (req.body && req.body.patch && typeof req.body.patch === 'object') ? req.body.patch : {};
      const r = await lib.formApply(req, db, patch);
      if (!r) {
        res.status(401).json({ ok: false, error: 'הקישור לא תקין או שפג תוקפו. בקשו מהמנהל קישור חדש' });
        return;
      }
      const u = r.user;
      res.status(200).json({ ok: true, url: u.theme === 'kids' ? ('/' + u.slug) : ('/b/' + u.slug) });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'שגיאת שרת' });
  }
};
