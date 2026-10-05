/**
 * /api/users — ניהול יוזרים (סופר-אדמין בלבד)
 * ---------------------------------------------
 * GET  → {ok, users:[{id, slug, displayName, username, status, createdAt, siteUpdatedAt}]}
 * POST {action:'create',         displayName, slug, username, password}
 * POST {action:'formLink',       id|slug}                ← קישור טופס מילוי ללקוח (יוצר טוקן אם חסר)
 * POST {action:'newFormToken',   id|slug}                ← חידוש הטוקן (מבטל קישור ישן)
 * POST {action:'update',         id, displayName?, slug?, username?}
 * POST {action:'resetPassword',  id, newPassword}      (מנתק את כל הסשנים של היוזר)
 * POST {action:'setStatus',      id, status:'active'|'suspended'}
 * POST {action:'delete',         id, confirmSlug}      (מוחק גם את התוכן והסשנים)
 *
 * כל בקשה דורשת Authorization: Bearer <token> של סופר-אדמין.
 */
'use strict';
const { ObjectId } = require('mongodb');
const lib = require('./_lib.js');

function safeUser(u) {
  return {
    id: String(u._id),
    slug: u.slug,
    displayName: u.displayName,
    username: u.username,
    status: u.status,
    theme: u.theme || 'business',
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null
  };
}

function parseId(v) {
  try { return new ObjectId(String(v)); } catch (e) { return null; }
}

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

    const users = db.collection('users');
    const content = db.collection('content');

    /* ---------- setTheme: היוזר מחליף את עיצוב הדף של עצמו ----------
       (סופר-אדמין יכול לשנות לכל יוזר עם slug) — לפני שער הסופר-אדמין */
    if (req.method === 'POST') {
      const b0 = (req.body && typeof req.body === 'object') ? req.body : {};
      if (String(b0.action || '') === 'setTheme') {
        const s0 = await lib.getSession(req, db);
        if (!s0) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
        const theme = String(b0.theme || '');
        if (!lib.validTheme(theme)) { res.status(400).json({ ok: false, error: 'עיצוב לא תקין' }); return; }
        let target = null;
        if (s0.role === 'superadmin') {
          const slug = String(b0.slug || '').trim().toLowerCase();
          if (slug) target = await users.findOne({ slug });
        } else {
          target = await users.findOne({ _id: s0.userId });
        }
        if (!target) { res.status(404).json({ ok: false, error: 'יוזר לא נמצא' }); return; }
        await users.updateOne(
          { _id: target._id },
          { $set: { theme, updatedAt: new Date() } }
        );
        res.status(200).json({
          ok: true,
          theme,
          slug: target.slug,
          url: theme === 'kids' ? ('/' + target.slug) : ('/b/' + target.slug)
        });
        return;
      }
    }

    const s = await lib.getSession(req, db);
    if (!s || s.role !== 'superadmin') {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }

    /* ---------- GET: רשימת יוזרים + עדכון אחרון + סטטיסטיקות צפיות ---------- */
    if (req.method === 'GET') {
      const list = await users.find({}, { projection: { passHash: 0 } }).sort({ createdAt: -1 }).toArray();
      const conts = await content.find({}, { projection: { slug: 1, updatedAt: 1, 'content.formFilled': 1 } }).toArray();
      const bySlug = {};
      const filledBy = {};
      conts.forEach(c => {
        bySlug[c.slug] = c.updatedAt || null;
        filledBy[c.slug] = !!(c.content && c.content.formFilled);
      });

      /* צפיות לכל slug: סה״כ / היום (לפי יום ישראל) / ב-7 ימים / אחרונה */
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const views = await db.collection('pageviews').aggregate([
        { $group: {
          _id: '$slug',
          viewsTotal: { $sum: 1 },
          viewsToday: { $sum: { $cond: [{ $eq: ['$day', todayStr] }, 1, 0] } },
          viewsWeek: { $sum: { $cond: [{ $gte: ['$at', weekAgo] }, 1, 0] } },
          lastView: { $max: '$at' }
        } }
      ]).toArray();
      const viewsBy = {};
      views.forEach(v => { viewsBy[v._id] = v; });

      res.status(200).json({
        ok: true,
        users: list.map(u => Object.assign(safeUser(u), {
          siteUpdatedAt: bySlug[u.slug] || null,
          formFilled: filledBy[u.slug] || false,
          viewsTotal: (viewsBy[u.slug] || {}).viewsTotal || 0,
          viewsToday: (viewsBy[u.slug] || {}).viewsToday || 0,
          viewsWeek: (viewsBy[u.slug] || {}).viewsWeek || 0,
          lastView: (viewsBy[u.slug] || {}).lastView || null
        }))
      });
      return;
    }

    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const action = String(b.action || '');

    /* ---------- create ---------- */
    if (action === 'create') {
      const displayName = String(b.displayName || '').trim();
      const slug = String(b.slug || '').trim().toLowerCase();
      const username = String(b.username || '').trim().toLowerCase();
      const password = String(b.password || '');
      const theme = lib.validTheme(b.theme) ? b.theme : 'business';
      if (!displayName) { res.status(400).json({ ok: false, error: 'נדרש שם תצוגה' }); return; }
      if (!lib.validSlug(slug)) { res.status(400).json({ ok: false, error: 'slug לא תקין (2–31 תווים באנגלית, מספרים ומקף)' }); return; }
      if (!lib.validUsername(username)) { res.status(400).json({ ok: false, error: 'שם משתמש לא תקין (3–30 תווים: אנגלית, מספרים, נקודה, מקף)' }); return; }
      if (password.length < 6) { res.status(400).json({ ok: false, error: 'הסיסמה קצרה מדי (מינימום 6 תווים)' }); return; }

      const clash = await users.findOne({ $or: [{ slug }, { username }] });
      if (clash) {
        res.status(409).json({ ok: false, error: clash.slug === slug ? 'ה-slug כבר תפוס' : 'שם המשתמש כבר תפוס' });
        return;
      }
      const now = new Date();
      const formToken = lib.genFormToken();
      const r = await users.insertOne({
        slug, displayName, username,
        passHash: lib.hashPassword(password),
        status: 'active',
        theme,
        formToken,
        createdAt: now,
        updatedAt: now
      });
      await content.updateOne(
        { slug },
        { $set: { slug, content: lib.templateContent(displayName, theme), updatedAt: now } },
        { upsert: true }
      );
      res.status(200).json({ ok: true, user: safeUser({ _id: r.insertedId, slug, displayName, username, status: 'active', theme, createdAt: now, updatedAt: now }), formToken });
      return;
    }

    /* ---------- formLink: קישור טופס המילוי ללקוח (יוצר טוקן אם חסר — גם ליוזרים ותיקים) ---------- */
    if (action === 'formLink' || action === 'newFormToken') {
      const id = parseId(b.id);
      const bySlug = !id ? String(b.slug || '').trim().toLowerCase() : null;
      const user = id ? await users.findOne({ _id: id }) : (bySlug ? await users.findOne({ slug: bySlug }) : null);
      if (!user) { res.status(404).json({ ok: false, error: 'יוזר לא נמצא' }); return; }
      let token = user.formToken;
      if (action === 'newFormToken' || !token) {
        token = lib.genFormToken();
        await users.updateOne({ _id: user._id }, { $set: { formToken: token, updatedAt: new Date() } });
      }
      res.status(200).json({ ok: true, slug: user.slug, token, theme: user.theme });
      return;
    }

    /* ---------- stats: פירוט צפיות ליוזר ---------- */
    if (action === 'stats') {
      const id = parseId(b.id);
      const user = id ? await users.findOne({ _id: id }) : null;
      if (!user) { res.status(404).json({ ok: false, error: 'יוזר לא נמצא' }); return; }
      const pv = db.collection('pageviews');
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [totals] = await pv.aggregate([
        { $match: { slug: user.slug } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          today: { $sum: { $cond: [{ $eq: ['$day', todayStr] }, 1, 0] } },
          week: { $sum: { $cond: [{ $gte: ['$at', weekAgo] }, 1, 0] } },
          lastView: { $max: '$at' }
        } }
      ]).toArray();

      const daily = await pv.aggregate([
        { $match: { slug: user.slug } },
        { $group: { _id: '$day', n: { $sum: 1 } } },
        { $sort: { _id: -1 } },
        { $limit: 14 }
      ]).toArray();

      const recent = await pv.find({ slug: user.slug }, { projection: { at: 1, ref: 1 } })
        .sort({ at: -1 }).limit(8).toArray();

      res.status(200).json({
        ok: true,
        total: totals ? totals.total : 0,
        today: totals ? totals.today : 0,
        week: totals ? totals.week : 0,
        lastView: totals ? totals.lastView : null,
        daily: daily.map(d => ({ day: d._id, n: d.n })),
        recent: recent.map(v => ({ at: v.at, ref: v.ref || '' }))
      });
      return;
    }

    /* ---------- update ---------- */
    if (action === 'update') {
      const id = parseId(b.id);
      const user = id ? await users.findOne({ _id: id }) : null;
      if (!user) { res.status(404).json({ ok: false, error: 'יוזר לא נמצא' }); return; }

      const upd = {};
      if (b.displayName !== undefined) {
        const displayName = String(b.displayName || '').trim();
        if (!displayName) { res.status(400).json({ ok: false, error: 'שם התצוגה לא יכול להיות ריק' }); return; }
        upd.displayName = displayName;
      }
      if (b.theme !== undefined) {
        if (!lib.validTheme(b.theme)) { res.status(400).json({ ok: false, error: 'עיצוב לא תקין' }); return; }
        if (b.theme !== (user.theme || 'business')) upd.theme = b.theme;
      }
      let newSlug = null;
      if (b.slug !== undefined) {
        newSlug = String(b.slug || '').trim().toLowerCase();
        if (!lib.validSlug(newSlug)) { res.status(400).json({ ok: false, error: 'slug לא תקין' }); return; }
        if (newSlug !== user.slug) upd.slug = newSlug;
        else newSlug = null;
      }
      if (b.username !== undefined) {
        const username = String(b.username || '').trim().toLowerCase();
        if (!lib.validUsername(username)) { res.status(400).json({ ok: false, error: 'שם משתמש לא תקין' }); return; }
        if (username !== user.username) upd.username = username;
      }

      const or = [];
      if (upd.slug) or.push({ slug: upd.slug });
      if (upd.username) or.push({ username: upd.username });
      if (or.length) {
        const clash = await users.findOne({ $or: or, _id: { $ne: user._id } });
        if (clash) {
          res.status(409).json({ ok: false, error: clash.slug === upd.slug ? 'ה-slug כבר תפוס' : 'שם המשתמש כבר תפוס' });
          return;
        }
      }
      if (!Object.keys(upd).length) { res.status(200).json({ ok: true, user: safeUser(user) }); return; }

      upd.updatedAt = new Date();
      await users.updateOne({ _id: user._id }, { $set: upd });
      if (newSlug) {
        await content.updateOne({ slug: user.slug }, { $set: { slug: newSlug } });
      }
      const fresh = await users.findOne({ _id: user._id }, { projection: { passHash: 0 } });
      res.status(200).json({ ok: true, user: safeUser(fresh) });
      return;
    }

    /* ---------- resetPassword ---------- */
    if (action === 'resetPassword') {
      const id = parseId(b.id);
      const newPassword = String(b.newPassword || '');
      const user = id ? await users.findOne({ _id: id }) : null;
      if (!user) { res.status(404).json({ ok: false, error: 'יוזר לא נמצא' }); return; }
      if (newPassword.length < 6) { res.status(400).json({ ok: false, error: 'הסיסמה קצרה מדי (מינימום 6 תווים)' }); return; }
      await users.updateOne(
        { _id: user._id },
        { $set: { passHash: lib.hashPassword(newPassword), updatedAt: new Date() } }
      );
      await db.collection('sessions').deleteMany({ userId: user._id }).catch(() => {});
      res.status(200).json({ ok: true });
      return;
    }

    /* ---------- setStatus ---------- */
    if (action === 'setStatus') {
      const id = parseId(b.id);
      const status = String(b.status || '');
      const user = id ? await users.findOne({ _id: id }) : null;
      if (!user) { res.status(404).json({ ok: false, error: 'יוזר לא נמצא' }); return; }
      if (status !== 'active' && status !== 'suspended') {
        res.status(400).json({ ok: false, error: 'סטטוס לא תקין' });
        return;
      }
      await users.updateOne({ _id: user._id }, { $set: { status, updatedAt: new Date() } });
      if (status === 'suspended') {
        await db.collection('sessions').deleteMany({ userId: user._id }).catch(() => {});
      }
      res.status(200).json({ ok: true });
      return;
    }

    /* ---------- delete ---------- */
    if (action === 'delete') {
      const id = parseId(b.id);
      const user = id ? await users.findOne({ _id: id }) : null;
      if (!user) { res.status(404).json({ ok: false, error: 'יוזר לא נמצא' }); return; }
      if (String(b.confirmSlug || '').trim() !== user.slug) {
        res.status(400).json({ ok: false, error: 'נדרש אישור: הקלידו את ה-slug המדויק למחיקה' });
        return;
      }
      await users.deleteOne({ _id: user._id });
      await content.deleteMany({ slug: user.slug });
      await db.collection('sessions').deleteMany({ userId: user._id }).catch(() => {});
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
