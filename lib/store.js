// MySQL-backed invite-code store. Replaces the previous data/codes.json file.
//
// Schema: see scripts/init-mysql.mjs (table `codes`).
//
// External API (preserved from the JSON version):
//   readAll, findById, findByPlaintext, add, consumeForPromotion,
//   isLoginDisabled, recordUse, revoke, activateMembership
//
// Every function is now async. bcrypt hashing still happens at write time so
// plaintext codes never touch disk (or MySQL).

import bcrypt from 'bcryptjs';
import { query, execute, toMysqlDt, fromMysqlDt } from './mysql.js';
import { generateCode } from './codes.js';
import { activationPatch, DEFAULT_MEMBERSHIP_YEARS } from './membership.js';

const SELECT = `id, code_hash, label, note, revoked, created_at, updated_at,
  last_used_at, use_count, login_disabled, consumed_for_account,
  consumed_at, membership_years, activated_at, expires_at`;

function rowToCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    hash: row.code_hash, // legacy alias used by callers (consumeForPromotion etc.)
    code_hash: row.code_hash,
    label: row.label,
    note: row.note,
    revoked: !!row.revoked,
    created_at: fromMysqlDt(row.created_at),
    updated_at: fromMysqlDt(row.updated_at),
    last_used_at: fromMysqlDt(row.last_used_at),
    use_count: Number(row.use_count || 0),
    login_disabled: !!row.login_disabled,
    consumed_for_account: row.consumed_for_account,
    consumed_at: fromMysqlDt(row.consumed_at),
    membership_years: row.membership_years != null ? Number(row.membership_years) : null,
    activated_at: fromMysqlDt(row.activated_at),
    expires_at: fromMysqlDt(row.expires_at),
  };
}

export async function readAll() {
  const rows = await query(`SELECT ${SELECT} FROM codes ORDER BY created_at DESC`);
  return rows.map(rowToCode);
}

export async function findById(id) {
  const rows = await query(`SELECT ${SELECT} FROM codes WHERE id = ? LIMIT 1`, [id]);
  return rowToCode(rows[0]);
}

export async function findByPlaintext(plaintext) {
  // Pull every non-revoked code and bcrypt.compare one by one. Codes table is
  // small (low-thousands worst case) so a linear scan is fine; bcrypt per row
  // is the bottleneck regardless. For a million-code setup we'd add an indexed
  // bucket-by-prefix scheme, but that's overkill here.
  const rows = await query(`SELECT ${SELECT} FROM codes WHERE revoked = 0`);
  for (const row of rows) {
    if (row.login_disabled) continue;
    try {
      if (await bcrypt.compare(plaintext, row.code_hash)) return rowToCode(row);
    } catch {}
  }
  return null;
}

export async function add({ label = '', note = '', membership_years = DEFAULT_MEMBERSHIP_YEARS } = {}) {
  const plaintext = generateCode();
  const hash = await bcrypt.hash(plaintext, 10);
  const years = Number(membership_years);
  const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const created_at = toMysqlDt(new Date());
  await execute(
    `INSERT INTO codes
      (id, code_hash, label, note, revoked, created_at, last_used_at,
       use_count, login_disabled, membership_years, activated_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      hash,
      label || null,
      note || null,
      0,
      created_at,
      null,
      0,
      0,
      years > 0 ? years : DEFAULT_MEMBERSHIP_YEARS,
      null,
      null,
    ]
  );
  const entry = await findById(id);
  return { ...entry, plaintext };
}

export async function consumeForPromotion(codeId, accountId) {
  const result = await execute(
    `UPDATE codes
     SET login_disabled = 1, consumed_for_account = ?, consumed_at = ?
     WHERE id = ?`,
    [accountId, toMysqlDt(new Date()), codeId]
  );
  return result.affectedRows > 0;
}

export function isLoginDisabled(entry) {
  return !!(entry && entry.login_disabled);
}

export async function recordUse(id) {
  await execute(
    `UPDATE codes SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?`,
    [toMysqlDt(new Date()), id]
  );
}

export async function revoke(id) {
  const result = await execute(`UPDATE codes SET revoked = 1 WHERE id = ?`, [id]);
  return result.affectedRows > 0;
}

export async function activateMembership(id) {
  const entry = await findById(id);
  if (!entry) return entry || null;
  const patch = activationPatch(entry);
  if (!patch) return entry;
  await execute(
    `UPDATE codes SET activated_at = ?, expires_at = ? WHERE id = ?`,
    [toMysqlDt(patch.activated_at), toMysqlDt(patch.expires_at), id]
  );
  return await findById(id);
}
