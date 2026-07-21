// scripts/migrate-prompts-to-mysql.mjs
//
// Reads merged-prompts.json and upserts all records into:
//   - prompt_cards   (metadata, no prompt_text)
//   - prompt_card_bodies (prompt_text stored separately for performance)
//
// Safe to re-run: INSERT ... ON DUPLICATE KEY UPDATE
// Options:
//   --force-active  reset all active=1 even if previously manually set to 0

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_FILE = path.join(__dirname, '..', 'merged-prompts.json');
const FORCE_ACTIVE = process.argv.includes('--force-active');

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

function j(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return null; }
}

function normalizeTagList(value) {
  if (Array.isArray(value)) return value.map(tag => String(tag).trim()).filter(Boolean);
  return String(value || '').split(/[,，、\s]+/).map(tag => tag.trim()).filter(Boolean);
}

function promptHash(text) {
  if (!text) return null;
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 64);
}

function normalizePromptRecord(raw, index) {
  const promptText = String(raw.prompt_text || '').trim();
  const id = String(raw.id || `prompt-${index + 1}`).trim();
  const title = String(raw.title || `Prompt ${index + 1}`).trim();
  const category = String(raw.category || raw.type || 'General').trim();
  const originalCategory = String(raw.original_category || category).trim();
  const pageType = String(raw.page_type || raw.type || 'general').trim();
  const summary = String(raw.summary || raw.description || '').trim();
  const description = String(raw.description || summary || '').trim();
  const tags = normalizeTagList(raw.tags || raw.types || []);
  const isFree = raw.is_free === true || raw.is_free === 1 || raw.is_free === 'true' || raw.is_free === '1' ? 1 : 0;
  const isBlindbox = raw.is_blindbox === true || raw.is_blindbox === 1 || raw.is_blindbox === 'true' || raw.is_blindbox === '1' ? 1 : 0;
  const memberOnly = raw.member_only === false || raw.member_only === 0 ? 0 : 1;
  const sortOrder = Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : index + 1;
  const heat = Number.isFinite(Number(raw.heat || raw.views || raw.likes || 0)) ? Number(raw.heat || raw.views || raw.likes || 0) : index + 1;
  const createdAt = toMysqlDt(raw.created_at) || toMysqlDt(Date.now());
  const rawJson = { ...raw };
  delete rawJson.prompt_text; // Don't duplicate in raw

  return {
    id,
    title,
    category,
    original_category: originalCategory,
    page_type: pageType,
    summary: summary || null,
    description: description || null,
    tags,
    preview_image_url: String(raw.image_preview_url || raw.preview_image_url || '').trim() || null,
    preview_thumb_url: String(raw.preview_thumb_url || raw.preview_thumb_url || raw.image_preview_url || '').trim() || null,
    image_preview_url: String(raw.image_preview_url || raw.preview_image_url || '').trim() || null,
    source_url: String(raw.source_url || '').trim() || null,
    demo_url: String(raw.demo_url || raw.playable_video_url || raw.video_preview_url || '').trim() || null,
    sort_order: sortOrder,
    source: String(raw.source || 'merged').trim(),
    is_free: isFree,
    is_blindbox: isBlindbox,
    member_only: memberOnly,
    active: 1,
    heat: heat,
    raw: j(rawJson),
    created_at: createdAt,
    prompt_text: promptText,
    prompt_text_length: promptText.length,
    prompt_hash: promptHash(promptText),
  };
}

async function ensureTables(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS prompt_cards (
    id                 VARCHAR(191) NOT NULL,
    title              VARCHAR(255) NOT NULL,
    category           VARCHAR(191) NULL,
    original_category  VARCHAR(191) NULL,
    page_type          VARCHAR(191) NULL,
    summary            TEXT NULL,
    description        TEXT NULL,
    tags               JSON NULL,
    preview_image_url  TEXT NULL,
    preview_thumb_url  TEXT NULL,
    image_preview_url  TEXT NULL,
    source_url         TEXT NULL,
    demo_url           TEXT NULL,
    sort_order         INT NOT NULL DEFAULT 0,
    source             VARCHAR(64) NULL,
    is_free            TINYINT(1) NOT NULL DEFAULT 0,
    is_blindbox        TINYINT(1) NOT NULL DEFAULT 0,
    member_only        TINYINT(1) NOT NULL DEFAULT 1,
    active             TINYINT(1) NOT NULL DEFAULT 1,
    heat               INT NOT NULL DEFAULT 0,
    raw                JSON NULL,
    created_at         DATETIME NOT NULL,
    updated_at         DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_prompt_cards_active_sort (active, sort_order),
    KEY idx_prompt_cards_category (category),
    KEY idx_prompt_cards_title (title),
    KEY idx_prompt_cards_free_blindbox (is_free, is_blindbox)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await conn.query(`CREATE TABLE IF NOT EXISTS prompt_card_bodies (
    card_id            VARCHAR(191) NOT NULL,
    prompt_text        LONGTEXT NOT NULL,
    prompt_text_length INT NOT NULL DEFAULT 0,
    prompt_hash        VARCHAR(64) NULL,
    created_at         DATETIME NOT NULL,
    updated_at         DATETIME NULL,
    PRIMARY KEY (card_id),
    KEY idx_prompt_card_bodies_length (prompt_text_length)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function upsertCards(conn, rows) {
  const columns = [
    'id', 'title', 'category', 'original_category', 'page_type',
    'summary', 'description', 'tags', 'preview_image_url', 'preview_thumb_url',
    'image_preview_url', 'source_url', 'demo_url', 'sort_order', 'source',
    'is_free', 'is_blindbox', 'member_only', 'active', 'heat', 'raw',
    'created_at', 'updated_at',
  ];
  const update = columns
    .filter(col => col !== 'id' && col !== 'created_at')
    .map(col => `${col}=VALUES(${col})`)
    .join(', ');
  let inserted = 0, updated = 0;
  const now = toMysqlDt(Date.now());
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    const placeholders = chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    const params = [];
    for (const r of chunk) {
      params.push(
        String(r.id),
        String(r.title),
        r.category != null ? String(r.category) : null,
        r.original_category != null ? String(r.original_category) : null,
        r.page_type != null ? String(r.page_type) : null,
        r.summary != null ? String(r.summary) : null,
        r.description != null ? String(r.description) : null,
        j(r.tags || []),
        r.preview_image_url != null ? String(r.preview_image_url) : null,
        r.preview_thumb_url != null ? String(r.preview_thumb_url) : null,
        r.image_preview_url != null ? String(r.image_preview_url) : null,
        r.source_url != null ? String(r.source_url) : null,
        r.demo_url != null ? String(r.demo_url) : null,
        Number(r.sort_order || 0),
        r.source != null ? String(r.source) : null,
        r.is_free,
        r.is_blindbox,
        r.member_only,
        r.active,
        Number(r.heat || 0),
        r.raw,
        r.created_at,
        now,
      );
    }
    const [res] = await conn.execute(
      `INSERT INTO prompt_cards (${columns.join(',')}) VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE ${update}`,
      params,
    );
    const cnt = res.affectedRows || 0;
    if (cnt > 0) {
      const newRows = cnt - 2; // INSERT=1, UPDATE=2
      if (newRows > 0) inserted += newRows;
      else updated += 1;
    }
    process.stdout.write(`\r  synced ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
  }
  return { inserted, updated };
}

async function upsertBodies(conn, rows) {
  const columns = ['card_id', 'prompt_text', 'prompt_text_length', 'prompt_hash', 'created_at', 'updated_at'];
  const update = columns
    .filter(col => col !== 'card_id' && col !== 'created_at')
    .map(col => `${col}=VALUES(${col})`)
    .join(', ');
  let inserted = 0, updated = 0;
  const now = toMysqlDt(Date.now());
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    const placeholders = chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    const params = [];
    for (const r of chunk) {
      params.push(
        String(r.id),
        String(r.prompt_text || ''),
        Number(r.prompt_text_length || 0),
        r.prompt_hash,
        r.created_at,
        now,
      );
    }
    const [res] = await conn.execute(
      `INSERT INTO prompt_card_bodies (${columns.join(',')}) VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE ${update}`,
      params,
    );
    const cnt = res.affectedRows || 0;
    if (cnt > 0) {
      const newRows = cnt - 2;
      if (newRows > 0) inserted += newRows;
      else updated += 1;
    }
  }
  return { inserted, updated };
}

async function printSummary(conn) {
  const [totalRows] = await conn.query('SELECT COUNT(*) AS total FROM prompt_cards');
  const [activeRows] = await conn.query('SELECT COUNT(*) AS cnt FROM prompt_cards WHERE active=1');
  const [freeRows] = await conn.query('SELECT COUNT(*) AS cnt FROM prompt_cards WHERE is_free=1');
  const [blindboxRows] = await conn.query('SELECT COUNT(*) AS cnt FROM prompt_cards WHERE is_blindbox=1');
  const [bodyRows] = await conn.query('SELECT COUNT(*) AS cnt FROM prompt_card_bodies');
  const [categoryRows] = await conn.query(
    'SELECT category, COUNT(*) AS cnt FROM prompt_cards GROUP BY category ORDER BY cnt DESC LIMIT 20'
  );

  console.log('\n[prompts] database summary:');
  console.log(`  total:      ${totalRows[0]?.total ?? 0}`);
  console.log(`  active:     ${activeRows[0]?.cnt ?? 0}`);
  console.log(`  free:       ${freeRows[0]?.cnt ?? 0}`);
  console.log(`  blindbox:   ${blindboxRows[0]?.cnt ?? 0}`);
  console.log(`  bodies:     ${bodyRows[0]?.cnt ?? 0}`);
  console.log('\n  top categories:');
  for (const row of categoryRows) {
    console.log(`    ${row.category}: ${row.cnt}`);
  }
}

async function main() {
  console.log('[prompts] reading source file...');
  const rawData = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));
  const items = Array.isArray(rawData) ? rawData : (rawData.prompts || rawData.items || []);
  console.log(`[prompts] source total: ${items.length}`);

  const rows = items.map((raw, i) => normalizePromptRecord(raw, i));
  console.log(`[prompts] normalized: ${rows.length}`);

  const conn = await mysql.createConnection(readConfig());
  await ensureTables(conn);

  console.log('\n[prompts] upserting prompt_cards...');
  const cardsResult = await upsertCards(conn, rows);

  console.log('\n\n[prompts] upserting prompt_card_bodies...');
  const bodiesResult = await upsertBodies(conn, rows);

  await printSummary(conn);
  await conn.end();

  console.log(`\n[prompts] done.`);
  console.log(`  cards inserted=${cardsResult.inserted}, updated=${cardsResult.updated}`);
  console.log(`  bodies inserted=${bodiesResult.inserted}, updated=${bodiesResult.updated}`);
}

main().catch(err => {
  console.error('[prompts] failed:', err);
  process.exit(1);
});
