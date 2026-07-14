// Generic data store, MySQL-backed.
//
// External API (preserved from the JSON era):
//   list(table)             — returns every row
//   insert(table, record)   — auto-generates id + created_at if missing
//   findById(table, id)     — null if not found
//   update(table, id, patch)— returns updated row or null
//   remove(table, id)       — true if a row was deleted
//   appendLog(table, entry) — append + age/count trim
//
// EVERY function is now async. All SQL is parameterised.
//
// `id` generation: the previous JSON version minted ids with `Date.now()` +
// `Math.random()`. We keep that scheme so values migrate cleanly. Domain
// rows that already supply their own id (migrated JSON, JWT jti, etc.) keep it.

import { query, execute, toMysqlDt, shape, shapeMany } from './mysql.js';

export const Tables = {
  user_device: 'user_device',
  user_session: 'user_session',
  login_risk: 'login_risk',
  user_behavior_log: 'user_behavior_log',
  content_token: 'content_token',
  captcha_challenge: 'captcha_challenge',
  ip_block: 'ip_block',
  security_event: 'security_event',
};

function ensureKnown(table) {
  if (!Tables[table]) throw new Error(`unknown table: ${table}`);
}

function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function nowIso() { return new Date().toISOString(); }

// Map the universal "patch" object from callers into a per-table UPDATE
// statement. We only allow column names known to the schema so callers can't
// smuggle arbitrary fields through.
const COLUMNS = {
  user_device: ['user_id', 'device_id', 'device_type', 'browser', 'os', 'ip', 'country', 'location', 'last_active_time', 'payload'],
  user_session: ['jti', 'user_id', 'device_id', 'ip', 'ua', 'expires_at', 'revoked', 'revoked_at', 'payload'],
  login_risk: ['ts', 'type', 'user_id', 'ip', 'reasons', 'score', 'payload'],
  user_behavior_log: ['ts', 'user_id', 'device_id', 'ip', 'path', 'cls', 'payload'],
  content_token: ['token_hash', 'user_id', 'device_id', 'ip', 'resource', 'token', 'expires_at', 'consumed', 'consumed_at', 'used', 'used_at', 'payload'],
  captcha_challenge: ['answer_hash', 'image', 'sig', 'expires_at', 'consumed', 'consumed_at', 'payload'],
  ip_block: ['ip', 'reason', 'expires_at'],
  security_event: ['ts', 'type', 'payload'],
};

const DT_COLUMNS = new Set([
  'expires_at', 'last_active_time', 'revoked_at', 'consumed_at', 'used_at',
]);

const BOOL_COLUMNS = new Set(['revoked', 'consumed', 'used']);

const JSON_COLUMNS = new Set(['payload', 'reasons']);

function toDbValue(col, value) {
  if (value === undefined) return undefined; // not part of the patch
  if (value === null) return null;
  if (JSON_COLUMNS.has(col)) {
    if (typeof value === 'string') return value; // assume already JSON
    try { return JSON.stringify(value); } catch { return null; }
  }
  if (DT_COLUMNS.has(col)) return toMysqlDt(value);
  if (BOOL_COLUMNS.has(col)) return value ? 1 : 0;
  return value;
}

export async function list(table) {
  ensureKnown(table);
  const rows = await query(`SELECT * FROM \`${table}\``);
  return shapeMany(table, rows);
}

export async function findById(table, id) {
  ensureKnown(table);
  const rows = await query(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
  return shape(table, rows[0] || null);
}

// INSERT IGNORE so duplicates are silent. Always sets a non-null id and a
// non-null created_at so admin queries that rely on either field don't blow up.
export async function insert(table, record) {
  ensureKnown(table);
  const cols = COLUMNS[table] || [];
  const id = record.id || uid(`${table.slice(0, 2)}_`);
  const created_at = record.created_at || nowIso();

  // Insert only the schema-known columns to keep behaviour predictable.
  const insertCols = [];
  const insertVals = [];
  // Always carry id + created_at.
  insertCols.push('id', 'created_at');
  insertVals.push(String(id), toMysqlDt(created_at) || toMysqlDt(nowIso()));
  for (const c of cols) {
    if (c in record) {
      const v = toDbValue(c, record[c]);
      if (v !== undefined) {
        insertCols.push(c);
        insertVals.push(v);
      }
    }
  }
  const placeholders = insertCols.map(() => '?').join(',');
  const sql = `INSERT IGNORE INTO \`${table}\` (${insertCols.map(c => `\`${c}\``).join(',')}) VALUES (${placeholders})`;
  await execute(sql, insertVals);
  // Return the inserted (or already-existing) record so callers see the row
  // the same way they did with the JSON-backed version.
  return await findById(table, id);
}

export async function update(table, id, patch) {
  ensureKnown(table);
  const cols = COLUMNS[table] || [];
  const setSql = [];
  const setVals = [];
  // Always stamp updated_at so audit trails stay consistent.
  setSql.push('`updated_at` = ?');
  setVals.push(toMysqlDt(nowIso()));
  for (const c of cols) {
    if (c in patch) {
      const v = toDbValue(c, patch[c]);
      if (v !== undefined) {
        setSql.push(`\`${c}\` = ?`);
        setVals.push(v);
      }
    }
  }
  setVals.push(String(id));
  const sql = `UPDATE \`${table}\` SET ${setSql.join(', ')} WHERE id = ?`;
  const result = await execute(sql, setVals);
  if (result.affectedRows === 0) return null;
  return await findById(table, id);
}

export async function remove(table, id) {
  ensureKnown(table);
  const result = await execute(`DELETE FROM \`${table}\` WHERE id = ?`, [String(id)]);
  return result.affectedRows > 0;
}

// Append-only log tables: same interface as before but trimming happens via
// DELETE rather than rewriting a JSON file. LOG_KEEP caps the row count;
// LOG_MAX_AGE_DAYS drops anything older.
const LOG_KEEP = { user_behavior_log: 5000, security_event: 2000, login_risk: 500 };
const LOG_MAX_AGE_MS = 7 * 86400 * 1000;

const LOG_FIXED = {
  security_event: ['ts', 'type'],
  login_risk: ['ts', 'type', 'user_id', 'ip', 'reasons', 'score'],
  user_behavior_log: ['ts', 'user_id', 'device_id', 'ip', 'path', 'cls'],
};

export async function appendLog(table, entry) {
  ensureKnown(table);
  const id = entry.id || uid(`${table.slice(0, 2)}_`);
  const ts = entry.ts || Date.now();
  const FIXED = LOG_FIXED[table] || [];
  const insertCols = ['id', 'ts', 'created_at'];
  const insertVals = [String(id), Number(ts), toMysqlDt(nowIso())];
  const payload = {};
  for (const k of Object.keys(entry)) {
    if (k === 'id' || k === 'ts' || k === 'created_at') continue;
    if (FIXED.includes(k)) {
      const v = toDbValue(k, entry[k]);
      if (v !== undefined) {
        insertCols.push(k);
        insertVals.push(v);
      }
    } else {
      payload[k] = entry[k];
    }
  }
  if (Object.keys(payload).length) {
    insertCols.push('payload');
    insertVals.push(JSON.stringify(payload));
  }
  const placeholders = insertCols.map(() => '?').join(',');
  const sql = `INSERT IGNORE INTO \`${table}\` (${insertCols.map(c => `\`${c}\``).join(',')}) VALUES (${placeholders})`;
  await execute(sql, insertVals);

  // Trim by age (cheap; one DELETE per log table).
  const cutoff = Date.now() - LOG_MAX_AGE_MS;
  await execute(`DELETE FROM \`${table}\` WHERE ts IS NOT NULL AND ts < ?`, [cutoff]);

  // Trim by count: keep the most recent N rows. Slow on huge tables but our
  // max table is bounded (5k rows for behavior_log) so it's fine.
  const keep = Math.max(1, Math.min(100000, Number(LOG_KEEP[table] || 1000)));
  await execute(
    `DELETE FROM \`${table}\`
     WHERE id NOT IN (
       SELECT id FROM (
         SELECT id FROM \`${table}\` ORDER BY ts DESC LIMIT ${keep}
       ) t
     )`
  );

  return await findById(table, id);
}

// Convenience for diagnostics / admin summaries. Reads the latest N log rows
// without keeping the full set in memory — used by /api/admin/security/*.
export async function count(table) {
  ensureKnown(table);
  const rows = await query(`SELECT COUNT(*) AS c FROM \`${table}\``);
  return Number(rows[0]?.c || 0);
}
