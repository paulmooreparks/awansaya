/*
  Awan Satu — Static file server

  Serves the www/ directory on PORT (default 3000).
  Resolves directory requests to index.html.
*/
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT          = parseInt(process.env.PORT || '3000', 10);
const WWW_DIR       = path.join(__dirname, 'www');
const API_TOKEN     = process.env.TELA_API_TOKEN || '';   // empty = open mode
const CONFIG_PATH   = path.join(WWW_DIR, 'portal', 'config.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

// ── API routes ─────────────────────────────────────────────────────

function checkAuth(req, res) {
  if (!API_TOKEN) return true;                       // open mode
  const hdr = req.headers['authorization'] || '';
  if (hdr === 'Bearer ' + API_TOKEN) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

// GET /api/hubs — return the hub list from portal/config.json
function apiHubs(req, res) {
  if (!checkAuth(req, res)) return;
  fs.readFile(CONFIG_PATH, 'utf8', (err, raw) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'config not found' }));
      return;
    }
    try {
      const cfg = JSON.parse(raw);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify({ hubs: cfg.hubs || [] }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid config' }));
    }
  });
}

// ── Request router ─────────────────────────────────────────────────

function serve(req, res) {
  const method  = req.method;
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // API routes
  if (urlPath === '/api/hubs' && (method === 'GET' || method === 'HEAD')) {
    return apiHubs(req, res);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405); res.end(); return;
  }

  let filePath = path.join(WWW_DIR, urlPath);

  // Prevent path traversal
  if (!filePath.startsWith(WWW_DIR)) {
    res.writeHead(403); res.end(); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }

    // Directory → index.html
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      fs.stat(filePath, (err2) => {
        if (err2) { res.writeHead(404); res.end('Not Found'); return; }
        sendFile(filePath, res);
      });
      return;
    }

    sendFile(filePath, res);
  });
}

function sendFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(serve);
server.listen(PORT, () => {
  console.log(`[awansatu] listening on :${PORT}`);
});
