// scripts/migrate-idea-prompts-to-mysql.mjs
//
// Sync public/static/* idea-library source JSON into MySQL `idea_prompts`.
// Safe to re-run: existing rows are updated, removed/obsolete rows can be
// deactivated, and the public API reads only active rows.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'public', 'static');

const IDEA_LIBRARY_SOURCES = {
  shorts: {
    label: 'AI 灵感库',
    files: ['aishort-prompts-top200.json'],
    source: 'shorts',
    idPrefix: 'short',
    defaultType: 'Short Prompt',
    defaultCategory: 'AI 灵感库',
  },
  imageIdeas: {
    label: 'IMG AI',
    files: ['meigen-prompts-top102.json', 'prompts-chat-image-top100.json'],
    source: 'image_ideas',
    idPrefix: 'img',
    defaultType: 'Image Idea',
    defaultCategory: '图片生成灵感',
  },
  videoIdeas: {
    label: 'VID AI',
    files: ['prompts-chat-video-top100.json'],
    source: 'video_ideas',
    idPrefix: 'vid',
    defaultType: 'Video Idea',
    defaultCategory: '视频生成灵感',
  },
  soloCompany: {
    label: '一人公司',
    files: ['one-company-lessons.json'],
    source: 'one_company',
    idPrefix: 'solo',
    defaultType: 'Solo Company Lesson',
    defaultCategory: '一人公司',
  },
};

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

function normalizeIdeaArray(input) {
  return Array.isArray(input)
    ? input
    : (Array.isArray(input?.items) ? input.items
      : Array.isArray(input?.prompts) ? input.prompts
        : Array.isArray(input?.data) ? input.data
          : []);
}

function readStaticJson(file) {
  const p = path.join(STATIC_DIR, file);
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return normalizeIdeaArray(raw);
}

function plainSnippet(value, max = 150) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function normalizeTagList(value) {
  if (Array.isArray(value)) return value.map(tag => String(tag).trim()).filter(Boolean);
  return String(value || '').split(/[,，、\s]+/).map(tag => tag.trim()).filter(Boolean);
}

function ideaSummary(raw, promptText, title) {
  const explicit = String(raw.summary || raw.description || '').trim();
  if (explicit && !/^[\s\n]*[\[{]/.test(explicit)) return plainSnippet(explicit, 150);
  return plainSnippet(promptText.replace(/[{}"[\],]/g, ' '), 150) || title;
}

function isRemovedIdeaRecord(raw) {
  const summary = String(raw?.summary || raw?.description || '').trim();
  return summary.includes('2023.06.10')
    && summary.includes('被降权');
}

function normalizeIdeaRecord(raw, index, kind, cfg, fileIndex) {
  const promptText = String(raw.prompt_text || raw.prompt || raw.content || raw.text || '').trim();
  const rawId = String(raw.id || `${cfg.idPrefix}-${String(index + 1).padStart(3, '0')}`).trim();
  const stableId = `${cfg.source}-${fileIndex}-${rawId}`.replace(/[^a-z0-9:_-]/gi, '-');
  const title = String(raw.title || raw.name || `${cfg.label} ${index + 1}`).trim();
  const coverUrl = String(raw.cover_url || raw.image_url || raw.thumbnail || raw.preview_image_url || '').trim();
  const videoUrl = String(raw.video_url || raw.preview_video_url || raw.playable_video_url || '').trim();
  const heat = Number(raw.heat ?? raw.likes ?? raw.views);
  return {
    id: stableId,
    kind,
    original_id: rawId,
    title,
    category: String(raw.category || raw.group || cfg.defaultCategory).trim(),
    type: String(raw.type || cfg.defaultType).trim(),
    page_type: String(raw.page_type || raw.topic || raw.scene || raw.category || cfg.defaultCategory).trim(),
    sort_order: Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : index + 1,
    source: cfg.source,
    prompt_text: promptText,
    prompt_text_length: promptText.length,
    heat: Number.isFinite(heat) ? heat : Math.max(120, 980 - index * 3),
    tags: normalizeTagList(raw.tags),
    summary: ideaSummary(raw, promptText, title),
    preview_image_url: coverUrl,
    preview_thumb_url: String(raw.preview_thumb_url || coverUrl).trim(),
    cover_url: coverUrl,
    preview_video_url: videoUrl,
    playable_video_url: videoUrl,
    raw,
    active: !isRemovedIdeaRecord(raw),
  };
}

function readIdeaPromptRows() {
  const out = [];
  for (const [kind, cfg] of Object.entries(IDEA_LIBRARY_SOURCES)) {
    const rawItems = [];
    cfg.files.forEach((file, fileIndex) => {
      readStaticJson(file).forEach((raw, index) => {
        const item = normalizeIdeaRecord(raw, rawItems.length + index, kind, cfg, fileIndex);
        if (item.title && item.prompt_text) rawItems.push(item);
      });
    });
    out.push(...rawItems);
  }
  return out;
}

async function ensureTable(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS idea_prompts (
    id                 VARCHAR(191) NOT NULL,
    kind               VARCHAR(32)  NOT NULL,
    original_id        VARCHAR(191) NULL,
    title              VARCHAR(255) NOT NULL,
    category           VARCHAR(191) NULL,
    type               VARCHAR(64)  NULL,
    page_type          VARCHAR(191) NULL,
    sort_order         INT NOT NULL DEFAULT 0,
    source             VARCHAR(64) NULL,
    prompt_text        LONGTEXT NOT NULL,
    prompt_text_length INT NOT NULL DEFAULT 0,
    heat               INT NOT NULL DEFAULT 0,
    tags               JSON NULL,
    summary            TEXT NULL,
    preview_image_url  TEXT NULL,
    preview_thumb_url  TEXT NULL,
    cover_url          TEXT NULL,
    preview_video_url  TEXT NULL,
    playable_video_url TEXT NULL,
    raw                JSON NULL,
    active             TINYINT(1) NOT NULL DEFAULT 1,
    created_at         DATETIME NOT NULL,
    updated_at         DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_idea_prompts_kind_active_sort (kind, active, sort_order),
    KEY idx_idea_prompts_original (original_id),
    KEY idx_idea_prompts_title (title)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function upsertRows(conn, rows) {
  const columns = [
    'id', 'kind', 'original_id', 'title', 'category', 'type', 'page_type',
    'sort_order', 'source', 'prompt_text', 'prompt_text_length', 'heat',
    'tags', 'summary', 'preview_image_url', 'preview_thumb_url', 'cover_url',
    'preview_video_url', 'playable_video_url', 'raw', 'active', 'created_at', 'updated_at',
  ];
  const update = columns
    .filter(col => col !== 'id' && col !== 'created_at')
    .map(col => `${col}=VALUES(${col})`)
    .join(', ');
  let affected = 0;
  const now = toMysqlDt(Date.now());
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    const placeholders = chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    const params = [];
    for (const r of chunk) {
      params.push(
        String(r.id),
        String(r.kind),
        r.original_id != null ? String(r.original_id) : null,
        String(r.title),
        r.category != null ? String(r.category) : null,
        r.type != null ? String(r.type) : null,
        r.page_type != null ? String(r.page_type) : null,
        Number(r.sort_order || 0),
        r.source != null ? String(r.source) : null,
        String(r.prompt_text || ''),
        Number(r.prompt_text_length || String(r.prompt_text || '').length),
        Number(r.heat || 0),
        j(r.tags || []),
        r.summary != null ? String(r.summary) : null,
        r.preview_image_url != null ? String(r.preview_image_url) : null,
        r.preview_thumb_url != null ? String(r.preview_thumb_url) : null,
        r.cover_url != null ? String(r.cover_url) : null,
        r.preview_video_url != null ? String(r.preview_video_url) : null,
        r.playable_video_url != null ? String(r.playable_video_url) : null,
        j(r.raw || {}),
        r.active ? 1 : 0,
        now,
        now,
      );
    }
    const [res] = await conn.execute(
      `INSERT INTO idea_prompts (${columns.join(',')}) VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE ${update}`,
      params,
    );
    affected += Number(res.affectedRows || 0);
    console.log(`  ✓ synced ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
  }
  return affected;
}

async function deactivateRemoved(conn) {
  if (!REMOVED_IDEA_TITLES.size) return 0;
  const [res] = await conn.query(
    `UPDATE idea_prompts SET active = 0, updated_at = ? WHERE title IN (${[...REMOVED_IDEA_TITLES].map(() => '?').join(',')})`,
    [toMysqlDt(Date.now()), ...REMOVED_IDEA_TITLES],
  );
  return Number(res.affectedRows || 0);
}

async function printSummary(conn) {
  const [rows] = await conn.query(
    `SELECT kind, COUNT(*) AS total, SUM(active = 1) AS active_count
       FROM idea_prompts
      GROUP BY kind
      ORDER BY kind`,
  );
  console.log('\n[ideas] database summary:');
  for (const row of rows) {
    console.log(`  ${row.kind}: ${row.active_count}/${row.total} active`);
  }
}

async function main() {
  const conn = await mysql.createConnection(readConfig());
  await ensureTable(conn);
  const rows = readIdeaPromptRows();
  console.log(`[ideas] source rows: ${rows.length}`);
  const affected = await upsertRows(conn, rows);
  const deactivated = await deactivateRemoved(conn);
  await printSummary(conn);
  await conn.end();
  console.log(`\n[ideas] done. affected=${affected}, obsolete_deactivated=${deactivated}`);
}

main().catch(err => {
  console.error('[ideas] failed:', err);
  process.exit(1);
});
