// MySQL-backed announcement store. Replaces the previous data/announcements.json.
//
// Schema: see scripts/init-mysql.mjs (table `announcements`).
//
// External API (preserved from the JSON version):
//   listAll, listActive, create, update, remove
//
// All async. The JSON file used `active` as the boolean field; we map that to
// `enabled` AND keep `active` populated for backwards compatibility with the
// listActive() / admin console filters that key off `active`.

import { query, execute, toMysqlDt, fromMysqlDt } from './mysql.js';

const SELECT = `id, kind, title, body, enabled, pinned, active, starts_at,
  ends_at, expires_at, created_by, created_at, updated_at`;

function rowToAnnouncement(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    enabled: !!row.enabled,
    pinned: !!row.pinned,
    active: !!row.active, // legacy field — kept in sync with `enabled`
    starts_at: fromMysqlDt(row.starts_at),
    ends_at: fromMysqlDt(row.ends_at),
    expires_at: fromMysqlDt(row.expires_at),
    created_by: row.created_by,
    created_at: fromMysqlDt(row.created_at),
    updated_at: fromMysqlDt(row.updated_at),
  };
}

export async function listAll() {
  const rows = await query(`SELECT ${SELECT} FROM announcements ORDER BY created_at DESC`);
  return rows.map(rowToAnnouncement);
}

async function findById(id) {
  const rows = await query(`SELECT ${SELECT} FROM announcements WHERE id = ? LIMIT 1`, [id]);
  return rows[0] ? rowToAnnouncement(rows[0]) : null;
}

export async function listActive() {
  const now = new Date().toISOString();
  const nowSql = toMysqlDt(now);
  const rows = await query(
    `SELECT ${SELECT} FROM announcements
     WHERE active = 1
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY pinned DESC, created_at DESC`,
    [nowSql]
  );
  return rows.map(rowToAnnouncement);
}

export async function create({ kind = 'info', title, body, expires_at = null, pinned = false, created_by = '' } = {}) {
  if (!title || !body) throw new Error('title and body required');
  const allowedKinds = ['info', 'warn', 'downtime', 'promo'];
  const safeKind = allowedKinds.includes(kind) ? kind : 'info';
  const id = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const safeTitle = String(title).slice(0, 200);
  const safeBody = String(body).slice(0, 5000);
  const safeCreatedBy = String(created_by || '').slice(0, 64);
  const nowSql = toMysqlDt(new Date());
  await execute(
    `INSERT INTO announcements
      (id, kind, title, body, enabled, pinned, active, expires_at,
       created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      safeKind,
      safeTitle,
      safeBody,
      1,
      pinned ? 1 : 0,
      1,
      toMysqlDt(expires_at),
      safeCreatedBy,
      nowSql,
    ]
  );
  return await findById(id);
}

export async function update(id, patch) {
  const allowed = ['kind', 'title', 'body', 'expires_at', 'pinned', 'active', 'enabled'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (k === 'title') v = String(v || '').slice(0, 200);
    else if (k === 'body') v = String(v || '').slice(0, 5000);
    else if (k === 'pinned') v = v ? 1 : 0;
    else if (k === 'active') v = v ? 1 : 0;
    else if (k === 'enabled') v = v ? 1 : 0;
    else if (k === 'expires_at') v = toMysqlDt(v);
    sets.push(`\`${k}\` = ?`);
    vals.push(v);
  }
  // Keep `enabled` and `active` in sync so consumers that read either field
  // see the same value (legacy JSON file only had `active`).
  if ('active' in patch && !('enabled' in patch)) {
    sets.push('`enabled` = ?');
    vals.push(patch.active ? 1 : 0);
  } else if ('enabled' in patch && !('active' in patch)) {
    sets.push('`active` = ?');
    vals.push(patch.enabled ? 1 : 0);
  }
  if (!sets.length) return await findById(id);
  sets.push('`updated_at` = ?');
  vals.push(toMysqlDt(new Date()));
  vals.push(id);
  const result = await execute(
    `UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`,
    vals
  );
  if (result.affectedRows === 0) return null;
  return await findById(id);
}

export async function remove(id) {
  const result = await execute(`DELETE FROM announcements WHERE id = ?`, [id]);
  return result.affectedRows > 0;
}