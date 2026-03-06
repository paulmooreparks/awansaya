/*
  Awan Saya — Hub directory & portal server

  Serves the www/ directory on PORT (default 3000).
  Resolves directory requests to index.html.

  Hubs are registered via POST /api/hubs with a name, URL, and viewer
  token.  The viewer token is stored in config.json but never exposed
  to the browser.  Server-side proxy endpoints /api/hub-status/<name>
  and /api/hub-history/<name> use the stored token to fetch data from
  each hub so auth secrets stay on the server.
*/
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

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

// GET /api/hubs — return the hub list from portal/config.json (tokens stripped)
function apiGetHubs(req, res) {
  if (!checkAuth(req, res)) return;
  readConfig((err, cfg) => {
    if (err) return jsonError(res, 500, 'config not found');
    // Strip viewerToken so it never reaches the browser
    const hubs = (cfg.hubs || []).map(h => ({ name: h.name, url: h.url }));
    jsonOK(res, { hubs });
  });
}

// POST /api/hubs — add a hub { name, url, viewerToken }
function apiAddHub(req, res) {
  if (!checkAuth(req, res)) return;
  readBody(req, (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const name        = (body.name || '').trim();
    const hubUrl      = (body.url  || '').trim().replace(/\/+$/, '');
    const viewerToken = (body.viewerToken || '').trim();
    if (!name || !hubUrl) return jsonError(res, 400, 'name and url are required');

    readConfig((err, cfg) => {
      if (err) return jsonError(res, 500, 'config not found');
      const hubs = cfg.hubs || [];
      const dup = hubs.find(h => h.name === name || h.url === hubUrl);
      if (dup) return jsonError(res, 409, 'hub with that name or URL already exists');

      const entry = { name, url: hubUrl };
      if (viewerToken) entry.viewerToken = viewerToken;
      hubs.push(entry);
      cfg.hubs = hubs;
      writeConfig(cfg, (err) => {
        if (err) return jsonError(res, 500, 'failed to write config');
        // Return list without tokens
        const safe = hubs.map(h => ({ name: h.name, url: h.url }));
        jsonOK(res, { hubs: safe });
      });
    });
  });
}

// DELETE /api/hubs?name=<name> — remove a hub by name
function apiDeleteHub(req, res) {
  if (!checkAuth(req, res)) return;
  const u = new URL(req.url, 'http://localhost');
  const name = (u.searchParams.get('name') || '').trim();
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
      const safe = hubs.map(h => ({ name: h.name, url: h.url }));
      jsonOK(res, { hubs: safe });
    });
  });
}

// ── Server-side hub status/history proxy ────────────────────────────

// Looks up a hub by name in config.json and returns { url, viewerToken }.
function lookupHub(hubName, cb) {
  readConfig((err, cfg) => {
    if (err) return cb(null);
    const hub = (cfg.hubs || []).find(h => h.name === hubName);
    cb(hub || null);
  });
}

// Fetches a URL using the correct http/https module, returns a Promise<string>.
function proxyFetch(targetUrl) {
  return new Promise((resolve, reject) => {
    const mod = targetUrl.startsWith('https') ? https : http;
    const req = mod.get(targetUrl, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// GET /api/hub-status/<name> — proxy to hub's /api/status with viewer token
function apiHubStatus(req, res, hubName) {
  lookupHub(hubName, (hub) => {
    if (!hub) return jsonError(res, 404, 'hub not found');

    let targetUrl = hub.url + '/api/status';
    if (hub.viewerToken) targetUrl += '?token=' + encodeURIComponent(hub.viewerToken);

    proxyFetch(targetUrl)
      .then(result => {
        res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(result.body);
      })
      .catch(err => {
        jsonError(res, 502, 'hub unreachable: ' + err.message);
      });
  });
}

// GET /api/hub-history/<name> — proxy to hub's /api/history with viewer token
function apiHubHistory(req, res, hubName) {
  lookupHub(hubName, (hub) => {
    if (!hub) return jsonError(res, 404, 'hub not found');

    let targetUrl = hub.url + '/api/history';
    if (hub.viewerToken) targetUrl += '?token=' + encodeURIComponent(hub.viewerToken);

    proxyFetch(targetUrl)
      .then(result => {
        res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(result.body);
      })
      .catch(err => {
        jsonError(res, 502, 'hub unreachable: ' + err.message);
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

  // /api/hub-status/<name> and /api/hub-history/<name>
  const statusMatch = urlPath.match(/^\/api\/hub-status\/(.+)$/);
  if (statusMatch && (method === 'GET' || method === 'HEAD')) {
    return apiHubStatus(req, res, decodeURIComponent(statusMatch[1]));
  }
  const historyMatch = urlPath.match(/^\/api\/hub-history\/(.+)$/);
  if (historyMatch && (method === 'GET' || method === 'HEAD')) {
    return apiHubHistory(req, res, decodeURIComponent(historyMatch[1]));
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
  console.log(`[awansaya] listening on :${PORT}`);
});
