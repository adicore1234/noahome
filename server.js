/**
 * שרת מקומי — מגיש את האתר + את /api/content (MongoDB) בכתובת אחת.
 * הרצה:  node server.js   →   http://localhost:8123  (ו-/admin/)
 * בדיפלוי ל-Vercel הקובץ הזה לא נחוץ — api/content.js רץ כ-serverless.
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

const contentHandler = require('./api/content.js');

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

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  /* --- API --- */
  if (pathname.startsWith('/api/')) {
    vercelRes(res);
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 15e6) req.destroy(); });
      req.on('end', async () => {
        try { req.body = raw ? JSON.parse(raw) : null; }
        catch (e) { req.body = null; }
        try { await contentHandler(req, res); }
        catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      });
      return;
    }
    try { await contentHandler(req, res); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  /* --- static files --- */
  let fp;
  if (pathname === '/' || pathname === '') fp = path.join(__dirname, 'index.html');
  else if (pathname === '/admin' || pathname === '/admin/') fp = path.join(__dirname, 'admin', 'index.html');
  else fp = path.join(__dirname, pathname.replace(/^([/\\])+/, ''));

  if (!fp.startsWith(__dirname)) { res.writeHead(403); res.end('403'); return; }

  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = process.env.PORT || 8123;
server.listen(PORT, () => console.log('✅ השרת רץ: http://localhost:' + PORT + '  ·  אדמין: http://localhost:' + PORT + '/admin/'));
