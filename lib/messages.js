// MySQL-backed admin-to-user message store.
//
// Schema: see scripts/init-mysql.mjs (table `user_messages`).

import { query, execute, toMysqlDt, fromMysqlDt } from './mysql.js';

const SELECT = `id, user_id, kind, title, body, read_at, created_by, created_at, updated_at`;

function uid() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind || 'info',
    title: row.title || '',
    body: row.body || '',
    read_at: fromMysqlDt(row.read_at),
    created_by: row.created_by || null,
    created_at: fromMysqlDt(row.created_at),
    updated_at: fromMysqlDt(row.updated_at),
    read: !!row.read_at,
  };
}

async function findById(id) {
  const rows = await query(`SELECT ${SELECT} FROM user_messages WHERE id = ? LIMIT 1`, [id]);
  return rows[0] ? rowToMessage(rows[0]) : null;
}

export async function create({
  user_id,
  kind = 'info',
  title,
  body,
  created_by = '',
} = {}) {
  const safeUserId = String(user_id || '').trim();
  const safeTitle = String(title || '').trim().slice(0, 200);
  const safeBody = String(body || '').trim().slice(0, 5000);
  if (!safeUserId) throw new Error('user_id required');
  if (!safeTitle || !safeBody) throw new Error('title and body required');

  const allowedKinds = ['info', 'warn', 'success'];
  const safeKind = allowedKinds.includes(kind) ? kind : 'info';
  const id = uid();
  const nowSql = toMysqlDt(new Date());
  await execute(
    `INSERT INTO user_messages
      (id, user_id, kind, title, body, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      id,
      safeUserId,
      safeKind,
      safeTitle,
      safeBody,
      String(created_by || '').slice(0, 64),
      nowSql,
    ]
  );
  return await findById(id);
}

export async function listForUser(userId, { limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = await query(
    `SELECT ${SELECT}
     FROM user_messages
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
    [userId]
  );
  return rows.map(rowToMessage);
}

export async function markRead(id, userId) {
  const result = await execute(
    `UPDATE user_messages
     SET read_at = COALESCE(read_at, ?),
         updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [toMysqlDt(new Date()), toMysqlDt(new Date()), id, userId]
  );
  if (result.affectedRows === 0) return null;
  return await findById(id);
}

export async function unreadCount(userId) {
  const rows = await query(
    `SELECT COUNT(*) AS count
     FROM user_messages
     WHERE user_id = ? AND read_at IS NULL`,
    [userId]
  );
  return Number(rows[0]?.count || 0);
}
