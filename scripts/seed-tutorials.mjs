// scripts/seed-tutorials.mjs
//
// Seeds the tutorials table with default tutorial(s).
// Safe to re-run: INSERT ... ON DUPLICATE KEY UPDATE.

import 'dotenv/config';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { URL } from 'node:url';

function readConfig() {
  const base = {
    dateStrings: true,
    multipleStatements: false,
    connectTimeout: parseInt(process.env.MYSQL_CONNECT_TIMEOUT_MS || '15000', 10),
  };
  if (process.env.MYSQL_URL) {
    const u = new URL(process.env.MYSQL_URL);
    const sslMode = u.searchParams.get('ssl-mode') || u.searchParams.get('ssl');
    const ssl = sslMode && sslMode !== 'false' && sslMode !== '0'
      ? { rejectUnauthorized: sslMode === 'VERIFY_IDENTITY' }
      : null;
    return {
      ...base,
      host: u.hostname,
      port: parseInt(u.port || '4000', 10),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: (u.pathname || '/').replace(/^\//, '') || process.env.MYSQL_DATABASE || 'prompt_vault',
      ssl: ssl ?? (u.hostname.includes('tidbcloud.com') ? {} : undefined),
    };
  }
  const host = process.env.MYSQL_HOST || '127.0.0.1';
  return {
    ...base,
    host,
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'prompt_vault',
    ssl: host.includes('tidbcloud.com') ? {} : undefined,
  };
}

function toMysqlDt(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 19).replace('T', ' ');
  const d = new Date(String(v));
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  return null;
}

const now = toMysqlDt(Date.now());

const DEFAULT_TUTORIALS = [
  {
    id: 'tutorial-001',
    title: '新手使用教程',
    description: '第一次使用 Prompt Vault，请先观看这个教程。',
    button_label: '使用教程',
    external_url: 'https://v.douyin.com/0T-aHQW3MwA/',
    platform: 'douyin',
    sort_order: 1,
    enabled: 1,
    open_mode: 'external',
  },
];

async function ensureTable(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS tutorials (
    id              VARCHAR(64)  NOT NULL,
    title           VARCHAR(255) NOT NULL,
    description     TEXT NULL,
    button_label    VARCHAR(64)  NULL,
    video_url       TEXT NULL,
    external_url    TEXT NULL,
    cover_url       TEXT NULL,
    platform        VARCHAR(64)  NULL,
    sort_order      INT NOT NULL DEFAULT 0,
    enabled         TINYINT(1) NOT NULL DEFAULT 1,
    open_mode       VARCHAR(32) NOT NULL DEFAULT 'external',
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_tutorials_enabled_sort (enabled, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function upsertTutorials(conn, tutorials) {
  const columns = [
    'id', 'title', 'description', 'button_label',
    'video_url', 'external_url', 'cover_url', 'platform',
    'sort_order', 'enabled', 'open_mode', 'created_at', 'updated_at',
  ];
  const update = columns
    .filter(col => col !== 'id' && col !== 'created_at')
    .map(col => `${col}=VALUES(${col})`)
    .join(', ');

  const placeholders = tutorials.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
  const params = [];
  for (const t of tutorials) {
    params.push(
      String(t.id),
      String(t.title),
      t.description != null ? String(t.description) : null,
      t.button_label != null ? String(t.button_label) : null,
      t.video_url != null ? String(t.video_url) : null,
      t.external_url != null ? String(t.external_url) : null,
      t.cover_url != null ? String(t.cover_url) : null,
      t.platform != null ? String(t.platform) : null,
      Number(t.sort_order || 0),
      t.enabled ? 1 : 0,
      String(t.open_mode || 'external'),
      now,
      now,
    );
  }

  const [res] = await conn.execute(
    `INSERT INTO tutorials (${columns.join(',')}) VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE ${update}`,
    params,
  );
  return res.affectedRows || 0;
}

async function printSummary(conn) {
  const [rows] = await conn.query(
    'SELECT id, title, platform, open_mode, sort_order, enabled FROM tutorials ORDER BY sort_order'
  );
  console.log('\n[tutorials] current records:');
  if (rows.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of rows) {
      console.log(`  [${r.enabled ? 'ON' : 'OFF'}] ${r.sort_order}. ${r.title} (${r.platform}, ${r.open_mode})`);
    }
  }
}

async function main() {
  const conn = await mysql.createConnection(readConfig());
  await ensureTable(conn);

  console.log('[tutorials] seeding...');
  const affected = await upsertTutorials(conn, DEFAULT_TUTORIALS);
  console.log(`[tutorials] affected rows: ${affected}`);

  await printSummary(conn);
  await conn.end();
  console.log('[tutorials] done.');
}

main().catch(err => {
  console.error('[tutorials] failed:', err);
  process.exit(1);
});
