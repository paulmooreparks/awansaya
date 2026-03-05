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
const API_TOKEN     = process.env.AWANSATU_API_TOKEN || '';   // empty = open mode
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

// ── Helpers for config.json I/O ─────────────────────────────────

function readConfig(cb) {
  fs.readFile(CONFIG_PATH, 'utf8', (err, raw) => {
    if (err) return cb(err, null);
    try { cb(null, JSON.parse(raw)); }
    catch (e) { cb(e, null); }
  });
}

function writeConfig(cfg, cb) {
  const json = JSON.stringify(cfg, null, 2) + '\n';
  fs.writeFile(CONFIG_PATH, json, 'utf8', cb);
}

function jsonError(res, status, msg) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

function jsonOK(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try { cb(null, JSON.parse(body)); }
    catch (e) { cb(e, null); }
  });
}

// GET /api/hubs — return the hub list from portal/config.json
function apiGetHubs(req, res) {
  if (!checkAuth(req, res)) return;
  readConfig((err, cfg) => {
    if (err) return jsonError(res, 500, 'config not found');
    jsonOK(res, { hubs: cfg.hubs || [] });
  });
}

// POST /api/hubs — add a hub { name, url }
function apiAddHub(req, res) {
  if (!checkAuth(req, res)) return;
  readBody(req, (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const name = (body.name || '').trim();
    const url  = (body.url  || '').trim().replace(/\/+$/, '');
    if (!name || !url) return jsonError(res, 400, 'name and url are required');

    readConfig((err, cfg) => {
      if (err) return jsonError(res, 500, 'config not found');
      const hubs = cfg.hubs || [];
      const dup = hubs.find(h => h.name === name || h.url === url);
      if (dup) return jsonError(res, 409, 'hub with that name or URL already exists');

      hubs.push({ name, url });
      cfg.hubs = hubs;
      writeConfig(cfg, (err) => {
        if (err) return jsonError(res, 500, 'failed to write config');
        jsonOK(res, { hubs });
      });
    });
  });
}

// DELETE /api/hubs?name=<name> — remove a hub by name
function apiDeleteHub(req, res) {
  if (!checkAuth(req, res)) return;
  const url = new URL(req.url, 'http://localhost');
  const name = (url.searchParams.get('name') || '').trim();
  if (!name) return jsonError(res, 400, 'name query parameter is required');

  readConfig((err, cfg) => {
    if (err) return jsonError(res, 500, 'config not found');
    const hubs = cfg.hubs || [];
    const idx = hubs.findIndex(h => h.name === name);
    if (idx === -1) return jsonError(res, 404, 'hub not found');

    hubs.splice(idx, 1);
    cfg.hubs = hubs;
    writeConfig(cfg, (err) => {
      if (err) return jsonError(res, 500, 'failed to write config');
      jsonOK(res, { hubs });
    });
  });
}

// ── Request router ─────────────────────────────────────────────────

function serve(req, res) {
  const method  = req.method;
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // API routes
  if (urlPath === '/api/hubs') {
    if (method === 'GET' || method === 'HEAD') return apiGetHubs(req, res);
    if (method === 'POST')   return apiAddHub(req, res);
    if (method === 'DELETE') return apiDeleteHub(req, res);
    res.writeHead(405); res.end(); return;
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
