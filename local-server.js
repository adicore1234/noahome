/**
 * שרת מקומי — Pagely: דפי נחיתה רב-משתמשים.
 * ------------------------------------------------
 * הרצה:  node local-server.js   →   http://localhost:8123
 *
 * ניתוב:
 *   /                → עמוד הכניסה של Pagely (index.html)
 *   /admin[/]        → העורך (admin/index.html) — לפי הסשן של המחובר
 *   /superadmin[/]   → לוח ניהול היוזרים (סופר-אדמין)
 *   /<slug>          → דף הנחיתה הציבורי של היוזר (site.html; ה-slug נקרא בדפדפן)
 *   /api/content|auth|users → פונקציות ה-API (api/*.js)
 *   כל השאר          → קבצים סטטיים (assets/ וכו')
 *
 * בדיפלוי ל-Vercel הקובץ הזה לא נחוץ — api/*.js רצות כ-serverless
 * וה-rewrite ב-vercel.json ממפה /:slug → site.html.
 * השם אינו server.js בכוונה: Vercel מזהה שם כזה אוטומטית כשרת ראשי
 * ובמקרה כזה אינו מפרסם את קובצי ה-static מתוך dist.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

/* טעינת .env ידנית (בלי תלות בחבילות) */
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    txt.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\r\n]*)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    });
  } catch (e) { /* אין .env — נמשיך עם מה שיש */ }
})();

/* פונקציות ה-API — אותן פונקציות ש-Vercel מפרוס כ-serverless */
const API_HANDLERS = {
  '/api/content': require('./api/content.js'),
  '/api/auth': require('./api/auth.js'),
  '/api/users': require('./api/users.js'),
  '/api/track': require('./api/track.js'),
  '/api/form': require('./api/form.js')
};

/* adapter: מעטפת דמוית-Vercel סביב תשובת http נטיבית (status/json/send) */
function vercelRes(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  res.send = body => { res.end(body); return res; };
  return res;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serveFile(res, fp) {
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) { res.writeHead(400); res.end('400'); return; }

  /* ---------- API ---------- */
  if (pathname.startsWith('/api/')) {
    vercelRes(res);
    const base = '/api/' + pathname.slice(5).split('/')[0];
    const handler = API_HANDLERS[base];
    if (!handler) { res.status(404).json({ ok: false, error: 'unknown api endpoint' }); return; }
    req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 15e6) req.destroy(); });
      req.on('end', async () => {
        try { req.body = raw ? JSON.parse(raw) : null; }
        catch (e) { req.body = null; }
        try { await handler(req, res); }
        catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      });
      return;
    }
    try { await handler(req, res); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  /* ---------- דפי המערכת ---------- */
  const segs = pathname.split('/').filter(Boolean);

  if (pathname === '/' || pathname === '') {
    serveFile(res, path.join(__dirname, 'index.html'));
    return;
  }
  if (segs[0] === 'admin' && segs.length === 1) {
    serveFile(res, path.join(__dirname, 'admin', 'index.html'));
    return;
  }
  if (segs[0] === 'superadmin' && segs.length === 1) {
    serveFile(res, path.join(__dirname, 'superadmin', 'index.html'));
    return;
  }

  /* ---------- קובץ סטטי קיים ---------- */
  const cand = path.join(__dirname, pathname.replace(/^([/\\])+/, ''));
  if (cand.startsWith(__dirname) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
    serveFile(res, cand);
    return;
  }

  /* ---------- דף נחיתה לפי slug (מקטע אחד) ---------- */
  if (segs.length === 1) {
    if (/\/$/.test(pathname)) {
      /* נרמול קו-נטוי: /noa/ → /noa (כדי שנתיבים יחסיים בדף יעבדו) */
      res.writeHead(301, { Location: pathname.replace(/\/+$/, '') });
      res.end();
      return;
    }
    serveFile(res, path.join(__dirname, 'site.html'));
    return;
  }

  /* ---------- התבנית העסקית: /b/<slug> ---------- */
  if (segs[0] === 'b' && segs.length === 2) {
    serveFile(res, path.join(__dirname, 'site-business.html'));
    return;
  }

  /* ---------- טופס המילוי ללקוח: /f/<slug> ---------- */
  if (segs[0] === 'f' && segs.length === 2) {
    serveFile(res, path.join(__dirname, 'form.html'));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

const PORT = process.env.PORT || 8123;
server.listen(PORT, () => console.log('✅ Pagely רץ: http://localhost:' + PORT + '  ·  כניסה: http://localhost:' + PORT + '/  ·  סופר-אדמין: http://localhost:' + PORT + '/superadmin'));
