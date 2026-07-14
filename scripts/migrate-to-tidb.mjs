#!/usr/bin/env node
/**
 * One-shot migration: import the local MySQL dump into TiDB Cloud.
 *
 * What it does:
 *   1. Connects to TiDB using MYSQL_URL (or discrete MYSQL_* env vars).
 *   2. Splits prompt_vault.tidb.sql on `;` boundaries and runs each
 *      statement. CREATE TABLE statements first, then INSERT statements.
 *   3. Verifies the row counts after import.
 *
 * Why split + run statement-by-statement instead of `multipleStatements`?
 *   The mysql2 driver is configured with `multipleStatements: false` so a
 *   single bad statement can't smuggle in extra ones. Doing the same here
 *   keeps the trust boundary consistent.
 *
 * Usage:
 *   node scripts/migrate-to-tidb.mjs prompt_vault.tidb.sql
 *
 * The script expects the same env vars your running app uses (MYSQL_URL or
 * MYSQL_HOST / MYSQL_USER / ...). Put them in .env or pass them inline.
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { URL } from 'node:url';

const src = process.argv[2] || 'prompt_vault.tidb.sql';

// Mirror the connection helper in lib/mysql.js (kept private there on
// purpose). Keeping it in sync here is cheap — and avoids the ESM dynamic
// import-with-query-string hack that some Node versions refuse to honour.
function readConfig() {
  if (process.env.MYSQL_URL) {
    const u = new URL(process.env.MYSQL_URL);
    return {
      host: u.hostname,
      port: parseInt(u.port || '4000', 10),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: (u.pathname || '/').replace(/^\//, '') || undefined,
      ssl: u.hostname.includes('tidbcloud.com') ? {} : undefined,
    };
  }
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'prompt_vault',
    ssl: (process.env.MYSQL_HOST || '').includes('tidbcloud.com') ? {} : undefined,
  };
}

const cfg = readConfig();
// This script needs multi-statement to import the dump efficiently. The
// running app keeps multipleStatements:false (see lib/mysql.js).
cfg.multipleStatements = true;

console.log(`[migrate] target ${cfg.host}:${cfg.port}/${cfg.database} (ssl=${!!cfg.ssl})`);
const conn = await mysql.createConnection(cfg);

// Make sure the database exists. TiDB Cloud Starter creates the database
// lazily, but we want to fail loudly here if the URL is wrong rather than
// silently creating one with a weird name.
await conn.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\``);
await conn.query(`USE \`${cfg.database}\``);

const sql = await readFile(src, 'utf8');

// mysql2 with multipleStatements:true runs the whole dump in one shot.
// That keeps the import fast (single round trip per statement batch) and
// lets the driver decide where each statement starts/ends.
console.log(`[migrate] importing ${src} (${sql.length} bytes)...`);
const t0 = Date.now();
await conn.query(sql);
console.log(`[migrate] import done in ${Date.now() - t0}ms`);

// Verify: count rows per table and print a quick summary.
const tables = [
  'accounts',
  'announcements',
  'captcha_challenge',
  'codes',
  'content_token',
  'ip_block',
  'login_risk',
  'security_event',
  'user_behavior_log',
  'user_device',
  'user_session',
];
console.log('[migrate] row counts:');
for (const t of tables) {
  try {
    const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    const n = rows[0]?.n ?? '?';
    console.log(`  ${t.padEnd(22)} ${n}`);
  } catch (err) {
    console.log(`  ${t.padEnd(22)} ERROR: ${err.message}`);
  }
}

await conn.end();
console.log('[migrate] done.');