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
const crypto = require('crypto');
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
const SESSION_COOKIE_NAME = 'awansaya_session';
const SESSION_TTL_DAYS = parseInt(process.env.AWANSAYA_SESSION_TTL_DAYS || '30', 10);
const BOOTSTRAP_EMAIL = (process.env.AWANSAYA_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
const BOOTSTRAP_PASSWORD = process.env.AWANSAYA_BOOTSTRAP_PASSWORD || '';
const BOOTSTRAP_NAME = (process.env.AWANSAYA_BOOTSTRAP_NAME || 'Paul').trim();

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

function hasBearerAdmin(req) {
  if (!API_TOKEN) return false;
  const hdr = req.headers.authorization || '';
  return hdr === 'Bearer ' + API_TOKEN;
}

async function checkManageAuth(req, res) {
  if (hasBearerAdmin(req)) return true;
  const user = await getSessionUser(req, true);
  if (user && user.isAdmin) return true;
  jsonError(res, 401, 'unauthorized');
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
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hub_memberships (
      id BIGSERIAL PRIMARY KEY,
      hub_id BIGINT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (hub_id, user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_api_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_api_tokens_user_id ON user_api_tokens(user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_api_tokens_token_hash ON user_api_tokens(token_hash)
  `);

  await pool.query(`
    ALTER TABLE hubs
    ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_hubs_owner_user_id ON hubs(owner_user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_hub_memberships_user_id ON hub_memberships(user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_hub_memberships_hub_id ON hub_memberships(hub_id)
  `);

  await pool.query(`
    ALTER TABLE hub_memberships
    DROP CONSTRAINT IF EXISTS hub_memberships_role_check
  `);

  await pool.query(`
    ALTER TABLE hub_memberships
    ADD CONSTRAINT hub_memberships_role_check
    CHECK (role IN ('owner', 'admin', 'viewer'))
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
		DROP TRIGGER IF EXISTS users_set_updated_at ON users
	`);

  await pool.query(`
    CREATE TRIGGER hubs_set_updated_at
    BEFORE UPDATE ON hubs
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at()
  `);

  await pool.query(`
    CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at()
  `);

  // ── Hub invitations ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hub_invitations (
      id BIGSERIAL PRIMARY KEY,
      hub_id BIGINT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      invited_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    ALTER TABLE hub_invitations
    DROP CONSTRAINT IF EXISTS hub_invitations_role_check
  `);
  await pool.query(`
    ALTER TABLE hub_invitations
    ADD CONSTRAINT hub_invitations_role_check
    CHECK (role IN ('viewer', 'admin'))
  `);

  await pool.query(`
    ALTER TABLE hub_invitations
    DROP CONSTRAINT IF EXISTS hub_invitations_status_check
  `);
  await pool.query(`
    ALTER TABLE hub_invitations
    ADD CONSTRAINT hub_invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'revoked'))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_hub_invitations_email ON hub_invitations(email)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_hub_invitations_hub_id ON hub_invitations(hub_id)
  `);

  // ── Password reset codes ───────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user_id ON password_reset_codes(user_id)
  `);

  // Allow users table to have a sentinel password_hash for invited accounts
  await pool.query(`
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL
  `);
}

function hashPassword(password, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt:')) return false;
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', prev.concat(cookie));
    return;
  }
  res.setHeader('Set-Cookie', [prev, cookie]);
}

function isSecureRequest(req) {
  return !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function buildSessionCookie(req, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(req, res) {
  appendSetCookie(res, buildSessionCookie(req, '', 0));
}

async function countUsers() {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  return result.rows[0].count;
}

async function countAdmins() {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE is_admin = TRUE');
  return result.rows[0].count;
}

async function ensureBootstrapAdmin() {
  const userCount = await countUsers();
  if (userCount > 0) return;
  if (!BOOTSTRAP_EMAIL || !BOOTSTRAP_PASSWORD) {
    console.warn('[awansaya] no users configured; set AWANSAYA_BOOTSTRAP_EMAIL and AWANSAYA_BOOTSTRAP_PASSWORD to create the first admin');
    return;
  }
  await pool.query(
    'INSERT INTO users (email, display_name, password_hash, is_admin) VALUES ($1, $2, $3, TRUE)',
    [BOOTSTRAP_EMAIL, BOOTSTRAP_NAME || BOOTSTRAP_EMAIL, hashPassword(BOOTSTRAP_PASSWORD)]
  );
  console.log(`[awansaya] bootstrapped admin user: ${BOOTSTRAP_EMAIL}`);
}

async function findUserByEmail(email) {
  const result = await pool.query(
    'SELECT id, email, display_name AS "displayName", password_hash AS "passwordHash", is_admin AS "isAdmin" FROM users WHERE email = $1',
    [email.trim().toLowerCase()]
  );
  return result.rows[0] || null;
}

async function findFirstAdminUser() {
  const result = await pool.query(
    'SELECT id, email, display_name AS "displayName", is_admin AS "isAdmin" FROM users WHERE is_admin = TRUE ORDER BY id ASC LIMIT 1'
  );
  return result.rows[0] || null;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const maxAgeSeconds = SESSION_TTL_DAYS * 24 * 60 * 60;
  await pool.query(
    'INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + ($3 * INTERVAL \'1 second\'))',
    [userId, tokenHash, maxAgeSeconds]
  );
  return { token, maxAgeSeconds };
}

async function getSessionUser(req, touch) {
  // 1. Try session cookie first (browser auth)
  const cookies = parseCookies(req);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (rawToken) {
    const tokenHash = sha256(rawToken);
    const result = await pool.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.is_admin AS "isAdmin", s.id AS "sessionId"
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()` ,
      [tokenHash]
    );
    const row = result.rows[0] || null;
    if (row && touch) {
      await pool.query('UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1', [row.sessionId]);
    }
    if (row) return row;
  }

  // 2. Try Bearer token (CLI / personal API token)
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7);
    const bearerHash = sha256(bearer);
    const result = await pool.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.is_admin AS "isAdmin", t.id AS "apiTokenId"
       FROM user_api_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1`,
      [bearerHash]
    );
    const row = result.rows[0] || null;
    if (row && touch) {
      await pool.query('UPDATE user_api_tokens SET last_used_at = NOW() WHERE id = $1', [row.apiTokenId]);
    }
    if (row) return row;
  }

  return null;
}

async function revokeSession(req) {
  const cookies = parseCookies(req);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken) return;
  await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [sha256(rawToken)]);
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

async function backfillHubOwnership() {
  const adminCount = await countAdmins();
  if (adminCount !== 1) return;
  const admin = await findFirstAdminUser();
  if (!admin) return;

  const result = await pool.query(
    `UPDATE hubs
     SET owner_user_id = $1
     WHERE owner_user_id IS NULL`,
    [admin.id]
  );

  if (result.rowCount > 0) {
    console.log(`[awansaya] assigned ${result.rowCount} existing hub(s) to bootstrap admin ${admin.email}`);
  }

  await pool.query(
    `INSERT INTO hub_memberships (hub_id, user_id, role)
     SELECT h.id, $1, 'owner'
     FROM hubs h
     WHERE h.owner_user_id = $1
     ON CONFLICT (hub_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [admin.id]
  );
}

function canManageRole(role) {
  return role === 'owner' || role === 'admin';
}

function isMembershipRole(role) {
  return role === 'admin' || role === 'viewer';
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function listHubsForUser(user) {
  if (!user) return [];
  if (user.isAdmin) {
    const result = await pool.query(
      `SELECT h.id, h.name, h.url, h.viewer_token AS "viewerToken", TRUE AS "canManage"
       FROM hubs h
       ORDER BY h.name ASC`
    );
    return result.rows;
  }

  const result = await pool.query(
    `SELECT h.id,
            h.name,
            h.url,
            h.viewer_token AS "viewerToken",
            CASE
              WHEN h.owner_user_id = $1 THEN TRUE
              WHEN hm.role IN ('owner', 'admin') THEN TRUE
              ELSE FALSE
            END AS "canManage"
     FROM hubs h
     LEFT JOIN hub_memberships hm ON hm.hub_id = h.id AND hm.user_id = $1
     WHERE h.owner_user_id = $1 OR hm.user_id IS NOT NULL
     ORDER BY h.name ASC`,
    [user.id]
  );
  return result.rows;
}

async function lookupHubForUser(user, hubName) {
  if (!user) return null;
  if (user.isAdmin) {
    const result = await pool.query(
      `SELECT h.id, h.name, h.url, h.viewer_token AS "viewerToken", TRUE AS "canManage"
       FROM hubs h
       WHERE h.name = $1`,
      [hubName]
    );
    return result.rows[0] || null;
  }

  const result = await pool.query(
    `SELECT h.id,
            h.name,
            h.url,
            h.viewer_token AS "viewerToken",
            CASE
              WHEN h.owner_user_id = $1 THEN TRUE
              WHEN hm.role IN ('owner', 'admin') THEN TRUE
              ELSE FALSE
            END AS "canManage"
     FROM hubs h
     LEFT JOIN hub_memberships hm ON hm.hub_id = h.id AND hm.user_id = $1
     WHERE h.name = $2 AND (h.owner_user_id = $1 OR hm.user_id IS NOT NULL)`,
    [user.id, hubName]
  );
  return result.rows[0] || null;
}

async function listHubs() {
  const result = await pool.query(
    'SELECT name, url, viewer_token AS "viewerToken" FROM hubs ORDER BY name ASC'
  );
  return result.rows;
}

async function listUsersForAdmin() {
  const result = await pool.query(
    `SELECT id,
            email,
            display_name AS "displayName",
            is_admin AS "isAdmin",
            created_at AS "createdAt"
     FROM users
     ORDER BY is_admin DESC, email ASC`
  );
  return result.rows;
}

async function listHubsForAdminOverview() {
  const result = await pool.query(
    `SELECT h.id,
            h.name,
            h.url,
            h.owner_user_id AS "ownerUserId",
            u.display_name AS "ownerDisplayName",
            u.email AS "ownerEmail"
     FROM hubs h
     LEFT JOIN users u ON u.id = h.owner_user_id
     ORDER BY h.name ASC`
  );
  return result.rows;
}

async function listHubMembershipsForAdmin() {
  const result = await pool.query(
    `SELECT hm.user_id AS "userId",
            hm.hub_id AS "hubId",
            hm.role,
            hm.created_at AS "createdAt",
            h.name AS "hubName",
            u.email,
            u.display_name AS "displayName"
     FROM hub_memberships hm
     JOIN hubs h ON h.id = hm.hub_id
     JOIN users u ON u.id = hm.user_id
     ORDER BY u.email ASC, h.name ASC`
  );
  return result.rows;
}

async function getAdminAccessOverview() {
  const [users, hubs, memberships] = await Promise.all([
    listUsersForAdmin(),
    listHubsForAdminOverview(),
    listHubMembershipsForAdmin(),
  ]);
  return { users, hubs, memberships };
}

async function lookupHub(hubName) {
  const result = await pool.query(
    'SELECT name, url, viewer_token AS "viewerToken" FROM hubs WHERE name = $1',
    [hubName]
  );
  return result.rows[0] || null;
}

async function insertHub(name, hubUrl, viewerToken, ownerUserId) {
  try {
    await pool.query(
      'INSERT INTO hubs (name, url, viewer_token, owner_user_id) VALUES ($1, $2, $3, $4)',
      [name, hubUrl, viewerToken || null, ownerUserId || null]
    );

    if (ownerUserId) {
      await pool.query(
        `INSERT INTO hub_memberships (hub_id, user_id, role)
         SELECT id, $2, 'owner' FROM hubs WHERE name = $1
         ON CONFLICT (hub_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [name, ownerUserId]
      );
    }
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

async function createUserAccount(email, displayName, password, isAdmin) {
  try {
    const pwHash = password ? hashPassword(password) : null;
    const result = await pool.query(
      `INSERT INTO users (email, display_name, password_hash, is_admin)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, display_name AS "displayName", is_admin AS "isAdmin"`,
      [email, displayName, pwHash, !!isAdmin]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const conflict = new Error('user with that email already exists');
      conflict.statusCode = 409;
      throw conflict;
    }
    throw err;
  }
}

// ── Hub Invitations ──────────────────────────────────────────────

async function createHubInvitation(hubId, email, role, invitedBy) {
  // Check for existing pending invitation
  const existing = await pool.query(
    "SELECT id FROM hub_invitations WHERE hub_id = $1 AND email = $2 AND status = 'pending'",
    [hubId, email]
  );
  if (existing.rowCount > 0) {
    const conflict = new Error('pending invitation already exists for this email and hub');
    conflict.statusCode = 409;
    throw conflict;
  }
  const result = await pool.query(
    `INSERT INTO hub_invitations (hub_id, invited_by, email, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, hub_id AS "hubId", email, role, status, created_at AS "createdAt"`,
    [hubId, invitedBy, email, role]
  );
  return result.rows[0];
}

async function listHubInvitations(hubId) {
  const result = await pool.query(
    `SELECT hi.id, hi.email, hi.role, hi.status,
            hi.created_at AS "createdAt", hi.resolved_at AS "resolvedAt",
            u.display_name AS "invitedByName"
     FROM hub_invitations hi
     JOIN users u ON u.id = hi.invited_by
     WHERE hi.hub_id = $1
     ORDER BY hi.created_at DESC`,
    [hubId]
  );
  return result.rows;
}

async function listPendingInvitationsForUser(userId) {
  const result = await pool.query(
    `SELECT hi.id, hi.role, hi.status,
            hi.created_at AS "createdAt",
            h.name AS "hubName",
            u.display_name AS "invitedByName"
     FROM hub_invitations hi
     JOIN hubs h ON h.id = hi.hub_id
     JOIN users u ON u.id = hi.invited_by
     JOIN users target ON target.email = hi.email
     WHERE target.id = $1 AND hi.status = 'pending'
     ORDER BY hi.created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function listPendingInvitationsForEmail(email) {
  const result = await pool.query(
    `SELECT hi.id, hi.role, hi.hub_id AS "hubId",
            h.name AS "hubName"
     FROM hub_invitations hi
     JOIN hubs h ON h.id = hi.hub_id
     WHERE hi.email = $1 AND hi.status = 'pending'`,
    [email]
  );
  return result.rows;
}

async function acceptInvitation(invitationId, userId) {
  const inv = await pool.query(
    `SELECT hi.id, hi.hub_id, hi.email, hi.role, hi.status
     FROM hub_invitations hi
     JOIN users u ON u.email = hi.email
     WHERE hi.id = $1 AND u.id = $2`,
    [invitationId, userId]
  );
  if (inv.rowCount === 0) {
    const notFound = new Error('invitation not found');
    notFound.statusCode = 404;
    throw notFound;
  }
  const row = inv.rows[0];
  if (row.status !== 'pending') {
    const conflict = new Error('invitation is no longer pending');
    conflict.statusCode = 409;
    throw conflict;
  }
  // Create hub membership
  await pool.query(
    `INSERT INTO hub_memberships (hub_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (hub_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [row.hub_id, userId, row.role]
  );
  // Mark accepted
  await pool.query(
    "UPDATE hub_invitations SET status = 'accepted', resolved_at = NOW() WHERE id = $1",
    [invitationId]
  );
}

async function declineInvitation(invitationId, userId) {
  const inv = await pool.query(
    `SELECT hi.id, hi.status
     FROM hub_invitations hi
     JOIN users u ON u.email = hi.email
     WHERE hi.id = $1 AND u.id = $2`,
    [invitationId, userId]
  );
  if (inv.rowCount === 0) {
    const notFound = new Error('invitation not found');
    notFound.statusCode = 404;
    throw notFound;
  }
  if (inv.rows[0].status !== 'pending') {
    const conflict = new Error('invitation is no longer pending');
    conflict.statusCode = 409;
    throw conflict;
  }
  await pool.query(
    "UPDATE hub_invitations SET status = 'declined', resolved_at = NOW() WHERE id = $1",
    [invitationId]
  );
}

async function revokeHubInvitation(invitationId, hubId) {
  const result = await pool.query(
    "UPDATE hub_invitations SET status = 'revoked', resolved_at = NOW() WHERE id = $1 AND hub_id = $2 AND status = 'pending'",
    [invitationId, hubId]
  );
  if (result.rowCount === 0) {
    const notFound = new Error('pending invitation not found');
    notFound.statusCode = 404;
    throw notFound;
  }
}

// ── Password reset codes ─────────────────────────────────────────

function generateResetCode() {
  // 6-digit numeric code
  const num = crypto.randomInt(100000, 999999);
  return String(num);
}

async function createPasswordResetCode(userId) {
  // Invalidate any previous unused codes
  await pool.query(
    "DELETE FROM password_reset_codes WHERE user_id = $1 AND used_at IS NULL",
    [userId]
  );
  const rawCode = generateResetCode();
  const codeHash = sha256(rawCode);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  await pool.query(
    'INSERT INTO password_reset_codes (user_id, code_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, codeHash, expiresAt]
  );
  return rawCode;
}

async function verifyAndConsumeResetCode(email, code) {
  const codeHash = sha256(code);
  const result = await pool.query(
    `SELECT prc.id, prc.user_id
     FROM password_reset_codes prc
     JOIN users u ON u.id = prc.user_id
     WHERE u.email = $1
       AND prc.code_hash = $2
       AND prc.used_at IS NULL
       AND prc.expires_at > NOW()
     ORDER BY prc.created_at DESC
     LIMIT 1`,
    [email, codeHash]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  // Mark consumed
  await pool.query(
    'UPDATE password_reset_codes SET used_at = NOW() WHERE id = $1',
    [row.id]
  );
  return { userId: row.user_id };
}

// ── Hub members for hub owner/admin view ─────────────────────────

async function listHubMembers(hubId) {
  const result = await pool.query(
    `SELECT u.id AS "userId", u.email, u.display_name AS "displayName",
            hm.role, hm.created_at AS "memberSince"
     FROM hub_memberships hm
     JOIN users u ON u.id = hm.user_id
     WHERE hm.hub_id = $1
     ORDER BY hm.role ASC, u.email ASC`,
    [hubId]
  );
  return result.rows;
}

async function upsertHubMembershipByName(userId, hubName, role) {
  const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
  if (userResult.rowCount === 0) {
    const notFound = new Error('user not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  const hubResult = await pool.query('SELECT id, owner_user_id AS "ownerUserId" FROM hubs WHERE name = $1', [hubName]);
  if (hubResult.rowCount === 0) {
    const notFound = new Error('hub not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  const hub = hubResult.rows[0];
  if (hub.ownerUserId && Number(hub.ownerUserId) === Number(userId)) {
    const conflict = new Error('hub owner already has full access');
    conflict.statusCode = 409;
    throw conflict;
  }

  await pool.query(
    `INSERT INTO hub_memberships (hub_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (hub_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [hub.id, userId, role]
  );
}

async function revokeHubMembershipByName(userId, hubName) {
  const hubResult = await pool.query('SELECT id, owner_user_id AS "ownerUserId" FROM hubs WHERE name = $1', [hubName]);
  if (hubResult.rowCount === 0) {
    const notFound = new Error('hub not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  const hub = hubResult.rows[0];
  if (hub.ownerUserId && Number(hub.ownerUserId) === Number(userId)) {
    const conflict = new Error('cannot revoke the hub owner');
    conflict.statusCode = 409;
    throw conflict;
  }

  const result = await pool.query(
    'DELETE FROM hub_memberships WHERE hub_id = $1 AND user_id = $2',
    [hub.id, userId]
  );

  if (result.rowCount === 0) {
    const notFound = new Error('membership not found');
    notFound.statusCode = 404;
    throw notFound;
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

function redirectToSignIn(req, res) {
  const next = encodeURIComponent(req.url || '/portal/');
  res.writeHead(302, { Location: `/sign-in/?next=${next}` });
  res.end();
}

async function requireAuthenticated(req, res, options) {
  const user = await getSessionUser(req, true);
  if (user) return user;
  if (options && options.redirect) {
    redirectToSignIn(req, res);
  } else {
    jsonError(res, 401, 'authentication required');
  }
  return null;
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
async function apiAuthMode(req, res) {
  try {
    const user = await getSessionUser(req, true);
    const userCount = await countUsers();
    const visibleHubs = user ? await listHubsForUser(user) : [];
    jsonOK(res, {
      manageLocked: !!API_TOKEN || userCount > 0,
      authEnabled: userCount > 0,
      bootstrapRequired: userCount === 0,
      authenticated: !!user,
      canManageHubs: hasBearerAdmin(req) || !!(user && user.isAdmin),
      visibleHubCount: visibleHubs.length,
      user: user ? {
        email: user.email,
        displayName: user.displayName,
        isAdmin: !!user.isAdmin,
      } : null,
    });
  } catch (err) {
    jsonError(res, 500, 'database error');
  }
}

async function apiLogin(req, res) {
  readBody(req, async (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return jsonError(res, 400, 'email and password are required');

    try {
      const user = await findUserByEmail(email);
      if (!user) return jsonError(res, 401, 'invalid credentials');
      if (!user.passwordHash) {
        return jsonError(res, 403, 'your account has not been activated yet — use the setup code at /reset-password/ to set your password');
      }
      if (!verifyPassword(password, user.passwordHash)) {
        return jsonError(res, 401, 'invalid credentials');
      }
      const session = await createSession(user.id);
      appendSetCookie(res, buildSessionCookie(req, session.token, session.maxAgeSeconds));
      jsonOK(res, {
        authenticated: true,
        canManageHubs: !!user.isAdmin,
        user: {
          email: user.email,
          displayName: user.displayName,
          isAdmin: !!user.isAdmin,
        },
      });
    } catch (dbErr) {
      jsonError(res, 500, 'database error');
    }
  });
}

async function apiLogout(req, res) {
  try {
    await revokeSession(req);
    clearSessionCookie(req, res);
    jsonOK(res, { authenticated: false });
  } catch (err) {
    jsonError(res, 500, 'database error');
  }
}

async function apiAdminGetAccess(req, res) {
  if (!await checkManageAuth(req, res)) return;
  try {
    jsonOK(res, await getAdminAccessOverview());
  } catch (err) {
    jsonError(res, 500, 'database error');
  }
}

async function apiAdminListUsers(req, res) {
  if (!await checkManageAuth(req, res)) return;
  try {
    const users = await listUsersForAdmin();
    jsonOK(res, { users });
  } catch (err) {
    jsonError(res, 500, 'database error');
  }
}

function apiAdminCreateUser(req, res) {
  checkManageAuth(req, res).then(allowed => {
    if (!allowed) return;
    readBody(req, async (err, body) => {
      if (err || !body) return jsonError(res, 400, 'invalid JSON body');

      const email = normalizeEmail(body.email);
      const displayName = String(body.displayName || '').trim();
      const isAdmin = !!body.isAdmin;

      if (!email || !displayName) return jsonError(res, 400, 'displayName and email are required');
      if (!isValidEmail(email)) return jsonError(res, 400, 'valid email is required');

      try {
        // Create stub account (no password)
        const newUser = await createUserAccount(email, displayName, null, isAdmin);
        // Generate a reset code so the user can set their password
        const code = await createPasswordResetCode(newUser.id);
        const overview = await getAdminAccessOverview();
        jsonOK(res, {
          ...overview,
          setupCode: code,
          setupEmail: email,
          message: 'Account created. Share the setup code with the user — they\'ll use it at /reset-password/ to set their password. Code expires in 15 minutes.'
        });
      } catch (dbErr) {
        jsonError(res, dbErr.statusCode || 500, dbErr.statusCode ? dbErr.message : 'database error');
      }
    });
  });
}

async function apiAdminUpdateUser(req, res) {
  if (!await checkManageAuth(req, res)) return;
  readBody(req, async (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const userId = Number(body.id);
    if (!Number.isInteger(userId) || userId <= 0) return jsonError(res, 400, 'valid id is required');

    try {
      const sessionUser = await getSessionUser(req, true);
      const updates = [];
      const params = [];
      let paramIdx = 1;

      if (body.displayName !== undefined) {
        const displayName = String(body.displayName).trim();
        if (!displayName) return jsonError(res, 400, 'displayName cannot be empty');
        updates.push('display_name = $' + paramIdx++);
        params.push(displayName);
      }

      if (body.isAdmin !== undefined) {
        if (sessionUser && Number(sessionUser.id) === userId && !body.isAdmin) {
          return jsonError(res, 400, 'cannot remove your own admin access');
        }
        updates.push('is_admin = $' + paramIdx++);
        params.push(!!body.isAdmin);
      }

      // Password changes are handled via reset codes — admins cannot set passwords directly

      if (updates.length === 0) return jsonError(res, 400, 'no fields to update');

      params.push(userId);
      const result = await pool.query(
        'UPDATE users SET ' + updates.join(', ') + ' WHERE id = $' + paramIdx,
        params
      );

      if (result.rowCount === 0) return jsonError(res, 404, 'user not found');
      jsonOK(res, { users: await listUsersForAdmin() });
    } catch (err2) {
      jsonError(res, 500, 'database error');
    }
  });
}

async function apiAdminDeleteUser(req, res) {
  if (!await checkManageAuth(req, res)) return;
  const u = new URL(req.url, 'http://localhost');
  const userId = Number(u.searchParams.get('id'));
  if (!Number.isInteger(userId) || userId <= 0) return jsonError(res, 400, 'valid id is required');

  try {
    const sessionUser = await getSessionUser(req, true);
    if (sessionUser && Number(sessionUser.id) === userId) {
      return jsonError(res, 400, 'cannot delete your own account');
    }

    const result = await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    if (result.rowCount === 0) return jsonError(res, 404, 'user not found');
    jsonOK(res, { users: await listUsersForAdmin() });
  } catch (err) {
    jsonError(res, 500, 'database error');
  }
}

function apiAdminUpsertMembership(req, res) {
  checkManageAuth(req, res).then(allowed => {
    if (!allowed) return;
    readBody(req, (err, body) => {
      if (err || !body) return jsonError(res, 400, 'invalid JSON body');

      const userId = Number(body.userId);
      const hubName = String(body.hubName || '').trim();
      const role = String(body.role || '').trim().toLowerCase();

      if (!Number.isInteger(userId) || userId <= 0) return jsonError(res, 400, 'valid userId is required');
      if (!hubName) return jsonError(res, 400, 'hubName is required');
      if (!isMembershipRole(role)) return jsonError(res, 400, 'role must be admin or viewer');

      upsertHubMembershipByName(userId, hubName, role)
        .then(async () => {
          jsonOK(res, await getAdminAccessOverview());
        })
        .catch(dbErr => {
          jsonError(res, dbErr.statusCode || 500, dbErr.statusCode ? dbErr.message : 'database error');
        });
    });
  });
}

async function apiAdminDeleteMembership(req, res) {
  if (!await checkManageAuth(req, res)) return;
  const u = new URL(req.url, 'http://localhost');
  const userId = Number(u.searchParams.get('userId'));
  const hubName = String(u.searchParams.get('hubName') || '').trim();

  if (!Number.isInteger(userId) || userId <= 0) return jsonError(res, 400, 'valid userId is required');
  if (!hubName) return jsonError(res, 400, 'hubName is required');

  try {
    await revokeHubMembershipByName(userId, hubName);
    jsonOK(res, await getAdminAccessOverview());
  } catch (err) {
    jsonError(res, err.statusCode || 500, err.statusCode ? err.message : 'database error');
  }
}

// ── Hub invitation API ─────────────────────────────────────────────

// POST /api/hubs/:name/invitations — invite a user to a hub
async function apiCreateHubInvitation(req, res, hubName) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;

  // User must be hub owner or hub admin (or portal admin)
  const hub = await lookupHubForUser(user, hubName);
  if (!hub) return jsonError(res, 404, 'hub not found');
  if (!hub.canManage) return jsonError(res, 403, 'you do not have admin access to this hub');

  readBody(req, async (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const email = normalizeEmail(body.email);
    const role = String(body.role || 'viewer').trim().toLowerCase();
    if (!email) return jsonError(res, 400, 'email is required');
    if (!isValidEmail(email)) return jsonError(res, 400, 'valid email is required');
    if (role !== 'viewer' && role !== 'admin') return jsonError(res, 400, 'role must be viewer or admin');

    // Don't allow inviting yourself
    if (email === user.email) return jsonError(res, 400, 'cannot invite yourself');

    try {
      const invitation = await createHubInvitation(hub.id, email, role, user.id);
      // Check if the target user already exists
      const targetUser = await findUserByEmail(email);
      jsonOK(res, {
        invitation,
        userExists: !!targetUser,
        message: targetUser
          ? 'Invitation created. The user will see it on their dashboard.'
          : 'No account for this email. Ask them to sign up at /sign-up/ with this email address.'
      });
    } catch (dbErr) {
      jsonError(res, dbErr.statusCode || 500, dbErr.statusCode ? dbErr.message : 'database error');
    }
  });
}

// GET /api/hubs/:name/invitations — list invitations for a hub
async function apiListHubInvitations(req, res, hubName) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;
  const hub = await lookupHubForUser(user, hubName);
  if (!hub) return jsonError(res, 404, 'hub not found');
  if (!hub.canManage) return jsonError(res, 403, 'you do not have admin access to this hub');

  try {
    const [members, invitations] = await Promise.all([
      listHubMembers(hub.id),
      listHubInvitations(hub.id),
    ]);
    jsonOK(res, { members, invitations });
  } catch (err2) {
    jsonError(res, 500, 'database error');
  }
}

// DELETE /api/hubs/:name/invitations?id=<id> — revoke a pending invitation
async function apiRevokeHubInvitation(req, res, hubName) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;
  const hub = await lookupHubForUser(user, hubName);
  if (!hub) return jsonError(res, 404, 'hub not found');
  if (!hub.canManage) return jsonError(res, 403, 'you do not have admin access to this hub');

  const u = new URL(req.url, 'http://localhost');
  const invId = Number(u.searchParams.get('id'));
  if (!Number.isInteger(invId) || invId <= 0) return jsonError(res, 400, 'valid id is required');

  try {
    await revokeHubInvitation(invId, hub.id);
    jsonOK(res, { invitations: await listHubInvitations(hub.id) });
  } catch (err2) {
    jsonError(res, err2.statusCode || 500, err2.statusCode ? err2.message : 'database error');
  }
}

// GET /api/hubs/:name/members — list members for a hub
async function apiListHubMembers(req, res, hubName) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;
  const hub = await lookupHubForUser(user, hubName);
  if (!hub) return jsonError(res, 404, 'hub not found');
  if (!hub.canManage) return jsonError(res, 403, 'you do not have admin access to this hub');

  try {
    jsonOK(res, { members: await listHubMembers(hub.id) });
  } catch (err2) {
    jsonError(res, 500, 'database error');
  }
}

// DELETE /api/hubs/:name/members?userId=<id> — remove a member from a hub
async function apiRemoveHubMember(req, res, hubName) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;
  const hub = await lookupHubForUser(user, hubName);
  if (!hub) return jsonError(res, 404, 'hub not found');
  if (!hub.canManage) return jsonError(res, 403, 'you do not have admin access to this hub');

  const u = new URL(req.url, 'http://localhost');
  const targetUserId = Number(u.searchParams.get('userId'));
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) return jsonError(res, 400, 'valid userId is required');

  try {
    await pool.query(
      'DELETE FROM hub_memberships WHERE hub_id = $1 AND user_id = $2 AND role != $3',
      [hub.id, targetUserId, 'owner']
    );
    jsonOK(res, { members: await listHubMembers(hub.id) });
  } catch (err2) {
    jsonError(res, 500, 'database error');
  }
}

// ── My invitations ─────────────────────────────────────────────────

// GET /api/my/invitations — list my pending hub invitations
async function apiMyInvitations(req, res) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;
  try {
    jsonOK(res, { invitations: await listPendingInvitationsForUser(user.id) });
  } catch (err2) {
    jsonError(res, 500, 'database error');
  }
}

// POST /api/my/invitations/:id/accept
async function apiAcceptInvitation(req, res, invId) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;
  try {
    await acceptInvitation(invId, user.id);
    jsonOK(res, { invitations: await listPendingInvitationsForUser(user.id) });
  } catch (err2) {
    jsonError(res, err2.statusCode || 500, err2.statusCode ? err2.message : 'database error');
  }
}

// POST /api/my/invitations/:id/decline
async function apiDeclineInvitation(req, res, invId) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;
  try {
    await declineInvitation(invId, user.id);
    jsonOK(res, { invitations: await listPendingInvitationsForUser(user.id) });
  } catch (err2) {
    jsonError(res, err2.statusCode || 500, err2.statusCode ? err2.message : 'database error');
  }
}

// ── Sign-up (invitation-bound) ─────────────────────────────────────

// POST /api/sign-up — create account (email must match a pending invitation OR admin-created stub)
async function apiSignUp(req, res) {
  readBody(req, async (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const email = normalizeEmail(body.email);
    const displayName = String(body.displayName || '').trim();
    const password = String(body.password || '');

    if (!email || !isValidEmail(email)) return jsonError(res, 400, 'valid email is required');
    if (!displayName) return jsonError(res, 400, 'display name is required');
    if (password.length < 8) return jsonError(res, 400, 'password must be at least 8 characters');

    try {
      // Check if account already exists
      const existingUser = await findUserByEmail(email);
      if (existingUser) {
        // If account exists but has no password (admin-created stub), let them set their password
        if (existingUser.passwordHash) {
          return jsonError(res, 409, 'an account with this email already exists — please sign in');
        }
        // Activate the stub account
        await pool.query(
          'UPDATE users SET password_hash = $1, display_name = $2 WHERE id = $3',
          [hashPassword(password), displayName, existingUser.id]
        );
        // Sign them in
        const session = await createSession(existingUser.id);
        appendSetCookie(res, buildSessionCookie(req, session.token, session.maxAgeSeconds));
        return jsonOK(res, { authenticated: true, message: 'Account activated. Welcome!' });
      }

      // No account — check for pending hub invitations
      const pendingInvitations = await listPendingInvitationsForEmail(email);
      if (pendingInvitations.length === 0) {
        return jsonError(res, 403, 'no pending invitation found for this email address');
      }

      // Create the account
      const newUser = await createUserAccount(email, displayName, password, false);
      // Sign them in
      const session = await createSession(newUser.id);
      appendSetCookie(res, buildSessionCookie(req, session.token, session.maxAgeSeconds));
      jsonOK(res, { authenticated: true, message: 'Account created. Welcome!' });
    } catch (dbErr) {
      jsonError(res, dbErr.statusCode || 500, dbErr.statusCode ? dbErr.message : 'database error');
    }
  });
}

// ── Password management ────────────────────────────────────────────

// PATCH /api/me/password — change own password (requires current password)
async function apiChangePassword(req, res) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;

  readBody(req, async (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');

    if (!currentPassword) return jsonError(res, 400, 'current password is required');
    if (newPassword.length < 8) return jsonError(res, 400, 'new password must be at least 8 characters');

    try {
      const fullUser = await findUserByEmail(user.email);
      if (!fullUser || !verifyPassword(currentPassword, fullUser.passwordHash)) {
        return jsonError(res, 401, 'current password is incorrect');
      }
      await pool.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [hashPassword(newPassword), user.id]
      );
      jsonOK(res, { message: 'Password changed successfully.' });
    } catch (err2) {
      jsonError(res, 500, 'database error');
    }
  });
}

// POST /api/forgot-password — request a reset code (shown on screen in Phase 1)
async function apiForgotPassword(req, res) {
  readBody(req, async (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const email = normalizeEmail(body.email);
    if (!email || !isValidEmail(email)) return jsonError(res, 400, 'valid email is required');

    try {
      const user = await findUserByEmail(email);
      if (!user) {
        // Don't reveal whether email exists — just say "if an account exists, a code has been generated"
        return jsonOK(res, { message: 'If an account exists for this email, a reset code has been generated.', code: null });
      }
      const code = await createPasswordResetCode(user.id);
      // Phase 1: return the code directly (no SMTP)
      // Phase 2: email the code and don't return it
      jsonOK(res, { message: 'Reset code generated. It expires in 15 minutes.', code });
    } catch (err2) {
      jsonError(res, 500, 'database error');
    }
  });
}

// POST /api/reset-password — set new password using a reset code
async function apiResetPassword(req, res) {
  readBody(req, async (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const email = normalizeEmail(body.email);
    const code = String(body.code || '').trim();
    const newPassword = String(body.newPassword || '');

    if (!email || !isValidEmail(email)) return jsonError(res, 400, 'valid email is required');
    if (!code) return jsonError(res, 400, 'reset code is required');
    if (newPassword.length < 8) return jsonError(res, 400, 'new password must be at least 8 characters');

    try {
      const result = await verifyAndConsumeResetCode(email, code);
      if (!result) return jsonError(res, 401, 'invalid or expired reset code');

      await pool.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [hashPassword(newPassword), result.userId]
      );
      jsonOK(res, { message: 'Password has been reset. You can now sign in.' });
    } catch (err2) {
      jsonError(res, 500, 'database error');
    }
  });
}

// POST /api/admin/reset-password — admin generates a reset code for a user
async function apiAdminResetPassword(req, res) {
  if (!await checkManageAuth(req, res)) return;
  readBody(req, async (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) return jsonError(res, 400, 'valid userId is required');

    try {
      const user = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
      if (user.rowCount === 0) return jsonError(res, 404, 'user not found');
      const code = await createPasswordResetCode(userId);
      // Phase 1: return code to admin. Phase 2: email it.
      jsonOK(res, {
        code,
        email: user.rows[0].email,
        message: 'Reset code generated. Share it with the user — it expires in 15 minutes.'
      });
    } catch (err2) {
      jsonError(res, 500, 'database error');
    }
  });
}

// ── Personal API Tokens ────────────────────────────────────────────

// GET /api/tokens — list the authenticated user's API tokens (no secrets)
async function apiListTokens(req, res) {
  try {
    const user = await requireAuthenticated(req, res);
    if (!user) return;
    const result = await pool.query(
      `SELECT id, name, token_prefix AS "tokenPrefix", created_at AS "createdAt", last_used_at AS "lastUsedAt"
       FROM user_api_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    );
    jsonOK(res, { tokens: result.rows });
  } catch (err) {
    jsonError(res, 500, 'database error');
  }
}

// POST /api/tokens — generate a new personal API token { name }
// Returns the raw token exactly once.
async function apiCreateToken(req, res) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;
  readBody(req, async (err, body) => {
    if (err || !body) return jsonError(res, 400, 'invalid JSON body');
    const name = String(body.name || '').trim();
    if (!name) return jsonError(res, 400, 'name is required');
    if (name.length > 128) return jsonError(res, 400, 'name must be 128 characters or fewer');

    try {
      // Count existing tokens to enforce a reasonable limit
      const countResult = await pool.query(
        'SELECT COUNT(*)::int AS count FROM user_api_tokens WHERE user_id = $1',
        [user.id]
      );
      if (countResult.rows[0].count >= 25) {
        return jsonError(res, 400, 'token limit reached (25); revoke an existing token first');
      }

      const rawToken = 'tela_' + crypto.randomBytes(32).toString('hex');
      const tokenHash = sha256(rawToken);
      const tokenPrefix = rawToken.slice(0, 12);

      await pool.query(
        'INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix) VALUES ($1, $2, $3, $4)',
        [user.id, name, tokenHash, tokenPrefix]
      );

      // Return the raw token exactly once
      jsonOK(res, { token: rawToken, tokenPrefix, name });
    } catch (err2) {
      jsonError(res, 500, 'database error');
    }
  });
}

// DELETE /api/tokens?id=<id> — revoke a personal API token
async function apiDeleteToken(req, res) {
  const user = await requireAuthenticated(req, res);
  if (!user) return;
  const u = new URL(req.url, 'http://localhost');
  const tokenId = Number(u.searchParams.get('id'));
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return jsonError(res, 400, 'valid id is required');
  }

  try {
    const result = await pool.query(
      'DELETE FROM user_api_tokens WHERE id = $1 AND user_id = $2',
      [tokenId, user.id]
    );
    if (result.rowCount === 0) return jsonError(res, 404, 'token not found');
    // Return updated token list
    const listResult = await pool.query(
      `SELECT id, name, token_prefix AS "tokenPrefix", created_at AS "createdAt", last_used_at AS "lastUsedAt"
       FROM user_api_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    );
    jsonOK(res, { tokens: listResult.rows });
  } catch (err) {
    jsonError(res, 500, 'database error');
  }
}

// GET /api/hubs — return the visible hub list for the authenticated user.
async function apiGetHubs(req, res) {
  try {
    const user = await requireAuthenticated(req, res);
    if (!user) return;
    const hubs = (await listHubsForUser(user)).map(h => ({ name: h.name, url: h.url, canManage: !!h.canManage }));
    jsonOK(res, { hubs });
  } catch (err) {
    jsonError(res, 500, 'database error');
  }
}

// POST /api/hubs — add a hub { name, url, viewerToken }
function apiAddHub(req, res) {
  checkManageAuth(req, res).then(allowed => {
    if (!allowed) return;
    getSessionUser(req, true).then(sessionUser => {
      readBody(req, (err, body) => {
        if (err || !body) return jsonError(res, 400, 'invalid JSON body');
        const name        = (body.name || '').trim();
        const hubUrl      = (body.url  || '').trim().replace(/\/+$/, '');
        const viewerToken = (body.viewerToken || '').trim();
        if (!name || !hubUrl) return jsonError(res, 400, 'name and url are required');

        insertHub(name, hubUrl, viewerToken, sessionUser && sessionUser.id ? sessionUser.id : null)
          .then(async () => {
            const user = sessionUser || await getSessionUser(req, true);
            const hubs = user
              ? (await listHubsForUser(user)).map(h => ({ name: h.name, url: h.url, canManage: !!h.canManage }))
              : (await listHubs()).map(h => ({ name: h.name, url: h.url, canManage: true }));
            jsonOK(res, { hubs });
          })
          .catch(err2 => {
            jsonError(res, err2.statusCode || 500, err2.statusCode ? err2.message : 'database error');
          });
      });
    });
  });
}

// DELETE /api/hubs?name=<name> — remove a hub by name
async function apiDeleteHub(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const name = (u.searchParams.get('name') || '').trim();
  if (!name) return jsonError(res, 400, 'name query parameter is required');

  const sessionUser = await getSessionUser(req, true);
  if (!hasBearerAdmin(req)) {
    if (!sessionUser) return jsonError(res, 401, 'unauthorized');
    const hub = await lookupHubForUser(sessionUser, name);
    if (!hub || !hub.canManage) return jsonError(res, 401, 'unauthorized');
  }

	try {
		const deleted = await deleteHubByName(name);
		if (!deleted) return jsonError(res, 404, 'hub not found');
    const hubs = sessionUser
      ? (await listHubsForUser(sessionUser)).map(h => ({ name: h.name, url: h.url, canManage: !!h.canManage }))
      : (await listHubs()).map(h => ({ name: h.name, url: h.url, canManage: true }));
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
    const user = await requireAuthenticated(req, res);
    if (!user) return;
    const hub = await lookupHubForUser(user, hubName);
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
    const user = await requireAuthenticated(req, res);
    if (!user) return;
    const hub = await lookupHubForUser(user, hubName);
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

  if ((urlPath === '/dashboard' || urlPath === '/dashboard/') && (method === 'GET' || method === 'HEAD')) {
    const user = await getSessionUser(req, true);
    res.writeHead(302, { Location: user ? '/portal/' : '/sample-portal/' });
    res.end();
    return;
  }

	if (urlPath === '/portal' || urlPath.startsWith('/portal/')) {
		const user = await requireAuthenticated(req, res, { redirect: true });
		if (!user) return;
		if (urlPath.startsWith('/portal/admin')) {
			if (!user.isAdmin) {
				res.writeHead(302, { Location: '/portal/' });
				res.end();
				return;
			}
		}
	}

  // Well-known discovery (RFC 8615)
  if (urlPath === '/.well-known/tela') {
    if (method === 'GET' || method === 'HEAD') {
      const body = JSON.stringify({ hub_directory: '/api/hubs' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(method === 'HEAD' ? '' : body);
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  // API routes
  if (urlPath === '/api/auth-mode') {
    if (method === 'GET' || method === 'HEAD') return apiAuthMode(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/login') {
    if (method === 'POST') return apiLogin(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/logout') {
    if (method === 'POST') return apiLogout(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/hubs') {
    if (method === 'GET' || method === 'HEAD') return apiGetHubs(req, res);
    if (method === 'POST')   return apiAddHub(req, res);
    if (method === 'DELETE') return apiDeleteHub(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/admin/access') {
    if (method === 'GET' || method === 'HEAD') return apiAdminGetAccess(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/admin/users') {
    if (method === 'GET' || method === 'HEAD') return apiAdminListUsers(req, res);
    if (method === 'POST') return apiAdminCreateUser(req, res);
    if (method === 'PATCH') return apiAdminUpdateUser(req, res);
    if (method === 'DELETE') return apiAdminDeleteUser(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/admin/memberships') {
    if (method === 'POST') return apiAdminUpsertMembership(req, res);
    if (method === 'DELETE') return apiAdminDeleteMembership(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/admin/reset-password') {
    if (method === 'POST') return apiAdminResetPassword(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/tokens') {
    if (method === 'GET' || method === 'HEAD') return apiListTokens(req, res);
    if (method === 'POST') return apiCreateToken(req, res);
    if (method === 'DELETE') return apiDeleteToken(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/my/invitations') {
    if (method === 'GET' || method === 'HEAD') return apiMyInvitations(req, res);
    res.writeHead(405); res.end(); return;
  }
  // POST /api/my/invitations/:id/accept or /decline
  const myInvAccept = urlPath.match(/^\/api\/my\/invitations\/(\d+)\/accept$/);
  if (myInvAccept && method === 'POST') return apiAcceptInvitation(req, res, Number(myInvAccept[1]));
  const myInvDecline = urlPath.match(/^\/api\/my\/invitations\/(\d+)\/decline$/);
  if (myInvDecline && method === 'POST') return apiDeclineInvitation(req, res, Number(myInvDecline[1]));

  if (urlPath === '/api/sign-up') {
    if (method === 'POST') return apiSignUp(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/me/password') {
    if (method === 'PATCH') return apiChangePassword(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/forgot-password') {
    if (method === 'POST') return apiForgotPassword(req, res);
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/api/reset-password') {
    if (method === 'POST') return apiResetPassword(req, res);
    res.writeHead(405); res.end(); return;
  }

  // /api/hubs/:name/invitations
  const hubInvMatch = urlPath.match(/^\/api\/hubs\/([^/]+)\/invitations$/);
  if (hubInvMatch) {
    const hName = decodeURIComponent(hubInvMatch[1]);
    if (method === 'GET' || method === 'HEAD') return apiListHubInvitations(req, res, hName);
    if (method === 'POST') return apiCreateHubInvitation(req, res, hName);
    if (method === 'DELETE') return apiRevokeHubInvitation(req, res, hName);
    res.writeHead(405); res.end(); return;
  }
  // /api/hubs/:name/members
  const hubMembersMatch = urlPath.match(/^\/api\/hubs\/([^/]+)\/members$/);
  if (hubMembersMatch) {
    const hName = decodeURIComponent(hubMembersMatch[1]);
    if (method === 'GET' || method === 'HEAD') return apiListHubMembers(req, res, hName);
    if (method === 'DELETE') return apiRemoveHubMember(req, res, hName);
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

async function ensureSuperAdminToken() {
  if (!BOOTSTRAP_EMAIL) return;
  const user = await findUserByEmail(BOOTSTRAP_EMAIL);
  if (!user || !user.isAdmin) return;

  const existing = await pool.query(
    "SELECT id FROM user_api_tokens WHERE user_id = $1 AND name = 'super-admin'",
    [user.id]
  );
  if (existing.rowCount > 0) return;

  const rawToken = 'tela_' + crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);
  const tokenPrefix = rawToken.slice(0, 12);

  await pool.query(
    'INSERT INTO user_api_tokens (user_id, name, token_hash, token_prefix) VALUES ($1, $2, $3, $4)',
    [user.id, 'super-admin', tokenHash, tokenPrefix]
  );

  console.log('[awansaya] ========================================');
  console.log('[awansaya] SUPER-ADMIN TOKEN for ' + user.email + ':');
  console.log('[awansaya]   ' + rawToken);
  console.log('[awansaya] Save this token — it will NOT be shown again.');
  console.log('[awansaya] ========================================');
}

async function main() {
  await connectWithRetry();
  await initDatabase();
  await importLegacyConfigIfNeeded();
	await ensureBootstrapAdmin();
	await backfillHubOwnership();
	await ensureSuperAdminToken();
  server.listen(PORT, () => {
    console.log(`[awansaya] listening on :${PORT}`);
  });
}

main().catch(err => {
  console.error(`[awansaya] startup failed: ${err.stack || err.message}`);
  process.exit(1);
});
