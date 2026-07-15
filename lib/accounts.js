// MySQL-backed username/password account store.
//
// Schema: see scripts/init-mysql.mjs (table `accounts`).
//
// External API (preserved from the JSON version):
//   validateUsername / validatePassword
//   findByUsername, findById, listAll
//   createAccount, verifyPassword, recordLogin
//   revoke, syncMembership
//
// Every function is now async. Password hashing still uses bcrypt cost 10.

import bcrypt from 'bcryptjs';
import { query, execute, transaction, toMysqlDt, fromMysqlDt } from './mysql.js';

const ALLOWED_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]+$/;

export function validateUsername(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '用户名不合法' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: '请输入用户名' };
  if (trimmed.length < 4) return { ok: false, error: '用户名至少 4 个字符' };
  if (trimmed.length > 20) return { ok: false, error: '用户名最多 20 个字符' };
  if (!ALLOWED_RE.test(trimmed)) {
    return { ok: false, error: '用户名只能包含字母、数字、下划线、中文' };
  }
  return { ok: true, value: trimmed };
}

export function validatePassword(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '密码不合法' };
  if (raw.length < 8) return { ok: false, error: '密码至少 8 个字符' };
  if (raw.length > 128) return { ok: false, error: '密码过长' };
  return { ok: true, value: raw };
}

function uid() {
  return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Select columns are kept narrow so the public object matches the previous
// JSON shape (no leaks of internal columns). `revoked` is a 0/1 tinyint in
// MySQL — we expose it as a boolean for parity with the old API.
const SELECT = `id, username, password_hash, kind, promoted_from_code, note,
  membership_years, activated_at, expires_at, created_at, updated_at,
  last_login_at, login_count, revoked, revoked_reason, revoked_at`;

function rowToAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    password_hash: row.password_hash,
    kind: row.kind,
    promoted_from_code: row.promoted_from_code,
    note: row.note,
    membership_years: row.membership_years != null ? Number(row.membership_years) : null,
    activated_at: fromMysqlDt(row.activated_at),
    expires_at: fromMysqlDt(row.expires_at),
    created_at: fromMysqlDt(row.created_at),
    updated_at: fromMysqlDt(row.updated_at),
    last_login_at: fromMysqlDt(row.last_login_at),
    login_count: Number(row.login_count || 0),
    revoked: !!row.revoked,
    revoked_reason: row.revoked_reason || null,
    revoked_at: fromMysqlDt(row.revoked_at),
  };
}

export async function findByUsername(username) {
  const rows = await query(`SELECT ${SELECT} FROM accounts WHERE username = ? LIMIT 1`, [username]);
  return rowToAccount(rows[0]);
}

export async function findById(id) {
  const rows = await query(`SELECT ${SELECT} FROM accounts WHERE id = ? LIMIT 1`, [id]);
  return rowToAccount(rows[0]);
}

export async function listAll() {
  const rows = await query(`SELECT ${SELECT} FROM accounts ORDER BY created_at DESC`);
  return rows.map(rowToAccount);
}

export async function createAccount({
  username, password, kind = 'registered', promoted_from_code = null, note = '',
  membership_years = null, activated_at = null, expires_at = null,
} = {}) {
  const uv = validateUsername(username);
  if (!uv.ok) throw new Error(uv.error);
  const pv = validatePassword(password);
  if (!pv.ok) throw new Error(pv.error);

  // Transaction so the username-uniqueness check + insert is atomic.
  return await transaction(async (conn) => {
    const [existing] = await conn.execute(
      `SELECT id FROM accounts WHERE username = ? LIMIT 1`,
      [uv.value]
    );
    if (existing.length) {
      const err = new Error('用户名已被占用');
      err.code = 'username_taken';
      throw err;
    }
    const password_hash = await bcrypt.hash(pv.value, 10);
    const id = uid();
    const created_at_dt = toMysqlDt(new Date());
    await conn.execute(
      `INSERT INTO accounts
        (id, username, password_hash, kind, promoted_from_code, note,
         membership_years, activated_at, expires_at, created_at,
         last_login_at, login_count, revoked)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        uv.value,
        password_hash,
        kind,
        promoted_from_code,
        note,
        membership_years != null ? Number(membership_years) : null,
        toMysqlDt(activated_at),
        toMysqlDt(expires_at),
        created_at_dt,
        null,
        0,
        0,
      ]
    );
    const [created] = await conn.execute(
      `SELECT ${SELECT} FROM accounts WHERE id = ? LIMIT 1`,
      [id]
    );
    return rowToAccount(created[0]);
  });
}

export async function verifyPassword(username, password) {
  const a = await findByUsername(username);
  if (!a) {
    // Dummy compare to keep timing roughly constant across "no user" / "wrong pw".
    await bcrypt.compare(password || 'x', '$2a$10$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMNOPQRSTUV');
    return null;
  }
  if (a.revoked) return null;
  let ok = false;
  try { ok = await bcrypt.compare(password, a.password_hash); } catch { ok = false; }
  return ok ? a : null;
}

export async function recordLogin(id) {
  await execute(
    `UPDATE accounts
     SET last_login_at = ?, login_count = login_count + 1
     WHERE id = ?`,
    [toMysqlDt(new Date()), id]
  );
}

export async function revoke(id) {
  return await ban(id);
}

export async function ban(id, reason = null) {
  const result = await execute(
    `UPDATE accounts
     SET revoked = 1,
         revoked_reason = ?,
         revoked_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      reason ? String(reason).trim() : null,
      toMysqlDt(new Date()),
      toMysqlDt(new Date()),
      id,
    ]
  );
  if (result.affectedRows === 0) return null;
  return await findById(id);
}

export async function unban(id) {
  const result = await execute(
    `UPDATE accounts
     SET revoked = 0,
         revoked_reason = NULL,
         revoked_at = NULL,
         updated_at = ?
     WHERE id = ?`,
    [toMysqlDt(new Date()), id]
  );
  if (result.affectedRows === 0) return null;
  return await findById(id);
}

export async function syncMembership(id, { membership_years, activated_at, expires_at }) {
  const sets = [];
  const vals = [];
  if (membership_years != null) { sets.push('membership_years = ?'); vals.push(Number(membership_years)); }
  if (activated_at != null) { sets.push('activated_at = ?'); vals.push(toMysqlDt(activated_at)); }
  if (expires_at != null) { sets.push('expires_at = ?'); vals.push(toMysqlDt(expires_at)); }
  if (!sets.length) return await findById(id);
  vals.push(id);
  const result = await execute(
    `UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`,
    vals
  );
  if (result.affectedRows === 0) return null;
  return await findById(id);
}
