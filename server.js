/*
  Awan Saya — Hub directory & portal server

  Serves the www/ directory on PORT (default 3000).
  Resolves directory requests to index.html.

  Hub records are stored in PostgreSQL. On first startup, if the hubs
  table is empty and a legacy www/portal/config.json file exists, its
  data is imported automatically.
*/
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3000', 10);
const WWW_DIR = path.join(__dirname, 'www');
const API_TOKEN = process.env.AWANSAYA_API_TOKEN || '';   // empty = open mode
const CONFIG_PATH = path.join(WWW_DIR, 'portal', 'config.json');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://awansaya:awansaya-dev-password@db:5432/awansaya';
const DB_CONNECT_RETRIES = parseInt(process.env.DB_CONNECT_RETRIES || '30', 10);
const DB_CONNECT_DELAY_MS = parseInt(process.env.DB_CONNECT_DELAY_MS || '2000', 10);

const pool = new Pool({
	connectionString: DATABASE_URL,
});

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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectWithRetry() {
  for (let attempt = 1; attempt <= DB_CONNECT_RETRIES; attempt += 1) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (err) {
      if (attempt === DB_CONNECT_RETRIES) throw err;
      console.warn(`[awansaya] database not ready (attempt ${attempt}/${DB_CONNECT_RETRIES}): ${err.message}`);
      await sleep(DB_CONNECT_DELAY_MS);
    }
  }
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hubs (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL UNIQUE,
      viewer_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS hubs_set_updated_at ON hubs
  `);

  await pool.query(`
    CREATE TRIGGER hubs_set_updated_at
    BEFORE UPDATE ON hubs
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at()
  `);
}

function readLegacyConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[awansaya] failed to parse legacy config: ${err.message}`);
    return null;
  }
}

async function importLegacyConfigIfNeeded() {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM hubs');
  if (result.rows[0].count > 0) return;

  const cfg = readLegacyConfig();
  if (!cfg || !Array.isArray(cfg.hubs) || cfg.hubs.length === 0) return;

  for (const hub of cfg.hubs) {
    const name = String(hub.name || '').trim();
    const hubUrl = String(hub.url || '').trim().replace(/\/+$/, '');
    const viewerToken = String(hub.viewerToken || '').trim() || null;
    if (!name || !hubUrl) continue;
    await pool.query(
      `INSERT INTO hubs (name, url, viewer_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET url = EXCLUDED.url, viewer_token = EXCLUDED.viewer_token`,
      [name, hubUrl, viewerToken]
    );
  }

  console.log(`[awansaya] imported ${cfg.hubs.length} hub(s) from legacy config.json`);
}

async function listHubs() {
  const result = await pool.query(
    'SELECT name, url, viewer_token AS "viewerToken" FROM hubs ORDER BY name ASC'
  );
  return result.rows;
}

async function lookupHub(hubName) {
  const result = await pool.query(
    'SELECT name, url, viewer_token AS "viewerToken" FROM hubs WHERE name = $1',
    [hubName]
  );
  return result.rows[0] || null;
}

async function insertHub(name, hubUrl, viewerToken) {
  try {
    await pool.query(
      'INSERT INTO hubs (name, url, viewer_token) VALUES ($1, $2, $3)',
      [name, hubUrl, viewerToken || null]
    );
  } catch (err) {
    if (err.code === '23505') {
      const dupe = await pool.query('SELECT 1 FROM hubs WHERE name = $1 OR url = $2 LIMIT 1', [name, hubUrl]);
      if (dupe.rowCount > 0) {
        const conflict = new Error('hub with that name or URL already exists');
        conflict.statusCode = 409;
        throw conflict;
      }
    }
    throw err;
  }
}

async function deleteHubByName(name) {
  const result = await pool.query('DELETE FROM hubs WHERE name = $1', [name]);
  return result.rowCount;
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

// GET /api/auth-mode — tell the browser whether management is locked
function apiAuthMode(req, res) {
  jsonOK(res, { manageLocked: !!API_TOKEN });
}

// GET /api/hubs — return the hub list from PostgreSQL (tokens stripped)
// Always open: the response is read-only (viewer tokens are stripped).
async function apiGetHubs(req, res) {
  try {
    const hubs = (await listHubs()).map(h => ({ name: h.name, url: h.url }));
    jsonOK(res, { hubs });
  } catch (err) {
    jsonError(res, 500, 'database error');
  }
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

	insertHub(name, hubUrl, viewerToken)
		.then(async () => {
			const hubs = (await listHubs()).map(h => ({ name: h.name, url: h.url }));
			jsonOK(res, { hubs });
		})
		.catch(err2 => {
			jsonError(res, err2.statusCode || 500, err2.statusCode ? err2.message : 'database error');
		});
  });
}

// DELETE /api/hubs?name=<name> — remove a hub by name
async function apiDeleteHub(req, res) {
  if (!checkAuth(req, res)) return;
  const u = new URL(req.url, 'http://localhost');
  const name = (u.searchParams.get('name') || '').trim();
  if (!name) return jsonError(res, 400, 'name query parameter is required');

	try {
		const deleted = await deleteHubByName(name);
		if (!deleted) return jsonError(res, 404, 'hub not found');
		const hubs = (await listHubs()).map(h => ({ name: h.name, url: h.url }));
		jsonOK(res, { hubs });
	} catch (err) {
		jsonError(res, 500, 'database error');
	}
}

// ── Server-side hub status/history proxy ────────────────────────────

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
async function apiHubStatus(req, res, hubName) {
  try {
    const hub = await lookupHub(hubName);
    if (!hub) return jsonError(res, 404, 'hub not found');

    let targetUrl = hub.url + '/api/status';
    if (hub.viewerToken) targetUrl += '?token=' + encodeURIComponent(hub.viewerToken);

    const result = await proxyFetch(targetUrl);
    res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(result.body);
  } catch (err) {
    jsonError(res, 502, 'hub unreachable: ' + err.message);
  }
}

// GET /api/hub-history/<name> — proxy to hub's /api/history with viewer token
async function apiHubHistory(req, res, hubName) {
  try {
    const hub = await lookupHub(hubName);
    if (!hub) return jsonError(res, 404, 'hub not found');

    let targetUrl = hub.url + '/api/history';
    if (hub.viewerToken) targetUrl += '?token=' + encodeURIComponent(hub.viewerToken);

    const result = await proxyFetch(targetUrl);
    res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(result.body);
  } catch (err) {
    jsonError(res, 502, 'hub unreachable: ' + err.message);
  }
}

// ── Request router ─────────────────────────────────────────────────

async function serve(req, res) {
  const method  = req.method;
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // API routes
  if (urlPath === '/api/auth-mode') {
    if (method === 'GET' || method === 'HEAD') return apiAuthMode(req, res);
    res.writeHead(405); res.end(); return;
  }
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

async function main() {
  await connectWithRetry();
  await initDatabase();
  await importLegacyConfigIfNeeded();
  server.listen(PORT, () => {
    console.log(`[awansaya] listening on :${PORT}`);
  });
}

main().catch(err => {
  console.error(`[awansaya] startup failed: ${err.stack || err.message}`);
  process.exit(1);
});
