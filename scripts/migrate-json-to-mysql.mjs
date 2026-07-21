// scripts/migrate-json-to-mysql.mjs
//
// One-shot importer: reads data/*.json and inserts every row into MySQL.
//
// Idempotent — re-running never creates duplicates:
//   - Every insert uses `INSERT IGNORE` so a primary-key collision is a no-op.
//   - Counts in the summary report the number of NEW rows actually inserted.
//     The number of pre-existing rows is reported separately for sanity.
//
//   npm run db:migrate
//
// Notes:
//   - The JSON files under data/ stay on disk after the migration. We only
//     stop reading them at runtime; removing them is an explicit ops step.
//   - `appendLog` tables (security_event, login_risk, user_behavior_log) can
//     be huge. We import them in chunks and skip the `payload` column for
//     already-known fields.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
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
};

const REMOVED_IDEA_TITLES = new Set([
  '无限制的 ChatGPT（降权）',
]);

function readConfig() {
  const base = {
    // dateStrings keeps the import side clean: we always read ISO strings from
    // the JSON files and feed them straight to the time-coercion helpers.
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

const cfg = readConfig();

// ---- Read helpers ----
function readJson(name) {
  const p = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.codes)) return raw.codes;
    if (Array.isArray(raw.accounts)) return raw.accounts;
    if (Array.isArray(raw.announcements)) return raw.announcements;
    return [];
  } catch (err) {
    console.warn(`[migrate] WARN: failed to read ${p}: ${err.message}`);
    return [];
  }
}

function readStaticJson(file) {
  const p = path.join(STATIC_DIR, file);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return normalizeIdeaArray(raw);
  } catch (err) {
    console.warn(`[migrate] WARN: failed to read ${p}: ${err.message}`);
    return [];
  }
}

function normalizeIdeaArray(input) {
  return Array.isArray(input)
    ? input
    : (Array.isArray(input?.items) ? input.items
      : Array.isArray(input?.prompts) ? input.prompts
        : Array.isArray(input?.data) ? input.data
          : []);
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
  const title = String(raw?.title || raw?.name || '').trim();
  if (REMOVED_IDEA_TITLES.has(title)) return true;
  const summary = String(raw?.summary || raw?.description || '').trim();
  return title.includes('无限制的 ChatGPT')
    && summary.includes('2023.06.10')
    && summary.includes('被降权');
}

function normalizeIdeaRecord(raw, index, kind, cfg, fileIndex) {
  const promptText = String(raw.prompt_text || raw.prompt || raw.content || raw.text || '').trim();
  const rawId = String(raw.id || `${cfg.idPrefix}-${String(index + 1).padStart(3, '0')}`).trim();
  const stableId = `${cfg.source}-${fileIndex}-${rawId}`.replace(/[^a-z0-9:_-]/gi, '-');
  const rawTitle = String(raw.title || raw.name || `${cfg.label} ${index + 1}`).trim();
  const coverUrl = String(raw.cover_url || raw.image_url || raw.thumbnail || raw.preview_image_url || '').trim();
  const videoUrl = String(raw.video_url || raw.preview_video_url || raw.playable_video_url || '').trim();
  const heat = Number(raw.heat ?? raw.likes ?? raw.views);
  return {
    id: stableId,
    kind,
    original_id: rawId,
    title: rawTitle,
    category: String(raw.category || raw.group || cfg.defaultCategory).trim(),
    type: String(raw.type || cfg.defaultType).trim(),
    page_type: String(raw.page_type || raw.topic || raw.scene || raw.category || cfg.defaultCategory).trim(),
    sort_order: Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : index + 1,
    source: cfg.source,
    prompt_text: promptText,
    prompt_text_length: promptText.length,
    heat: Number.isFinite(heat) ? heat : Math.max(120, 980 - index * 3),
    tags: normalizeTagList(raw.tags),
    summary: ideaSummary(raw, promptText, rawTitle),
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
      const fileRows = readStaticJson(file);
      fileRows.forEach((raw, index) => {
        const item = normalizeIdeaRecord(raw, rawItems.length + index, kind, cfg, fileIndex);
        if (item.title && item.prompt_text) rawItems.push(item);
      });
    });
    out.push(...rawItems);
  }
  return out;
}

// Convert any datetime-ish field to MySQL `YYYY-MM-DD HH:mm:ss`. Numbers
// (epoch millis) become UTC. Strings are accepted if they parse via Date.
function toMysqlDt(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 19).replace('T', ' ');
  const d = new Date(String(v));
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  return null;
}

// Treat known booleans from JSON as 0/1 ints for MySQL TINYINT.
function b(v) { return v ? 1 : 0; }

// Encode JS objects for MySQL JSON columns. mysql2 accepts objects directly
// but we stringify so the SQL trace is easy to read.
function j(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return null; }
}

// ---- Per-table row builders ----
//
// Each builder returns either:
//   - null  → skip this JSON row (no id, etc.)
//   - { sql, params } for a single INSERT IGNORE
//
// Anything not directly mapped is folded into `payload` JSON so we don't
// lose information; this matters for the append-log tables.

function buildAccounts(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    out.push({
      sql: `INSERT IGNORE INTO accounts
        (id, username, password_hash, kind, promoted_from_code, note,
         membership_years, activated_at, expires_at, created_at, updated_at,
         last_login_at, login_count, revoked)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        String(r.id),
        String(r.username || ''),
        String(r.password_hash || ''),
        r.kind != null ? String(r.kind) : null,
        r.promoted_from_code != null ? String(r.promoted_from_code) : null,
        r.note != null ? String(r.note) : null,
        r.membership_years != null ? Number(r.membership_years) : null,
        toMysqlDt(r.activated_at),
        toMysqlDt(r.expires_at),
        toMysqlDt(r.created_at) || toMysqlDt(Date.now()),
        toMysqlDt(r.updated_at),
        toMysqlDt(r.last_login_at),
        Number(r.login_count || 0),
        b(r.revoked),
      ],
    });
  }
  return out;
}

function buildCodes(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    out.push({
      sql: `INSERT IGNORE INTO codes
        (id, code_hash, label, note, revoked, created_at, updated_at,
         last_used_at, use_count, login_disabled, consumed_for_account,
         consumed_at, membership_years, activated_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        String(r.id),
        String(r.hash || r.code_hash || ''),
        r.label != null ? String(r.label) : null,
        r.note != null ? String(r.note) : null,
        b(r.revoked),
        toMysqlDt(r.created_at) || toMysqlDt(Date.now()),
        toMysqlDt(r.updated_at),
        toMysqlDt(r.last_used_at),
        Number(r.use_count || 0),
        b(r.login_disabled),
        r.consumed_for_account != null ? String(r.consumed_for_account) : null,
        toMysqlDt(r.consumed_at),
        r.membership_years != null ? Number(r.membership_years) : null,
        toMysqlDt(r.activated_at),
        toMysqlDt(r.expires_at),
      ],
    });
  }
  return out;
}

const DEVICE_FIXED = ['id', 'user_id', 'device_id', 'device_type', 'browser', 'os', 'ip', 'country', 'location', 'last_active_time', 'created_at', 'updated_at'];
function buildUserDevice(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    const payload = {};
    for (const k of Object.keys(r)) if (!DEVICE_FIXED.includes(k)) payload[k] = r[k];
    out.push({
      sql: `INSERT IGNORE INTO user_device
        (id, user_id, device_id, device_type, browser, os, ip, country,
         location, last_active_time, created_at, updated_at, payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        String(r.id),
        r.user_id != null ? String(r.user_id) : null,
        r.device_id != null ? String(r.device_id) : null,
        r.device_type != null ? String(r.device_type) : null,
        r.browser != null ? String(r.browser) : null,
        r.os != null ? String(r.os) : null,
        r.ip != null ? String(r.ip) : null,
        r.country != null ? String(r.country) : null,
        r.location != null ? String(r.location) : null,
        toMysqlDt(r.last_active_time),
        toMysqlDt(r.created_at) || toMysqlDt(Date.now()),
        toMysqlDt(r.updated_at),
        Object.keys(payload).length ? j(payload) : null,
      ],
    });
  }
  return out;
}

const SESSION_FIXED = ['id', 'jti', 'user_id', 'device_id', 'ip', 'ua', 'expires_at', 'revoked', 'revoked_at', 'created_at', 'updated_at'];
function buildUserSession(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    const payload = {};
    for (const k of Object.keys(r)) if (!SESSION_FIXED.includes(k)) payload[k] = r[k];
    out.push({
      sql: `INSERT IGNORE INTO user_session
        (id, jti, user_id, device_id, ip, ua, expires_at, revoked,
         revoked_at, created_at, updated_at, payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        String(r.id),
        r.jti != null ? String(r.jti) : null,
        r.user_id != null ? String(r.user_id) : null,
        r.device_id != null ? String(r.device_id) : null,
        r.ip != null ? String(r.ip) : null,
        r.ua != null ? String(r.ua) : null,
        toMysqlDt(r.expires_at),
        b(r.revoked),
        toMysqlDt(r.revoked_at),
        toMysqlDt(r.created_at) || toMysqlDt(Date.now()),
        toMysqlDt(r.updated_at),
        Object.keys(payload).length ? j(payload) : null,
      ],
    });
  }
  return out;
}

function buildCaptcha(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    const FIXED = ['id', 'answer_hash', 'answer', 'image', 'sig', 'expires_at', 'consumed', 'consumed_at', 'created_at', 'updated_at'];
    const payload = {};
    for (const k of Object.keys(r)) if (!FIXED.includes(k)) payload[k] = r[k];
    out.push({
      sql: `INSERT IGNORE INTO captcha_challenge
        (id, answer_hash, image, sig, expires_at, consumed, consumed_at,
         created_at, updated_at, payload)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      params: [
        String(r.id),
        String(r.answer_hash || r.answer || ''),
        r.image != null ? String(r.image) : null,
        r.sig != null ? String(r.sig) : null,
        toMysqlDt(r.expires_at),
        b(r.consumed),
        toMysqlDt(r.consumed_at),
        toMysqlDt(r.created_at) || toMysqlDt(Date.now()),
        toMysqlDt(r.updated_at),
        Object.keys(payload).length ? j(payload) : null,
      ],
    });
  }
  return out;
}

const CONTENT_TOKEN_FIXED = ['id', 'token_hash', 'user_id', 'device_id', 'ip', 'resource', 'token', 'expires_at', 'consumed', 'consumed_at', 'used', 'used_at', 'created_at', 'updated_at'];
function buildContentToken(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    const payload = {};
    for (const k of Object.keys(r)) if (!CONTENT_TOKEN_FIXED.includes(k)) payload[k] = r[k];
    out.push({
      sql: `INSERT IGNORE INTO content_token
        (id, token_hash, user_id, device_id, ip, resource, token,
         expires_at, consumed, consumed_at, used, used_at,
         created_at, updated_at, payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        String(r.id),
        r.token_hash != null ? String(r.token_hash) : null,
        r.user_id != null ? String(r.user_id) : null,
        r.device_id != null ? String(r.device_id) : null,
        r.ip != null ? String(r.ip) : null,
        r.resource != null ? String(r.resource) : null,
        r.token != null ? String(r.token) : null,
        toMysqlDt(r.expires_at),
        b(r.consumed),
        toMysqlDt(r.consumed_at),
        b(r.used),
        toMysqlDt(r.used_at),
        toMysqlDt(r.created_at) || toMysqlDt(Date.now()),
        toMysqlDt(r.updated_at),
        Object.keys(payload).length ? j(payload) : null,
      ],
    });
  }
  return out;
}

function buildIpBlock(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    out.push({
      sql: `INSERT IGNORE INTO ip_block (id, ip, reason, expires_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?)`,
      params: [
        String(r.id),
        String(r.ip || ''),
        r.reason != null ? String(r.reason) : null,
        toMysqlDt(r.expires_at),
        toMysqlDt(r.created_at) || toMysqlDt(Date.now()),
        toMysqlDt(r.updated_at),
      ],
    });
  }
  return out;
}

function buildSecurityEvent(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    const FIXED = ['id', 'ts', 'type', 'created_at'];
    const payload = {};
    for (const k of Object.keys(r)) if (!FIXED.includes(k)) payload[k] = r[k];
    out.push({
      sql: `INSERT IGNORE INTO security_event (id, ts, type, payload, created_at)
        VALUES (?,?,?,?,?)`,
      params: [
        String(r.id),
        r.ts != null ? Number(r.ts) : Date.now(),
        r.type != null ? String(r.type) : null,
        Object.keys(payload).length ? j(payload) : null,
        toMysqlDt(r.created_at) || toMysqlDt(r.ts ? Number(r.ts) : Date.now()),
      ],
    });
  }
  return out;
}

function buildLoginRisk(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    const FIXED = ['id', 'ts', 'type', 'user_id', 'ip', 'score', 'created_at'];
    const payload = {};
    for (const k of Object.keys(r)) if (!FIXED.includes(k)) payload[k] = r[k];
    out.push({
      sql: `INSERT IGNORE INTO login_risk (id, ts, type, user_id, ip, reasons, score, payload, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      params: [
        String(r.id),
        r.ts != null ? Number(r.ts) : Date.now(),
        r.type != null ? String(r.type) : null,
        r.user_id != null ? String(r.user_id) : null,
        r.ip != null ? String(r.ip) : null,
        Array.isArray(r.reasons) ? j(r.reasons) : null,
        r.score != null ? Number(r.score) : null,
        Object.keys(payload).length ? j(payload) : null,
        toMysqlDt(r.created_at) || toMysqlDt(r.ts ? Number(r.ts) : Date.now()),
      ],
    });
  }
  return out;
}

const BEH_FIXED = ['id', 'ts', 'user_id', 'device_id', 'ip', 'path', 'cls', 'created_at'];
function buildUserBehavior(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    const payload = {};
    for (const k of Object.keys(r)) if (!BEH_FIXED.includes(k)) payload[k] = r[k];
    out.push({
      sql: `INSERT IGNORE INTO user_behavior_log
        (id, ts, user_id, device_id, ip, path, cls, payload, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      params: [
        String(r.id),
        r.ts != null ? Number(r.ts) : Date.now(),
        r.user_id != null ? String(r.user_id) : null,
        r.device_id != null ? String(r.device_id) : null,
        r.ip != null ? String(r.ip) : null,
        r.path != null ? String(r.path) : null,
        r.cls != null ? String(r.cls) : (r.api != null ? String(r.api) : null),
        Object.keys(payload).length ? j(payload) : null,
        toMysqlDt(r.created_at) || toMysqlDt(r.ts ? Number(r.ts) : Date.now()),
      ],
    });
  }
  return out;
}

function buildAnnouncements(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    out.push({
      sql: `INSERT IGNORE INTO announcements
        (id, kind, title, body, enabled, pinned, active, starts_at,
         ends_at, expires_at, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        String(r.id),
        r.kind != null ? String(r.kind) : 'info',
        r.title != null ? String(r.title) : '',
        r.body != null ? String(r.body) : '',
        // `active` was the JSON shape; map it to `enabled` AND keep `active`
        // in the column for backwards compat with listActive().
        b(r.enabled != null ? r.enabled : true),
        b(r.pinned),
        b(r.active != null ? r.active : true),
        toMysqlDt(r.starts_at),
        toMysqlDt(r.ends_at),
        toMysqlDt(r.expires_at),
        r.created_by != null ? String(r.created_by) : null,
        toMysqlDt(r.created_at) || toMysqlDt(Date.now()),
        toMysqlDt(r.updated_at),
      ],
    });
  }
  return out;
}

function buildIdeaPrompts(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.id || !r.kind || !r.title || !r.prompt_text) continue;
    out.push({
      sql: `INSERT INTO idea_prompts
        (id, kind, original_id, title, category, type, page_type, sort_order,
         source, prompt_text, prompt_text_length, heat, tags, summary,
         preview_image_url, preview_thumb_url, cover_url, preview_video_url,
         playable_video_url, raw, active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          kind=VALUES(kind),
          original_id=VALUES(original_id),
          title=VALUES(title),
          category=VALUES(category),
          type=VALUES(type),
          page_type=VALUES(page_type),
          sort_order=VALUES(sort_order),
          source=VALUES(source),
          prompt_text=VALUES(prompt_text),
          prompt_text_length=VALUES(prompt_text_length),
          heat=VALUES(heat),
          tags=VALUES(tags),
          summary=VALUES(summary),
          preview_image_url=VALUES(preview_image_url),
          preview_thumb_url=VALUES(preview_thumb_url),
          cover_url=VALUES(cover_url),
          preview_video_url=VALUES(preview_video_url),
          playable_video_url=VALUES(playable_video_url),
          raw=VALUES(raw),
          active=VALUES(active),
          updated_at=VALUES(updated_at)`,
      params: [
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
        b(r.active),
        toMysqlDt(Date.now()),
        toMysqlDt(Date.now()),
      ],
    });
  }
  return out;
}

// ---- Driver ----

const PLAN = [
  { table: 'accounts',          build: buildAccounts },
  { table: 'codes',             build: buildCodes },
  { table: 'user_device',       build: buildUserDevice },
  { table: 'user_session',      build: buildUserSession },
  { table: 'captcha_challenge', build: buildCaptcha },
  { table: 'content_token',     build: buildContentToken },
  { table: 'ip_block',          build: buildIpBlock },
  { table: 'security_event',    build: buildSecurityEvent },
  { table: 'login_risk',        build: buildLoginRisk },
  { table: 'user_behavior_log', build: buildUserBehavior },
  { table: 'announcements',     build: buildAnnouncements },
  { table: 'idea_prompts',      build: buildIdeaPrompts, read: readIdeaPromptRows },
];

async function migrateTable(conn, table, stmts) {
  let inserted = 0;
  let skipped = 0;
  // Wrap the whole table in a single transaction so a partial failure doesn't
  // leave half-imported rows.
  await conn.beginTransaction();
  try {
    for (const { sql, params } of stmts) {
      const [res] = await conn.execute(sql, params);
      if (res.affectedRows === 1) inserted++;
      else skipped++; // INSERT IGNORE/UPSERT unchanged duplicate
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }
  return { inserted, skipped };
}

async function main() {
  const conn = await mysql.createConnection(cfg);
  const summary = [];
  for (const { table, build, read } of PLAN) {
    const rows = read ? read() : readJson(table);
    if (!rows.length) {
      summary.push({ table, source: 0, inserted: 0, skipped: 0 });
      continue;
    }
    const stmts = build(rows);
    if (!stmts.length) {
      summary.push({ table, source: rows.length, inserted: 0, skipped: 0 });
      continue;
    }
    const { inserted, skipped } = await migrateTable(conn, table, stmts);
    summary.push({ table, source: rows.length, inserted, skipped });
    console.log(`  ✓ ${table}: ${inserted} inserted, ${skipped} already present (source ${rows.length})`);
  }
  if (REMOVED_IDEA_TITLES.size) {
    const [res] = await conn.query(
      `UPDATE idea_prompts SET active = 0, updated_at = ? WHERE title IN (${[...REMOVED_IDEA_TITLES].map(() => '?').join(',')})`,
      [toMysqlDt(Date.now()), ...REMOVED_IDEA_TITLES],
    );
    console.log(`  ✓ idea_prompts: ${res.affectedRows || 0} obsolete item(s) deactivated`);
  }
  await conn.end();

  console.log('\n[migrate] summary:');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad('table', 22)}${pad('source', 10)}${pad('inserted', 10)}${pad('skipped', 10)}`);
  for (const r of summary) {
    console.log(`  ${pad(r.table, 22)}${pad(r.source, 10)}${pad(r.inserted, 10)}${pad(r.skipped, 10)}`);
  }
  console.log('\n[migrate] done.');
}

main().catch(err => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
