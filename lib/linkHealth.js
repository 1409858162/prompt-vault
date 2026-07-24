import crypto from 'node:crypto';
import { query as mysqlQuery, toMysqlDt } from './mysql.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.LINK_HEALTH_TIMEOUT_MS || 7000);
const DEFAULT_CONCURRENCY = Number(process.env.LINK_HEALTH_CONCURRENCY || 6);
const MAX_SCAN_ITEMS = Number(process.env.LINK_HEALTH_MAX_ITEMS || 500);
const MAX_LINKS_PER_SCAN = Number(process.env.LINK_HEALTH_MAX_LINKS || 1200);

let tableReady = false;

export async function ensureLinkHealthTable() {
  if (tableReady) return;
  await mysqlQuery(`CREATE TABLE IF NOT EXISTS link_health_checks (
    id BIGINT NOT NULL AUTO_INCREMENT,
    content_type VARCHAR(32) NOT NULL,
    content_id VARCHAR(191) NOT NULL,
    title VARCHAR(255) NULL,
    field_name VARCHAR(64) NOT NULL,
    url TEXT NOT NULL,
    url_hash CHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    http_status INT NULL,
    content_type_header VARCHAR(191) NULL,
    error_message TEXT NULL,
    duration_ms INT NULL,
    checked_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_link_health_latest (content_type, content_id, url_hash),
    KEY idx_link_health_status_checked (status, checked_at),
    KEY idx_link_health_content (content_type, content_id),
    KEY idx_link_health_checked (checked_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, []);
  tableReady = true;
}

export function extractHttpUrls(text) {
  if (!text) return [];
  const found = String(text).match(/https?:\/\/[^\s"'`<>]+/g) || [];
  const cleaned = found
    .map(u => u.trim().replace(/\\u0026/gi, '&').replace(/[\]}>）】。；;，,.)]+$/g, ''))
    .map(u => u.replace(/&amp;/g, '&'))
    .filter(u => {
      try {
        const parsed = new URL(u);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    });
  return [...new Set(cleaned)];
}

function urlHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function boolishStatus(httpStatus) {
  if (!httpStatus) return 'unknown';
  if (httpStatus >= 200 && httpStatus < 400) return 'ok';
  if (httpStatus === 401 || httpStatus === 403) return 'blocked';
  if (httpStatus === 404 || httpStatus === 410) return 'missing';
  if (httpStatus >= 400) return 'broken';
  return 'unknown';
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function checkOneUrl(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const headers = {
    'User-Agent': 'Mozilla/5.0 PromptVault-LinkHealth/1.0',
    'Accept': '*/*',
  };
  try {
    let response;
    try {
      response = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow', headers }, timeoutMs);
      // Some CDNs reject HEAD even when GET works.
      if ([405, 406, 501].includes(response.status)) throw new Error(`HEAD_NOT_ALLOWED_${response.status}`);
    } catch (headErr) {
      response = await fetchWithTimeout(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { ...headers, Range: 'bytes=0-0' },
      }, timeoutMs);
    }
    const durationMs = Date.now() - started;
    return {
      status: boolishStatus(response.status),
      http_status: response.status,
      content_type_header: response.headers.get('content-type') || null,
      error_message: null,
      duration_ms: durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const isTimeout = err?.name === 'AbortError' || /abort|timeout/i.test(err?.message || '');
    return {
      status: isTimeout ? 'timeout' : 'error',
      http_status: null,
      content_type_header: null,
      error_message: String(err?.message || err).slice(0, 500),
      duration_ms: durationMs,
    };
  }
}

function addUrl(list, seen, item, fieldName, url) {
  if (!url) return;
  for (const u of extractHttpUrls(url)) {
    const key = `${item.content_type}|${item.content_id}|${u}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      content_type: item.content_type,
      content_id: item.content_id,
      title: item.title || null,
      field_name: fieldName,
      url: u,
      url_hash: urlHash(u),
    });
  }
}

function collectUrlsFromRows(rows) {
  const out = [];
  const seen = new Set();
  for (const item of rows) {
    for (const [field, value] of Object.entries(item.fields || {})) {
      addUrl(out, seen, item, field, value);
      if (out.length >= MAX_LINKS_PER_SCAN) return out;
    }
  }
  return out;
}

export async function loadContentForScan({ scope = 'all', limit = 100, q = '' } = {}) {
  const safeLimit = Math.min(MAX_SCAN_ITEMS, Math.max(1, Number(limit) || 100));
  const like = `%${q || ''}%`;
  const rows = [];

  if (scope === 'all' || scope === 'cards') {
    const params = q ? [like, like] : [];
    const where = q ? 'WHERE (c.title LIKE ? OR c.id LIKE ?)' : '';
    const cards = await mysqlQuery(
      `SELECT c.id, c.title, c.preview_image_url, c.preview_thumb_url, c.image_preview_url,
              c.source_url, c.demo_url, b.prompt_text
         FROM prompt_cards c
         LEFT JOIN prompt_card_bodies b ON b.card_id = c.id
         ${where}
         ORDER BY COALESCE(c.updated_at, c.created_at) DESC
         LIMIT ${safeLimit}`,
      params
    );
    rows.push(...cards.map(r => ({
      content_type: 'card',
      content_id: r.id,
      title: r.title,
      fields: {
        preview_image_url: r.preview_image_url,
        preview_thumb_url: r.preview_thumb_url,
        image_preview_url: r.image_preview_url,
        source_url: r.source_url,
        demo_url: r.demo_url,
        prompt_text: r.prompt_text,
      },
    })));
  }

  if (scope === 'all' || scope === 'ideas') {
    const params = q ? [like, like] : [];
    const where = q ? 'WHERE (title LIKE ? OR id LIKE ?)' : '';
    const ideas = await mysqlQuery(
      `SELECT id, title, preview_image_url, preview_thumb_url, cover_url,
              preview_video_url, playable_video_url, prompt_text
         FROM idea_prompts
         ${where}
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT ${safeLimit}`,
      params
    );
    rows.push(...ideas.map(r => ({
      content_type: 'idea',
      content_id: r.id,
      title: r.title,
      fields: {
        preview_image_url: r.preview_image_url,
        preview_thumb_url: r.preview_thumb_url,
        cover_url: r.cover_url,
        preview_video_url: r.preview_video_url,
        playable_video_url: r.playable_video_url,
        prompt_text: r.prompt_text,
      },
    })));
  }

  if (scope === 'all' || scope === 'tutorials') {
    const params = q ? [like, like] : [];
    const where = q ? 'WHERE (title LIKE ? OR id LIKE ?)' : '';
    const tutorials = await mysqlQuery(
      `SELECT id, title, video_url, external_url, cover_url
         FROM tutorials
         ${where}
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT ${safeLimit}`,
      params
    );
    rows.push(...tutorials.map(r => ({
      content_type: 'tutorial',
      content_id: r.id,
      title: r.title,
      fields: {
        video_url: r.video_url,
        external_url: r.external_url,
        cover_url: r.cover_url,
      },
    })));
  }

  return rows;
}

async function upsertResult(link, result) {
  const now = toMysqlDt(Date.now());
  await mysqlQuery(
    `INSERT INTO link_health_checks
       (content_type, content_id, title, field_name, url, url_hash, status, http_status,
        content_type_header, error_message, duration_ms, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       title=VALUES(title), field_name=VALUES(field_name), url=VALUES(url),
       status=VALUES(status), http_status=VALUES(http_status),
       content_type_header=VALUES(content_type_header), error_message=VALUES(error_message),
       duration_ms=VALUES(duration_ms), checked_at=VALUES(checked_at)`,
    [
      link.content_type, link.content_id, link.title, link.field_name, link.url, link.url_hash,
      result.status, result.http_status, result.content_type_header, result.error_message,
      result.duration_ms, now,
    ]
  );
}

export async function scanLinkHealth(options = {}) {
  await ensureLinkHealthTable();
  const timeoutMs = Math.min(20000, Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const concurrency = Math.min(12, Math.max(1, Number(options.concurrency) || DEFAULT_CONCURRENCY));
  const rows = await loadContentForScan(options);
  const links = collectUrlsFromRows(rows);
  const stats = { ok: 0, blocked: 0, missing: 0, broken: 0, timeout: 0, error: 0, unknown: 0 };
  let cursor = 0;

  async function worker() {
    while (cursor < links.length) {
      const link = links[cursor++];
      const result = await checkOneUrl(link.url, { timeoutMs });
      stats[result.status] = (stats[result.status] || 0) + 1;
      await upsertResult(link, result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, () => worker()));
  return { checked: links.length, content_items: rows.length, stats };
}

export async function listLinkHealth({ status = 'all', contentType = 'all', q = '', page = 1, limit = 50, sort = 'checked_desc' } = {}) {
  await ensureLinkHealthTable();
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(limit) || 50));
  const offset = (pageNum - 1) * limitNum;
  const conditions = [];
  const params = [];
  if (status && status !== 'all') {
    if (status === 'bad') conditions.push(`status IN ('blocked','missing','broken','timeout','error','unknown')`);
    else { conditions.push('status = ?'); params.push(status); }
  }
  if (contentType && contentType !== 'all') {
    conditions.push('content_type = ?');
    params.push(contentType);
  }
  if (q) {
    conditions.push('(title LIKE ? OR content_id LIKE ? OR url LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = sort === 'checked_asc' ? 'checked_at ASC' : 'checked_at DESC';
  const countRows = await mysqlQuery(`SELECT COUNT(*) AS total FROM link_health_checks ${where}`, params);
  const total = Number(countRows[0]?.total || 0);
  const items = await mysqlQuery(
    `SELECT content_type, content_id, title, field_name, url, status, http_status,
            content_type_header, error_message, duration_ms, checked_at
       FROM link_health_checks ${where}
       ORDER BY ${orderBy}
       LIMIT ${limitNum} OFFSET ${offset}`,
    params
  );
  const summaryRows = await mysqlQuery(
    `SELECT status, COUNT(*) AS count FROM link_health_checks GROUP BY status`,
    []
  );
  const summary = Object.fromEntries(summaryRows.map(r => [r.status, Number(r.count || 0)]));
  return { total, page: pageNum, limit: limitNum, items, summary };
}
