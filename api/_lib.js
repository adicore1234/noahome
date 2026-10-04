/**
 * _lib.js — מודול משותף לכל פונקציות ה-API של Pagely.
 * הקובץ מתחיל בקו תחתון כדי ש-Vercel לא יפרוס אותו כפונקציה עצמאית.
 *
 * מכיל: חיבור MongoDB (singleton), הצפנת סיסמאות (scrypt), סשנים,
 * ולידציית slug, אינדקסים + מיגרציה של הנתונים הישנים, ותבנית תוכן ליוזר חדש.
 */
'use strict';
const { MongoClient, ServerApiVersion } = require('mongodb');
const crypto = require('crypto');
const defaultContent = require('../content.json');        /* המקור של הדף הראשון (noa) — לגיבוי בלבד */
const templateBusiness = require('../template.json');     /* התבנית העסקית — ברירת המחדל ליוזרים חדשים */
const templateKids = require('../template-kids.json');    /* התבנית הצבעונית לתחום הילדים */

/* ==================== MongoDB ==================== */
function mongoUri() {
  let u = process.env.MONGODB_URI || process.env.MONGO_URI || '';
  /* מנרמל ערכים שהודבקו עם תחילית/מרכאות בטעות מהדאשבורד של Vercel */
  u = String(u).trim().replace(/^MONGODB_URI\s*=\s*/i, '').trim();
  if ((u.startsWith('"') && u.endsWith('"')) || (u.startsWith("'") && u.endsWith("'"))) {
    u = u.slice(1, -1).trim();
  }
  const p = process.env.MONGODB_PASSWORD;
  if (p && u.includes('<password>')) u = u.replace('<password>', encodeURIComponent(p));
  if (u && !/^mongodb(?:\+srv)?:\/\//i.test(u)) {
    throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  }
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

/* ==================== סיסמאות (scrypt, בלי תלות חוץ) ==================== */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64);
  return 's1$' + salt.toString('hex') + '$' + key.toString('hex');
}

function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 's1') return false;
    const key = crypto.scryptSync(String(pw), Buffer.from(parts[1], 'hex'), 64);
    return safeEqual(key, Buffer.from(parts[2], 'hex'));
  } catch (e) { return false; }
}

/* ==================== סופר-אדמין (משתני סביבה בלבד) ==================== */
function isSuperadminLogin(username, password) {
  const u = process.env.SUPERADMIN_USER || '';
  const p = process.env.SUPERADMIN_PASS || '';
  if (!u || !p) return false;
  return safeEqual(String(username || '').trim().toLowerCase(), u) && safeEqual(String(password || ''), p);
}

/* ==================== throttling לכניסות (best-effort, לכל מופד) ==================== */
const _fails = new Map(); /* key → {n, until} */
function throttleBlocked(key) {
  const f = _fails.get(key);
  if (!f) return false;
  if (Date.now() > f.until) { _fails.delete(key); return false; }
  return f.n >= 10;
}
function throttleFail(key) {
  const f = _fails.get(key) || { n: 0, until: 0 };
  if (Date.now() > f.until) f.n = 0;
  f.n += 1;
  f.until = Date.now() + 10 * 60 * 1000;
  _fails.set(key, f);
}
function throttleClear(key) { _fails.delete(key); }

/* ==================== slugs ==================== */
const RESERVED_SLUGS = new Set([
  'admin', 'superadmin', 'api', 'assets', 'site', 'index', 'login', 'logout',
  'content', 'robots', 'favicon', 'vercel', 'public', 'www', 'app', 'cdn', 'static', 'b'
]);

/* ==================== עיצובים (themes) ==================== */
/* 'business' — עמוד תצוגה עסקי-מקצועי (ברירת המחדל, נפתח ב-/b/<slug>)
   'kids'     — העיצוב הצבעוני-ילדי המקורי (נפתח ב-/<slug>)                */
const THEMES = { business: true, kids: true };
function validTheme(t) { return typeof t === 'string' && !!THEMES[t]; }
function validSlug(s) {
  return typeof s === 'string' &&
    /^[a-z0-9][a-z0-9-]{1,30}$/.test(s) &&
    !s.includes('--') &&
    !RESERVED_SLUGS.has(s);
}
function validUsername(s) {
  return typeof s === 'string' && /^[a-z0-9._-]{3,30}$/.test(s);
}

/* ==================== סשנים ==================== */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; /* 7 ימים */

function tokenFromReq(req) {
  const h = req.headers['authorization'] || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function createSession(db, { role, userId, slug, displayName }) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.collection('sessions').insertOne({
    _id: token,
    role,
    userId: userId || null,
    slug: slug || null,
    displayName: displayName || '',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS)
  });
  return token;
}

/* מחזיר {role, slug, userId, displayName, username} או null.
   יוזר שהושעה/נמחק — הסשן שלו לא תקף עוד (הסטטוס נקרא מהמסד בכל בדיקה). */
async function getSession(req, db) {
  const token = tokenFromReq(req);
  if (!token) return null;
  const doc = await db.collection('sessions').findOne({ _id: token });
  if (!doc) return null;
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) {
    await db.collection('sessions').deleteOne({ _id: token }).catch(() => {});
    return null;
  }
  if (doc.role === 'superadmin') {
    return { role: 'superadmin', slug: null, userId: null, displayName: 'סופר-אדמין', username: null };
  }
  const user = await db.collection('users').findOne({ _id: doc.userId });
  if (!user || user.status !== 'active') {
    await db.collection('sessions').deleteOne({ _id: token }).catch(() => {});
    return null;
  }
  return { role: 'user', slug: user.slug, userId: user._id, displayName: user.displayName, username: user.username };
}

/* ==================== אינדקסים + מיגרציה (רץ פעם אחת לכל תהליך) ==================== */
let _ready = null;
async function ensureReady(db) {
  if (_ready) return _ready;
  _ready = (async () => {
    await db.collection('users').createIndex({ slug: 1 }, { unique: true });
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    await db.collection('content').createIndex({ slug: 1 }, { unique: true });
    await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection('pageviews').createIndex({ slug: 1, at: -1 });
    await db.collection('pageviews').createIndex({ day: 1 });
    await migrateLegacy(db);
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

/**
 * מיגרציה של המערכת הישנה (מסמך יחיד {key:'site'} בלי יוזרים):
 * יוצרת את יוזר "noa" מ-ADMIN_USER/ADMIN_PASS הקיימים ומתייגת את מסמך
 * התוכן עם slug:'noa'. אידמפוטנטית ובטוחה להרצות חוזרות.
 * יוזרים קיימים בלי שדה theme מקבלים עיצוב: noa → kids, השאר → business.
 */
async function migrateLegacy(db) {
  const users = db.collection('users');
  const content = db.collection('content');
  const legacy = await content.findOne({ key: 'site' });
  if (legacy) {
    const nUsers = await users.countDocuments({});
    if (nUsers === 0) {
      const u = String(process.env.ADMIN_USER || 'noahome').trim().toLowerCase();
      const p = String(process.env.ADMIN_PASS || '12345678');
      try {
        await users.insertOne({
          slug: 'noa',
          displayName: 'המקום של נעה',
          username: u,
          passHash: hashPassword(p),
          status: 'active',
          theme: 'kids',
          createdAt: new Date(),
          updatedAt: new Date()
        });
      } catch (e) { /* מרוץ יצירה — היוזר כבר נוצר */ }
    }
    const hasNoa = await content.findOne({ slug: 'noa' });
    if (!hasNoa) {
      await content.updateOne(
        { key: 'site', slug: { $exists: false } },
        { $set: { slug: 'noa' }, $unset: { key: '' } }
      );
    }
  }
  /* מילוי-חזרה של עיצוב ליוזרים שנוצרו לפני שהיו תמות */
  const noTheme = await users.find({ theme: { $exists: false } }, { projection: { slug: 1 } }).toArray();
  for (const u of noTheme) {
    await users.updateOne({ _id: u._id }, { $set: { theme: u.slug === 'noa' ? 'kids' : 'business' } });
  }
}

/* ==================== תבנית תוכן ליוזר חדש (לפי עיצוב) ==================== */
function templateContent(displayName, theme) {
  const base = theme === 'kids' ? templateKids : templateBusiness;
  const c = JSON.parse(JSON.stringify(base));
  if (displayName) {
    if (c.meta) c.meta.title = displayName;
    if (c.intro) c.intro.name = displayName;
    if (theme !== 'kids' && c.header) c.header.logoText = displayName;
    /* בתבנית העסקית גם הפוטר נושא את שם בעל העסק, לא "שם העסק" הגנרי */
    if (theme !== 'kids' && c.footer && typeof c.footer.brand === 'string' && c.footer.brand.indexOf('שם העסק') === 0) {
      c.footer.brand = displayName + ' · נוצר עם Pagely';
    }
  }
  return c;
}

module.exports = {
  getDb, hashPassword, verifyPassword, safeEqual, isSuperadminLogin,
  throttleBlocked, throttleFail, throttleClear,
  validSlug, validUsername, RESERVED_SLUGS, validTheme,
  tokenFromReq, createSession, getSession, ensureReady, migrateLegacy, templateContent
};
