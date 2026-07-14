// MySQL connection pool + small helpers used everywhere in lib/.
//
// Why a tiny wrapper: every domain lib (db.js, accounts.js, store.js, etc.)
// only needs to run parameterised SQL. Centralising the pool + time-coercion
// helpers here means the rest of the codebase can stay free of mysql2 import
// noise and identical `try/catch` boilerplate.
//
// Time handling: every DATETIME column is read/written as a plain ISO 8601
// string (`YYYY-MM-DDTHH:mm:ss.sssZ`). The mysql2 driver by default returns
// Date objects for DATETIME columns, which would break every existing handler
// in server.js that compares dates as strings via `new Date(...)`. Forcing
// strings keeps the contract identical to the previous JSON-on-disk shape.

// Cloud DB support added.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { URL } from 'node:url';

function readConfig() {
  if (process.env.MYSQL_URL) {
    const u = new URL(process.env.MYSQL_URL);
    const sslMode = u.searchParams.get('ssl-mode') || u.searchParams.get('ssl');
    const ssl = sslMode && sslMode !== 'false' && sslMode !== '0'
      ? { rejectUnauthorized: sslMode === 'VERIFY_IDENTITY' || sslMode === 'true' }
      : null;
    return {
      host: u.hostname,
      port: parseInt(u.port || '4000', 10),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: (u.pathname || '/').replace(/^\//, '') || undefined,
      connectionLimit: parseInt(process.env.MYSQL_CONNECTION_LIMIT || '5', 10),
      waitForConnections: true,
      queueLimit: 0,
      dateStrings: true,
      multipleStatements: false,
      charset: 'utf8mb4',
      ssl: ssl ?? (u.hostname.includes('tidbcloud.com') ? {} : undefined),
    };
  }
  const host = process.env.MYSQL_HOST || '127.0.0.1';
  return {
    host,
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'prompt_vault',
    connectionLimit: parseInt(process.env.MYSQL_CONNECTION_LIMIT || '10', 10),
    waitForConnections: true,
    queueLimit: 0,
    dateStrings: true,
    multipleStatements: false,
    charset: 'utf8mb4',
    ssl: host.includes('tidbcloud.com') ? {} : undefined,
  };
}

let _pool = null;
let _config = null;

export function getPool() {
  if (_pool) return _pool;
  _config = readConfig();
  _pool = mysql.createPool(_config);
  return _pool;
}

// For diagnostics / health checks. Safe to call before any query has run.
export function describeConnection() {
  if (!_config) _config = readConfig();
  return {
    host: _config.host,
    port: _config.port,
    database: _config.database,
    user: _config.user,
    ssl: !!_config.ssl,
    poolSize: _config.connectionLimit,
  };
}

// Run a parameterised SELECT / INSERT / UPDATE / DELETE.
// `params` is always required (even for queries with no placeholders) to make
// accidental string concatenation obvious to anyone reading the call site.
export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

// Same shape as query() but returns the raw OkPacket / ResultSetHeader so
// callers can read insertId / affectedRows. Useful for inserts.
export async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

// Run `fn(conn)` inside a single transaction. Commits on success, rolls back
// on throw, always releases the connection back to the pool.
export async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

// ---- Time helpers ----
//
// All time columns in this project are DATETIME (no timezone info on the
// server side). We treat every value as UTC and only stringify to / parse
// from ISO at the application boundary.

export function toMysqlDt(value) {
  if (value == null || value === '') return null;
  // Numbers = epoch millis.
  if (typeof value === 'number') return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
  // Strings: accept either ISO 8601 or already-shaped `YYYY-MM-DD HH:mm:ss`.
  const s = String(value).trim();
  if (!s) return null;
  // `YYYY-MM-DDTHH:mm:ss(.sss)?Z?`
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (iso) return `${iso[1]} ${iso[2]}`;
  // Fallback: hand to Date. If it can't parse, we still emit the original
  // string and let MySQL complain (caught upstream).
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  return s;
}

// Convert any value coming back from a DATETIME column into the ISO string
// shape every existing JSON consumer expects. With `dateStrings: true` this
// mostly returns `YYYY-MM-DD HH:mm:ss`; we re-shape it so JS code can call
// `new Date(...)` on it directly without surprises.
export function fromMysqlDt(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  if (!s) return null;
  // `YYYY-MM-DD HH:mm:ss(.sss)?` -> ISO. Treat as UTC since we always write
  // UTC. Don't touch values that already look ISO.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/);
  if (m) return `${m[1]}T${m[2]}.000Z`;
  return s;
}

// Walk a row from MySQL and re-shape DATETIME columns to ISO strings so
// downstream code doesn't need to know which column is which type. The schema
// is small enough that hardcoding the column names is clearer than introspect.
const DATETIME_COLUMNS = {
  accounts: ['activated_at', 'expires_at', 'created_at', 'updated_at', 'last_login_at'],
  codes: ['created_at', 'updated_at', 'last_used_at', 'consumed_at', 'activated_at', 'expires_at'],
  user_device: ['last_active_time', 'created_at', 'updated_at'],
  user_session: ['expires_at', 'revoked_at', 'created_at', 'updated_at'],
  captcha_challenge: ['expires_at', 'consumed_at', 'created_at', 'updated_at'],
  content_token: ['expires_at', 'consumed_at', 'created_at', 'updated_at', 'used_at'],
  ip_block: ['expires_at', 'created_at', 'updated_at'],
  security_event: ['created_at'],
  login_risk: ['created_at'],
  user_behavior_log: ['created_at'],
  announcements: ['starts_at', 'ends_at', 'expires_at', 'created_at', 'updated_at'],
};

export function normaliseRow(table, row) {
  if (!row) return row;
  const cols = DATETIME_COLUMNS[table];
  if (!cols) return row;
  const out = { ...row };
  for (const c of cols) {
    if (c in out) out[c] = fromMysqlDt(out[c]);
  }
  return out;
}

// Tinyint (0/1) fields in MySQL come back as JS numbers but JSON consumers
// expect booleans for parity with the old JSON file shape. Centralise the
// conversion here so individual libs don't each invent their own.
const BOOL_COLUMNS = {
  accounts: ['revoked'],
  codes: ['revoked', 'login_disabled'],
  user_session: ['revoked'],
  captcha_challenge: ['consumed'],
  content_token: ['consumed', 'used'],
  announcements: ['enabled', 'pinned', 'active'],
};

export function normaliseBools(table, row) {
  if (!row) return row;
  const cols = BOOL_COLUMNS[table];
  if (!cols) return row;
  const out = { ...row };
  for (const c of cols) {
    if (c in out) out[c] = !!out[c];
  }
  return out;
}

// Apply both transforms in one go. `table` is the logical table name.
export function shapeRow(table, row) {
  return normaliseBools(table, normaliseRow(table, row));
}

export function shapeRows(table, rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => shapeRow(table, r));
}

// JSON columns that need re-parsing when read back. Stored as JSON strings in
// MySQL (so we can index/search them with JSON_EXTRACT) but exposed as
// objects to keep callers happy.
const JSON_COLUMNS = {
  security_event: ['payload'],
  login_risk: ['reasons', 'payload'],
  user_behavior_log: ['payload'],
};

export function parseJsonFields(table, row) {
  if (!row) return row;
  const cols = JSON_COLUMNS[table];
  if (!cols) return row;
  const out = { ...row };
  for (const c of cols) {
    if (out[c] == null) continue;
    if (typeof out[c] === 'string') {
      try { out[c] = JSON.parse(out[c]); } catch {}
    }
    // Already an object/array? Leave as-is (mysql2 default behaviour for JSON
    // columns). Defensive code so we don't crash on either path.
  }
  return out;
}

export function shape(table, row) {
  return parseJsonFields(table, shapeRow(table, row));
}

export function shapeMany(table, rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => shape(table, r));
}

export async function closePool() {
  if (_pool) {
    const p = _pool;
    _pool = null;
    await p.end();
  }
}
