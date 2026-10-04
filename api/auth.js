/**
 * /api/auth — ניהול התחברות של Pagely
 * ------------------------------------
 * POST {action:'login', username, password}        → {ok, token, role, slug, displayName}
 * POST {action:'logout'}                            → מוחק את הסשן (דורש Bearer)
 * POST {action:'changePassword', currentPassword, newPassword} → ליוזר בלבד
 * GET (עם Authorization: Bearer <token>)            → בדיקת סשן קיים
 *
 * הסופר-אדמין מאומת מול SUPERADMIN_USER / SUPERADMIN_PASS בסביבה;
 * יוזרים רגילים מאומתים מול אוסף users (scrypt).
 */
'use strict';
const lib = require('./_lib.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }

    const db = await lib.getDb();
    await lib.ensureReady(db);

    /* ---------- GET: בדיקת סשן ---------- */
    if (req.method === 'GET') {
      const s = await lib.getSession(req, db);
      if (!s) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      res.status(200).json({
        ok: true,
        role: s.role,
        slug: s.slug,
        displayName: s.displayName,
        username: s.username
      });
      return;
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const action = String(body.action || '');

    /* ---------- login ---------- */
    if (action === 'login') {
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || !password) {
        res.status(400).json({ ok: false, error: 'נדרשים שם משתמש וסיסמה' });
        return;
      }
      if (lib.throttleBlocked(username)) {
        res.status(429).json({ ok: false, error: 'יותר מדי ניסיונות כושלים — נסו שוב בעוד כמה דקות' });
        return;
      }

      let sessionInfo = null;
      if (lib.isSuperadminLogin(username, password)) {
        sessionInfo = { role: 'superadmin', userId: null, slug: null, displayName: 'סופר-אדמין' };
      } else {
        const user = await db.collection('users').findOne({ username });
        if (user) {
          if (lib.verifyPassword(password, user.passHash)) {
            if (user.status === 'suspended') {
              lib.throttleFail(username);
              res.status(403).json({ ok: false, error: 'החשבון מושהה — פנו למנהל המערכת' });
              return;
            }
            sessionInfo = { role: 'user', userId: user._id, slug: user.slug, displayName: user.displayName };
          }
        } else {
          /* השוואת-דמה כדי שזמן התשובה לא יחשוף אם היוזר קיים */
          lib.verifyPassword(password, 's1$00$00');
        }
      }

      if (!sessionInfo) {
        lib.throttleFail(username);
        res.status(401).json({ ok: false, error: 'שם משתמש או סיסמה שגויים' });
        return;
      }
      lib.throttleClear(username);

      const token = await lib.createSession(db, sessionInfo);
      res.status(200).json({
        ok: true,
        token,
        role: sessionInfo.role,
        slug: sessionInfo.slug,
        displayName: sessionInfo.displayName
      });
      return;
    }

    /* ---------- logout ---------- */
    if (action === 'logout') {
      const token = lib.tokenFromReq(req);
      if (token) await db.collection('sessions').deleteOne({ _id: token }).catch(() => {});
      res.status(200).json({ ok: true });
      return;
    }

    /* ---------- changePassword (יוזר בלבד; סיסמת הסופר-אדמין בסביבה) ---------- */
    if (action === 'changePassword') {
      const s = await lib.getSession(req, db);
      if (!s || s.role !== 'user') {
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
      }
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 6) {
        res.status(400).json({ ok: false, error: 'הסיסמה החדשה קצרה מדי (מינימום 6 תווים)' });
        return;
      }
      const user = await db.collection('users').findOne({ _id: s.userId });
      if (!user || !lib.verifyPassword(currentPassword, user.passHash)) {
        res.status(400).json({ ok: false, error: 'הסיסמה הנוכחית שגויה' });
        return;
      }
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { passHash: lib.hashPassword(newPassword), updatedAt: new Date() } }
      );
      /* מנתק סשנים אחרים של אותו יוזר, שומר את הנוכחי */
      const token = lib.tokenFromReq(req);
      await db.collection('sessions').deleteMany({ userId: user._id, _id: { $ne: token } }).catch(() => {});
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
