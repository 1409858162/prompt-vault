// Prompt Vault — invite-code-gated prompt browser.
// Production-hardened edition: anti-scrape, anti-leak, watermarking, device binding.
//
// Stack: Node.js + Express + JWT + bcryptjs + cookie-parser + JSON storage.
// Migration path to Spring Boot: the 8 security services in lib/* correspond
// 1:1 to @Service beans; the routes below correspond 1:1 to @RestController.
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import * as accounts from './lib/accounts.js';
import * as db from './lib/db.js';
import { take, countInWindow, recordHit } from './lib/rateLimit.js';
import { parseUA, countryFromIp, deriveDeviceId, getClientIp } from './lib/device.js';
import {
  evaluateLoginRisk, registerDevice, listDevices, kickDevice,
  recordSession, isSessionRevoked, revokeAllSessionsForUser, isIpBlocked,
} from './lib/risk.js';
import { issueCaptcha, verifyCaptcha } from './lib/captcha.js';
import * as announcements from './lib/announcements.js';
import * as messages from './lib/messages.js';
import { inspect, autoBan } from './lib/behavior.js';
import {
  getMembershipStatus, resolveAccountMembership, formatExpiresLabel, activationPatch,
  addYears, DEFAULT_MEMBERSHIP_YEARS, isLegacyPermanent,
} from './lib/membership.js';
import {
  issueContentToken, consumeContentToken,
  signDownloadUrl, verifyDownloadSignature,
  issueVideoKey, issueVideoKeyToken, verifyVideoKeyToken,
} from './lib/contentToken.js';
import { describeConnection, query as mysqlQuery, toMysqlDt, transaction } from './lib/mysql.js';
import { listLinkHealth, scanLinkHealth } from './lib/linkHealth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Fail-open secrets: in production, log a loud warning instead of crashing
// so an incomplete env-var config doesn't take the whole deployment down.
// The warning surfaces on every redeploy in the Vercel build logs, and the
// random per-process secret is at least as strong as the dev fallback.
const JWT_SECRET = process.env.JWT_SECRET || (!IS_PRODUCTION
  ? 'dev-jwt-secret-change-me'
  : (globalThis.__pv_secret || (globalThis.__pv_secret = crypto.randomBytes(48).toString('base64url'))));
if (!process.env.JWT_SECRET && IS_PRODUCTION) {
  console.warn('[config] JWT_SECRET not set — using random in-process secret. Tokens will NOT survive a cold restart. Set the env var in Vercel → Settings → Environment Variables.');
}
const ADMIN_USER_IDS = new Set(
  String(process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const ADMIN_USERNAMES = new Set(
  String(process.env.ADMIN_USERNAMES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const HONEYPOT_TEST_USER_IDS = new Set(
  String(process.env.HONEYPOT_TEST_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const HONEYPOT_TEST_USERNAMES = new Set(
  String(process.env.HONEYPOT_TEST_USERNAMES || 'xugeceshi')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const COOKIE_NAME = 'pv_session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (re-issued on each login)
const DECOY_COOKIE_NAME = 'pv_decoy_until';
const MAX_REGISTER_ACCOUNTS_PER_IDENTITY = Math.max(1, Number(process.env.MAX_REGISTER_ACCOUNTS_PER_IDENTITY || 2));
const ACCOUNT_BANNED_TITLE = '你的账号已被封禁';
const ACCOUNT_BANNED_MESSAGE = [
  '系统检测到该账号存在批量读取、自动化抓取、绕过访问限制或触发蜜罐检测等异常行为。',
  '本站内容不是供人无偿爬取、搬运、倒卖的数据仓库。这里的提示词经过长期整理、筛选、归类和维护，本身已经以很低的价格开放给大家使用，目的就是让更多人用得起高质量提示词。',
  '整理这些内容需要投入大量时间和精力，服务器维护也需要持续成本。我们收取的费用只是为了覆盖基本运营，让这个站点可以继续稳定更新下去，而不是给恶意抓取、批量复制和倒卖行为提供便利。',
  '试图绕过规则获取他人劳动成果，不是聪明，也不是本事，而是对创作者、整理者和正常付费用户的不尊重。',
  '因此，该账号已被限制访问，无法继续查看或复制提示词正文。',
  '如认为封禁有误，请联系管理员申请复核。',
];

const app = express();
const TRUST_PROXY = process.env.TRUST_PROXY ?? (IS_PRODUCTION ? '1' : 'true');
app.set('trust proxy', TRUST_PROXY === 'true' ? true : TRUST_PROXY === 'false' ? false : Number(TRUST_PROXY) || TRUST_PROXY);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(cookieParser());

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      if (err) {
        console.error('[asyncHandler] Error:', err.message);
      }
      next(err);
    });
  };
}

// Disable Express's automatic ETag for JSON API routes (they send 304 with no
// body, which breaks r.json() on the client). Static files can keep ETag.
app.set('etag', false);

// Security response headers — baseline
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // CSP for SPA. Inline scripts are allowed because both /app and /me keep
  // their main bootstrap as a literal <script> block in the markup (the
  // project deliberately avoids a build step). The web portal builds hashed
  // bundles and runs under the same CSP — those routes get the stricter
  // policy by not serving inline HTML. style-src allows googleapis so the
  // Inter/JetBrains Mono stylesheet from <link rel="stylesheet"> loads.
  // style-src-elem is set explicitly to avoid falling back to the older
  // style-src semantics in browsers that distinguish the two.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

// Locally mirrored imported-library covers/videos.
//
// Keep this route before the auth / IP-block middleware below: these files are
// public card covers only (no prompt bodies), and making every image request
// hit TiDB for cookie/IP checks can make the grid feel stuck when dozens of
// cards load at once. The more generic `/assets` route near the bottom is only
// for the login portal bundle, so imported assets need their own mount.
app.use('/assets/imported-libraries', express.static(path.join(__dirname, 'public', 'assets', 'imported-libraries'), {
  maxAge: '30d',
  immutable: true,
  index: false,
  fallthrough: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));
app.use('/assets/imported-safe', express.static(path.join(__dirname, 'public', 'assets', 'imported-safe'), {
  maxAge: '30d',
  immutable: true,
  index: false,
  fallthrough: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

// ---------- Health probe ----------
// Keep this before auth / risk middleware so it proves the serverless function
// loaded even when MySQL is unreachable or cold-starting.
app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString() });
});
app.get('/api/db-health', asyncHandler(async (_req, res) => {
  const start = Date.now();
  const rows = await mysqlQuery('SELECT 1 AS ok', []);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: rows[0]?.ok === 1,
    ms: Date.now() - start,
    connection: describeConnection(),
  });
}));

const PORTAL_DIST = path.join(__dirname, 'portal', 'dist');
const PROMPTS_PATH = path.join(__dirname, 'merged-prompts.json');
const COVER_THUMBS_MANIFEST_PATH = path.join(__dirname, 'public', 'static', 'covers-thumbs', 'manifest.json');
const PROTECTED_STATIC_JSON_FILES = new Set([
  'aishort-prompts-top200.json',
  'meigen-prompts-top102.json',
  'prompts-chat-image-top100.json',
  'prompts-chat-video-top100.json',
  'one-company-lessons.json',
]);
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
function isRemovedIdeaRecord(raw) {
  const summary = String(raw?.summary || raw?.description || '').trim();
  return summary.includes('2023.06.10')
    && summary.includes('被降权');
}
let COVER_THUMBS = Object.create(null);

function loadCoverThumbsManifest() {
  try {
    if (!fs.existsSync(COVER_THUMBS_MANIFEST_PATH)) {
      COVER_THUMBS = Object.create(null);
      return;
    }
    const raw = fs.readFileSync(COVER_THUMBS_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    COVER_THUMBS = parsed && typeof parsed === 'object' ? parsed : Object.create(null);
    console.log(`  -> cover thumbs loaded: ${Object.keys(COVER_THUMBS).length} items`);
  } catch (err) {
    COVER_THUMBS = Object.create(null);
    console.warn('[covers] failed to load thumbnail manifest:', err?.message || err);
  }
}
loadCoverThumbsManifest();

// ---------- In-memory prompts cache ----------
// The full /api/prompts payload is built once at boot (the JSON file is 1.8MB;
// per-request JSON.parse + sanitize + res.json was the dominant latency on
// page load). On a file change we re-parse and re-sanitize in place — no
// restart needed. Each response still gets a fresh ETag based on the cache
// version, so clients can do If-None-Match → 304 with zero body.
//
// Priority: MySQL prompt_cards (if table exists and has rows) > merged-prompts.json
let PROMPTS_CACHE = null;
let KNOWN_COVER_URLS = null;

// Check if prompt_cards table has data
async function loadPromptsFromMySQL() {
  try {
    const rows = await mysqlQuery(
      `SELECT c.id, c.title, c.category, c.original_category, c.page_type,
              c.summary, c.description, c.tags, c.preview_image_url, c.preview_thumb_url,
              c.image_preview_url, c.source_url, c.demo_url, c.sort_order, c.source,
              c.is_free, c.is_blindbox, c.member_only, c.active, c.heat, c.created_at,
              b.prompt_text, b.prompt_text_length
         FROM prompt_cards c
         LEFT JOIN prompt_card_bodies b ON b.card_id = c.id
         WHERE c.active = 1
         ORDER BY c.sort_order ASC, c.created_at DESC`,
      []
    );
    return rows;
  } catch (err) {
    console.warn('[prompts] MySQL load failed, falling back to JSON:', err.message);
    return null;
  }
}

function promptListItemFromMySQL(row) {
  const explicitImage = row.preview_image_url || row.image_preview_url || null;
  const demoKind = row.demo_url ? classifyPreviewUrl(row.demo_url) : null;
  const explicitVideo = demoKind === 'video' ? row.demo_url : null;
  const explicitPlayable = explicitVideo;
  const derived = (!explicitImage && !explicitVideo && !explicitPlayable)
    ? extractPreviewFromPromptText(row)
    : null;
  const previewImageUrl = explicitImage || (demoKind === 'image' ? row.demo_url : null) || (derived?.kind === 'image' ? derived.url : null);
  const previewVideoUrl = explicitVideo || null;
  const playableVideoUrl = explicitPlayable || (derived?.kind === 'video' ? derived.url : null);
  const previewThumbUrl = row.preview_thumb_url || (previewImageUrl ? (COVER_THUMBS[previewImageUrl] || null) : null);
  const hasPreview = !!(previewImageUrl || previewVideoUrl || playableVideoUrl);
  const isBlindBox = !!row.is_blindbox || /盲盒/.test(String(row.category || ''));
  const forceBlindBox = isBlindBox && !hasPreview;
  return {
    id: row.id,
    title: row.title,
    category: !forceBlindBox && isBlindBox && row.original_category ? row.original_category : row.category,
    original_category: row.original_category,
    special_collection: forceBlindBox ? 'blind_box' : null,
    page_type: row.page_type,
    summary: row.summary,
    description: row.description,
    tags: row.tags,
    preview_image_url: previewImageUrl,
    preview_thumb_url: previewThumbUrl,
    image_preview_url: row.image_preview_url,
    source_url: row.source_url,
    demo_url: row.demo_url,
    preview_video_url: previewVideoUrl,
    playable_video_url: playableVideoUrl,
    sort_order: row.sort_order,
    source: row.source,
    is_free: !!row.is_free,
    is_blindbox: !!row.is_blindbox,
    member_only: !!row.member_only,
    active: !!row.active,
    heat: row.heat,
    has_prompt_text: Number(row.prompt_text_length || 0) > 0 || !!row.prompt_text,
    prompt_text_length: row.prompt_text_length || 0,
    created_at: row.created_at,
  };
}

function loadPromptsCache() {
  // Try MySQL first — if it has data, use it
  // This is called synchronously at startup; we load MySQL data
  // into a separate cache and merge at runtime
  const raw = fs.readFileSync(PROMPTS_PATH, 'utf8');
  const data = JSON.parse(raw);
  const sanitized = data.map(promptListItem);
  const byId = new Map();
  for (const p of data) byId.set(p.id, p);
  const etag = '"' + crypto.createHash('sha1')
    .update('v1')
    .update(String(sanitized.length))
    .update(raw)
    .digest('hex') + '"';
  const stat = fs.statSync(PROMPTS_PATH);
  const lastModified = stat.mtime.toUTCString();
  PROMPTS_CACHE = {
    version: Date.now(),
    etag,
    lastModified,
    sanitized,
    byId,
  };
  KNOWN_COVER_URLS = null;
  console.log(`  -> prompts cache loaded: ${sanitized.length} items (${(raw.length / 1024).toFixed(0)}KB source)`);
}

// Async version that tries MySQL first
let MYSQL_PROMPTS_CACHE = null;
let MYSQL_PROMPTS_LOADED = false;
let MYSQL_PROMPTS_LOAD_PROMISE = null;

async function loadMySQLPromptsCache() {
  if (MYSQL_PROMPTS_LOADED) return;
  if (MYSQL_PROMPTS_LOAD_PROMISE) return MYSQL_PROMPTS_LOAD_PROMISE;
  MYSQL_PROMPTS_LOAD_PROMISE = (async () => {
  const rows = await loadPromptsFromMySQL();
  if (rows && rows.length > 0) {
    const sanitized = rows.map(promptListItemFromMySQL);
    const byId = new Map();
    for (const p of rows) byId.set(p.id, p);
    // The list endpoint is metadata-only, but cover/demo URLs, membership
    // flags, text lengths and titles can change without IDs changing. Hash the
    // visible metadata rather than IDs only; otherwise browsers can keep a 304
    // response and the SPA's local catalog cache may keep stale/broken covers.
    const visibleMetadata = rows.map(r => [
      r.id,
      r.title,
      r.category,
      r.original_category,
      r.preview_image_url,
      r.preview_thumb_url,
      r.image_preview_url,
      r.demo_url,
      r.sort_order,
      r.is_free,
      r.is_blindbox,
      r.member_only,
      r.prompt_text_length,
      r.updated_at,
    ].map(v => v == null ? '' : String(v)).join('\u001f')).join('\u001e');
    const hash = crypto.createHash('sha1').update(visibleMetadata).digest('hex');
    MYSQL_PROMPTS_CACHE = {
      version: Date.now(),
      etag: '"mysql-' + hash + '"',
      lastModified: new Date().toUTCString(),
      sanitized,
      byId,
    };
    console.log(`  -> MySQL prompts cache loaded: ${sanitized.length} items (${rows.length} rows)`);
  } else {
    console.log('  -> MySQL prompt_cards empty, using JSON fallback');
  }
  MYSQL_PROMPTS_LOADED = true;
  })().finally(() => {
    MYSQL_PROMPTS_LOAD_PROMISE = null;
  });
  return MYSQL_PROMPTS_LOAD_PROMISE;
}

function getPromptsCache() {
  if (!PROMPTS_CACHE) loadPromptsCache();
  return PROMPTS_CACHE;
}

// Get the best cache available (MySQL if available, else JSON)
// MySQL cache loads lazily to avoid blocking startup
function getBestPromptsCache() {
  if (MYSQL_PROMPTS_CACHE) return MYSQL_PROMPTS_CACHE;
  if (!MYSQL_PROMPTS_LOADED) loadMySQLPromptsCache().catch(() => {});
  return getPromptsCache();
}

async function getBestPromptsCacheAsync() {
  if (!MYSQL_PROMPTS_LOADED && !MYSQL_PROMPTS_CACHE) {
    await loadMySQLPromptsCache();
  }
  return MYSQL_PROMPTS_CACHE || getPromptsCache();
}

// Refresh MySQL cache (call after admin writes)
async function refreshMySQLPromptsCache() {
  MYSQL_PROMPTS_LOADED = false;
  MYSQL_PROMPTS_CACHE = null;
  // Don't wait for load, just trigger async refresh
  loadMySQLPromptsCache().catch(() => {});
}

function collectKnownCoverUrls() {
  const urls = new Set();
  const prompts = getPromptsCache();
  for (const item of prompts.sanitized) {
    for (const candidate of [item.preview_image_url, item.image_preview_url, item.preview_thumb_url]) {
      const value = String(candidate || '').trim();
      if (value) urls.add(value);
    }
  }
  const ideaLibraries = IDEA_LIBRARY_CACHE || loadIdeaLibrariesStaticCache();
  for (const kind of Object.keys(IDEA_LIBRARY_SOURCES)) {
    const library = ideaLibraries[kind];
    if (!library) continue;
    for (const item of library.items) {
      for (const candidate of [item.preview_image_url, item.preview_thumb_url, item.cover_url]) {
        const value = String(candidate || '').trim();
        if (value) urls.add(value);
      }
    }
  }
  KNOWN_COVER_URLS = urls;
  return urls;
}

function getKnownCoverUrls() {
  if (!KNOWN_COVER_URLS) return collectKnownCoverUrls();
  return KNOWN_COVER_URLS;
}

function isKnownCoverUrl(value) {
  const url = String(value || '').trim();
  if (!url) return false;
  return getKnownCoverUrls().has(url);
}
let _promptsWatcher = null;
function watchPromptsFile() {
  try {
    if (_promptsWatcher) _promptsWatcher.close();
    _promptsWatcher = fs.watch(PROMPTS_PATH, { persistent: false }, () => {
      try { loadPromptsCache(); } catch (e) { console.error('prompts reload failed:', e.message); }
    });
  } catch {}
}

// ---------- Private idea-library caches ----------
// These JSON files remain on disk as source data, but are no longer public API.
// List endpoints expose metadata only; prompt bodies are fetched with the same
// membership + single-use token flow as motionsites.
const IDEA_TITLE_CN = {
  'prompts-chat-video-001': '360 度产品旋转视频',
  'prompts-chat-video-002': '赛博黑色电影三联画',
  'prompts-chat-video-003': '曼哈顿鸡尾酒电影短片',
  'prompts-chat-video-004': '代基里鸡尾酒电影短片',
  'prompts-chat-video-005': '超写实足球比赛转播',
  'prompts-chat-video-006': '破碎灵魂的中世纪骑士',
  'prompts-chat-video-007': '随性女生夜晚自拍',
  'prompts-chat-video-008': '尘土碗年代女飞行员',
  'prompts-chat-video-009': '电影解说导演脚本',
  'prompts-chat-video-010': '皮克斯感小狗短片',
  'prompts-chat-video-011': '跨界艺术混合风格',
  'prompts-chat-video-012': '美式漫画英雄风',
  'prompts-chat-video-013': '乡村一日电影三联画',
  'prompts-chat-video-014': '静谧草地人像三联画',
  'prompts-chat-video-015': '分镜板九宫格',
  'prompts-chat-video-016': '午夜线人电影场景',
  'prompts-chat-video-017': '玻璃中的另一个自己',
  'prompts-chat-video-018': '终端极速坠落',
  'prompts-chat-video-019': '维多利亚旅人的时空惊慌',
  'prompts-chat-video-020': '六格分镜叙事模板',
  'prompts-chat-video-021': '复古迷幻舞台短片',
  'prompts-chat-video-022': 'Gary Frank 风格墨线插画',
  'prompts-chat-video-023': '黄金时刻副驾自拍',
  'prompts-chat-video-024': '蓝调酒吧的阴影',
  'prompts-chat-video-025': '迷雾中的秘密交易',
  'prompts-chat-video-026': '时间褶皱奇幻场景',
  'prompts-chat-video-027': '黑色电影低语',
  'prompts-chat-video-028': '学生查分庆祝瞬间',
  'prompts-chat-video-029': '雨中猩红华尔兹',
  'prompts-chat-video-030': '霓虹小巷专辑封面风',
  'prompts-chat-video-031': '水下 Veo 3 电影感视频',
  'prompts-chat-video-032': 'Prompts.chat 宣传短片',
  'prompts-chat-video-033': '图片分析报告模板',
  'prompts-chat-video-034': '巨人观察者与微缩城市',
  'prompts-chat-video-035': '低调电影感人像摄影',
  'prompts-chat-video-036': '日落船景电影镜头',
  'prompts-chat-video-037': '雪原孤影数字绘画',
  'prompts-chat-video-038': '猩红虚空海盗',
  'prompts-chat-video-039': '以太工坊奇幻场景',
  'prompts-chat-video-040': '锈蚀时代回声',
  'prompts-chat-video-041': '咖啡馆窗边特写',
  'prompts-chat-video-042': '日本旅行氛围短片',
  'prompts-chat-video-043': '午夜旋律谜案',
  'prompts-chat-video-044': '月光街道宁静插画',
  'prompts-chat-video-045': '安卡拉土耳其女性超现实人像',
  'prompts-chat-video-046': '电影感近景人像',
  'prompts-chat-video-047': '时装与环境写实画面',
  'prompts-chat-video-048': '光轨中的低语',
  'prompts-chat-video-049': '冷战阴影：1962 交换',
  'prompts-chat-video-050': '2084 协议巷战黑客',
  'prompts-chat-video-051': '屋顶日落回眸半身照',
  'prompts-chat-video-052': '文化超级英雄电影海报',
  'prompts-chat-video-053': '幻影突袭动作场景',
  'prompts-chat-video-054': '终端漂移科幻镜头',
  'prompts-chat-video-055': '机场走廊全身街拍',
  'prompts-chat-video-056': '最后的柔板',
  'prompts-chat-video-057': '创意点子生成器',
  'prompts-chat-video-058': '社媒鸡尾酒网页贴文',
  'prompts-chat-video-059': '孤独哭泣情绪镜头',
  'prompts-chat-video-060': '醉酒女性电影场景',
  'prompts-chat-video-061': '3D 卡通小兔冒险',
  'prompts-chat-video-062': '情人节鸡尾酒短片',
  'prompts-chat-video-063': '超写实冬季电影摄影',
  'prompts-chat-video-064': '趋势研究分析器',
  'prompts-chat-video-065': '卧室镜面自拍分析',
  'prompts-chat-video-066': '90 年代鱼眼镜头',
  'prompts-chat-video-067': '混合媒介人像插画',
  'prompts-chat-video-068': '雄鹰 3D 写实渲染',
  'prompts-chat-video-069': '屋顶生活方式人像',
  'prompts-chat-video-070': '网红睡前随手自拍',
  'prompts-chat-video-071': '奥斯曼风 3D 等距杰作',
  'prompts-chat-video-072': '暖灯植物花束静物',
  'prompts-chat-video-073': '咖啡馆人像描述',
  'prompts-chat-video-074': '加拉塔塔黑白老照片',
  'prompts-chat-video-075': '电梯镜面全身穿搭',
  'prompts-chat-video-076': '宁静傍晚划船插画',
  'prompts-chat-video-077': '草地少女梦幻艺术照',
  'prompts-chat-video-078': '地铁站台情绪街拍',
  'prompts-chat-video-079': '漫画团队群像插画',
  'prompts-chat-video-080': '冬季杂志海报拼贴',
  'prompts-chat-video-081': '印象派城市孤独感',
  'prompts-chat-video-082': '极简监控风插画',
  'prompts-chat-video-083': 'Ryo Takemasa 风极简风景',
  'prompts-chat-video-084': '雪夜街头温暖穿搭',
  'prompts-chat-video-085': '电影光影马匹剪影',
  'prompts-chat-video-086': '真实镜面自拍场景',
  'prompts-chat-video-087': '水晶舞会以太王子',
  'prompts-chat-video-088': '复古公路旅行胶片照',
  'prompts-chat-video-089': '蘑菇帽上的黏土动画冒险',
  'prompts-chat-video-090': '夜晚霓虹小巷半身照',
  'prompts-chat-video-091': '雨伞街头全身照',
  'prompts-chat-video-092': 'GoPro 运动镜头',
  'prompts-chat-video-093': '安卡拉夜晚阳台场景',
  'prompts-chat-video-094': '暖钨丝灯沙发特写',
  'prompts-chat-video-095': '3x3 焦段电影镜头网格',
  'prompts-chat-video-096': '曼哈顿幻景',
  'prompts-chat-video-097': '蓝调时刻桥上全身照',
  'prompts-chat-video-098': '空灵梦境人像摄影',
  'prompts-chat-video-099': '巴黎夜晚电影场景',
  'prompts-chat-video-100': '抽象实验视频提示词',
};
let IDEA_LIBRARY_CACHE = null;

function normalizeIdeaArray(input) {
  return Array.isArray(input)
    ? input
    : (Array.isArray(input?.items) ? input.items
      : Array.isArray(input?.list) ? input.list
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

const IMG_AI_BRAND_CORE = ['g', 'pt'].join('');
const IMG_AI_BRAND_CHAT = ['chat', IMG_AI_BRAND_CORE].join('');
function scrubImgAiBrandText(value) {
  if (value == null) return value;
  return String(value)
    .replace(new RegExp(`${IMG_AI_BRAND_CHAT}\\s*[-_ ]?image`, 'ig'), 'AI Image')
    .replace(new RegExp(`${IMG_AI_BRAND_CORE}\\s*[-_ ]?image`, 'ig'), 'AI Image')
    .replace(new RegExp(`chat\\s+${IMG_AI_BRAND_CORE}`, 'ig'), 'AI 助手')
    .replace(new RegExp(IMG_AI_BRAND_CHAT, 'ig'), 'AI 助手')
    .replace(new RegExp(IMG_AI_BRAND_CORE, 'ig'), 'AI');
}

function scrubImgAiVisibleValue(value, key = '') {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (/(^|_)(url|uri)$|url$|uri$|thumbnail/i.test(key)) return value;
    return scrubImgAiBrandText(value);
  }
  if (Array.isArray(value)) return value.map(entry => scrubImgAiVisibleValue(entry, key));
  if (typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = scrubImgAiVisibleValue(childValue, childKey);
    }
    return out;
  }
  return value;
}

function ideaSummary(raw, promptText, title) {
  const explicit = String(raw.summary || raw.description || '').trim();
  if (explicit && !/^[\s\n]*[\[{]/.test(explicit)) return plainSnippet(explicit, 150);
  return plainSnippet(promptText.replace(/[{}"[\],]/g, ' '), 150) || title;
}

function normalizeIdeaRecord(raw, index, cfg, fileIndex) {
  const promptText = String(raw.prompt_text || raw.prompt || raw.content || raw.text || '').trim();
  const rawId = String(raw.id || `${cfg.idPrefix}-${String(index + 1).padStart(3, '0')}`).trim();
  const stableId = `${cfg.source}-${fileIndex}-${rawId}`.replace(/[^a-z0-9:_-]/gi, '-');
  const rawTitle = String(raw.title || raw.name || `${cfg.label} ${index + 1}`).trim();
  const title = IDEA_TITLE_CN[rawId] || rawTitle;
  const coverUrl = String(raw.cover_url || raw.image_url || raw.thumbnail || raw.preview_image_url || '').trim();
  const videoUrl = String(raw.video_url || raw.preview_video_url || raw.playable_video_url || '').trim();
  const heat = Number(raw.heat ?? raw.likes ?? raw.views);
  return {
    ...raw,
    id: stableId,
    original_id: rawId,
    title,
    category: String(raw.category || raw.group || cfg.defaultCategory).trim(),
    type: String(raw.type || cfg.defaultType),
    page_type: String(raw.page_type || raw.topic || raw.scene || raw.category || cfg.defaultCategory).trim(),
    sort_order: Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : index + 1,
    source: cfg.source,
    has_prompt_text: !!promptText,
    prompt_text_length: promptText.length,
    heat: Number.isFinite(heat) ? heat : Math.max(120, 980 - index * 3),
    tags: normalizeTagList(raw.tags),
    summary: ideaSummary(raw, promptText, title),
    preview_image_url: coverUrl,
    preview_thumb_url: coverUrl,
    cover_url: coverUrl,
    preview_video_url: videoUrl,
    playable_video_url: videoUrl,
    prompt_text: promptText,
  };
}

function ideaListItem(item) {
  const {
    prompt_text, prompt, content, text, ...meta
  } = item;
  return item?.source === 'image_ideas' ? scrubImgAiVisibleValue(meta) : meta;
}

function parseJsonColumn(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function ideaRecordFromMysql(row) {
  const tags = parseJsonColumn(row.tags, []);
  const raw = parseJsonColumn(row.raw, {});
  return {
    ...raw,
    id: String(row.id),
    original_id: row.original_id || '',
    title: row.title || '',
    category: row.category || '',
    type: row.type || '',
    page_type: row.page_type || '',
    sort_order: Number(row.sort_order || 0),
    source: row.source || '',
    has_prompt_text: Number(row.prompt_text_length || 0) > 0,
    prompt_text_length: Number(row.prompt_text_length || 0),
    heat: Number(row.heat || 0),
    tags: Array.isArray(tags) ? tags : [],
    summary: row.summary || '',
    preview_image_url: row.preview_image_url || '',
    preview_thumb_url: row.preview_thumb_url || row.preview_image_url || '',
    cover_url: row.cover_url || row.preview_image_url || '',
    preview_video_url: row.preview_video_url || '',
    playable_video_url: row.playable_video_url || row.preview_video_url || '',
    prompt_text: row.prompt_text || '',
  };
}

function buildIdeaLibraryCache(libraries, kind, cfg, rawItems, sourceLabel) {
  const activeItems = rawItems.filter(item => item && item.title && item.prompt_text && !isRemovedIdeaRecord(item));
  const byId = new Map(activeItems.map(item => [item.id, item]));
  libraries[kind] = {
    label: cfg.label,
    items: activeItems.map(ideaListItem),
    byId,
    source: sourceLabel,
    etag: '"' + crypto.createHash('sha1')
      .update(kind)
      .update(sourceLabel)
      .update(String(activeItems.length))
      .update(activeItems.map(item => `${item.id}:${item.prompt_text_length}`).join('|'))
      .digest('hex') + '"',
  };
}

function loadIdeaLibrariesStaticCache() {
  const libraries = {};
  for (const [kind, cfg] of Object.entries(IDEA_LIBRARY_SOURCES)) {
    const rawItems = [];
    cfg.files.forEach((file, fileIndex) => {
      const fullPath = path.join(__dirname, 'public', 'static', file);
      if (!fs.existsSync(fullPath)) return;
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      normalizeIdeaArray(parsed).forEach((raw, index) => {
        if (isRemovedIdeaRecord(raw)) return;
        const item = normalizeIdeaRecord(raw, rawItems.length + index, cfg, fileIndex);
        if (item.title && item.prompt_text) rawItems.push(item);
      });
    });
    buildIdeaLibraryCache(libraries, kind, cfg, rawItems, 'static');
    console.log(`  -> ${kind} static idea cache loaded: ${libraries[kind].items.length} items`);
  }
  return libraries;
}

async function loadIdeaLibrariesMysqlCache() {
  const rows = await mysqlQuery(
    `SELECT id, kind, original_id, title, category, type, page_type, sort_order,
            source, prompt_text, prompt_text_length, heat, tags, summary,
            preview_image_url, preview_thumb_url, cover_url, preview_video_url,
            playable_video_url, raw
       FROM idea_prompts
      WHERE active = 1
      ORDER BY kind ASC, sort_order ASC, id ASC`,
    [],
  );
  if (!rows.length) return null;
  const libraries = {};
  for (const [kind, cfg] of Object.entries(IDEA_LIBRARY_SOURCES)) {
    const rawItems = rows
      .filter(row => row.kind === kind)
      .map(ideaRecordFromMysql);
    buildIdeaLibraryCache(libraries, kind, cfg, rawItems, 'mysql');
    console.log(`  -> ${kind} MySQL idea cache loaded: ${libraries[kind].items.length} items`);
  }
  return libraries;
}

let IDEA_LIBRARY_CACHE_PROMISE = null;
async function loadIdeaLibrariesCache() {
  if (IDEA_LIBRARY_CACHE_PROMISE) return IDEA_LIBRARY_CACHE_PROMISE;
  IDEA_LIBRARY_CACHE_PROMISE = (async () => {
    const staticLibraries = loadIdeaLibrariesStaticCache();
    if (process.env.IDEA_LIBRARY_BACKEND !== 'static') {
      try {
        const mysqlLibraries = await loadIdeaLibrariesMysqlCache();
        if (mysqlLibraries) {
          const mergedLibraries = {};
          for (const kind of Object.keys(IDEA_LIBRARY_SOURCES)) {
            const mysqlLibrary = mysqlLibraries[kind];
            const staticLibrary = staticLibraries[kind];
            const mysqlHasItems = Array.isArray(mysqlLibrary?.items) && mysqlLibrary.items.length > 0;
            mergedLibraries[kind] = mysqlHasItems ? mysqlLibrary : staticLibrary;
          }
          IDEA_LIBRARY_CACHE = mergedLibraries;
          KNOWN_COVER_URLS = null;
          return IDEA_LIBRARY_CACHE;
        }
        console.warn('[ideas] idea_prompts table is empty; falling back to static JSON');
      } catch (err) {
        console.warn('[ideas] failed to load idea_prompts from MySQL; falling back to static JSON:', err?.message || err);
      }
    }
    IDEA_LIBRARY_CACHE = staticLibraries;
    KNOWN_COVER_URLS = null;
    return IDEA_LIBRARY_CACHE;
  })().finally(() => {
    IDEA_LIBRARY_CACHE_PROMISE = null;
  });
  return IDEA_LIBRARY_CACHE_PROMISE;
}

async function getIdeaLibrary(kind) {
  if (!IDEA_LIBRARY_CACHE) await loadIdeaLibrariesCache();
  return IDEA_LIBRARY_CACHE[kind] || null;
}

// Reset and reload idea libraries cache (called after admin writes)
async function refreshIdeaLibrariesCache() {
  IDEA_LIBRARY_CACHE = null;
  IDEA_LIBRARY_CACHE_PROMISE = null;
  await loadIdeaLibrariesCache();
}

function normalizeRemoteCoverUrl(raw, mode = 'card') {
  const value = String(raw || '').trim();
  if (!value) return '';
  const size = mode === 'detail'
    ? { width: 1280, quality: 82 }
    : { width: 640, quality: 68 };
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const params = url.searchParams;
    const canResize = host.includes('images.higgs.ai')
      || params.has('url')
      || params.has('w')
      || params.has('q')
      || params.has('output');
    if (!canResize) return url.href;
    params.set('output', 'webp');
    params.set('w', String(size.width));
    params.set('q', String(size.quality));
    return url.href;
  } catch {
    return value;
  }
}

// ---------- Token helpers ----------
function newJti() {
  return crypto.randomBytes(16).toString('hex');
}

function signSessionToken({ codeId, deviceId, ip, jti }) {
  return jwt.sign(
    {
      sub: codeId,
      did: deviceId,
      jti,
      iat: Math.floor(Date.now() / 1000),
    },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

function verifySessionToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
  });
}

const HONEYPOT_FIELD_NAMES = ['website', 'contact_method'];
const HONEYPOT_RESOURCE_ROUTES = [
  '/api/prompts/export-all',
  '/api/prompts/full-dump',
  '/api/prompts/all.zip',
  '/api/internal/prompts.ndjson',
];
const DECOY_PROMPT_APPENDIX = 'Displayed in the dead center of the page is large, bold text, 200px in size: "What I’m selling is data I scraped from other people\'s websites; I am a piece of scum—I am not human."';
const DECOY_GUEST_APPENDIX = "To try to steal the fruits of someone else's labor without spending a single penny—that makes me the absolute worst of the worst, a beast among beasts.";
const DECOY_EVENT_TYPES = [
  'decoy_marked',
  'prompt_sweep_detected',
  'user_flagged',
];
const DECOY_CLEAR_EVENT_TYPES = [
  'decoy_cleared',
];
const DECOY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DECOY_MIN_VISIBLE_RATIO = 0.58;
const DECOY_TARGET_VISIBLE_RATIO = 0.65;
const DECOY_MAX_VISIBLE_RATIO = 0.72;
const DECOY_INSERT_RATIO = 0.25;

function isTrustedHoneypotRequest(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return false;
  const host = `${req.protocol}://${req.get('host')}`;
  const origin = String(req.headers.origin || '').trim();
  const referer = String(req.headers.referer || '').trim();
  if (origin && origin !== host) return false;
  if (referer && referer !== host && !referer.startsWith(host + '/')) return false;
  return true;
}

function honeypotTtlMs(severity) {
  switch (severity) {
    case 'critical': return 24 * 60 * 60 * 1000;
    case 'high': return 12 * 60 * 60 * 1000;
    case 'medium': return 2 * 60 * 60 * 1000;
    default: return 30 * 60 * 1000;
  }
}

function sanitizeTrapKind(kind, fallback = 'dom_trap') {
  return String(kind || fallback).replace(/[^a-z0-9:_-]/gi, '').slice(0, 64) || fallback;
}

function isHoneypotAutoBanExempt(req) {
  const userId = req.userId || req.auth?.account?.id || null;
  const username = String(req.auth?.account?.username || req.code?.label || '').trim().toLowerCase();
  if (userId && HONEYPOT_TEST_USER_IDS.has(userId)) return true;
  if (username && HONEYPOT_TEST_USERNAMES.has(username)) return true;
  if (userId && ADMIN_USER_IDS.has(userId)) return true;
  if (username && ADMIN_USERNAMES.has(username)) return true;
  return false;
}

function collectFilledHoneypotFields(body) {
  const fields = [];
  for (const name of HONEYPOT_FIELD_NAMES) {
    const raw = body?.[name];
    if (raw == null) continue;
    const value = Array.isArray(raw) ? raw.join(' ') : String(raw);
    const trimmed = value.trim();
    if (!trimmed) continue;
    fields.push({ name, value: trimmed.slice(0, 160) });
  }
  return fields;
}

async function triggerHoneypot(req, res, {
  kind,
  source = 'dom',
  severity = 'high',
  action = 'revoke_session',
  detail = null,
  fields = [],
} = {}) {
  const safeKind = sanitizeTrapKind(kind, 'dom_trap');
  const ttlMs = honeypotTtlMs(severity);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const shouldRevoke = action === 'revoke_session' || action === 'revoke_all_sessions';
  const canBanAccount = req.userKind === 'account' && req.auth?.account?.id;
  const skipAccountBan = canBanAccount && isHoneypotAutoBanExempt(req);
  const shouldBanAccount = canBanAccount && !skipAccountBan;
  const shouldBlockIp = shouldRevoke && !shouldBanAccount && !skipAccountBan;
  const revokePromise = action === 'revoke_all_sessions' && req.userId
    ? revokeAllSessionsForUser(req.userId)
    : action === 'revoke_session' && req.jti
      ? db.update('user_session', req.jti, {
          revoked: true,
          revoked_at: new Date().toISOString(),
        })
      : Promise.resolve();

  const tasks = [
    db.appendLog('security_event', {
      type: 'honeypot_triggered',
      trap_kind: safeKind,
      source,
      severity,
      action,
      ip: req.clientIp,
      user_id: req.userId || null,
      device_id: req.deviceId || null,
      jti: req.jti || null,
      method: req.method,
      path: req.originalUrl,
      ua: req.headers['user-agent'] || '',
      sec_fetch_site: req.headers['sec-fetch-site'] || null,
      sec_fetch_mode: req.headers['sec-fetch-mode'] || null,
      sec_fetch_dest: req.headers['sec-fetch-dest'] || null,
      filled_fields: fields.map((field) => field.name),
      detail,
    }),
    revokePromise,
  ];
  if (action === 'serve_decoy') {
    res.cookie(DECOY_COOKIE_NAME, String(Date.now() + ttlMs), {
      httpOnly: false,
      sameSite: 'lax',
      secure: IS_PRODUCTION,
      maxAge: ttlMs,
      path: '/',
    });
    tasks.push(db.appendLog('security_event', {
      type: 'decoy_marked',
      reason: `honeypot:${safeKind}`,
      source,
      severity,
      ip: req.clientIp,
      user_id: req.userId || null,
      device_id: req.deviceId || null,
      jti: req.jti || null,
      path: req.originalUrl,
    }));
  }
  if (skipAccountBan) {
    tasks.push(db.appendLog('security_event', {
      type: 'honeypot_user_ban_skipped',
      reason: 'test_or_admin_account',
      trap_kind: safeKind,
      source,
      severity,
      ip: req.clientIp,
      user_id: req.userId || null,
      username: req.auth?.account?.username || null,
      device_id: req.deviceId || null,
      jti: req.jti || null,
      path: req.originalUrl,
    }));
  }
  if (shouldBanAccount) {
    tasks.push((async () => {
      const reason = `honeypot:${safeKind}`;
      const updated = await accounts.ban(req.auth.account.id, reason);
      const revokedSessions = await revokeAllSessionsForUser(req.auth.account.id);
      await db.appendLog('security_event', {
        type: 'auto_honeypot_user_ban',
        reason,
        trap_kind: safeKind,
        source,
        severity,
        ip: req.clientIp,
        user_id: req.auth.account.id,
        username: req.auth.account.username || null,
        device_id: req.deviceId || null,
        jti: req.jti || null,
        path: req.originalUrl,
        revoked_sessions: revokedSessions,
        already_revoked: !!req.auth.account.revoked,
        ok: !!updated,
      });
    })());
  }
  if (shouldBlockIp && req.clientIp) {
    tasks.push(db.insert('ip_block', {
      ip: req.clientIp,
      reason: `honeypot:${safeKind}`,
      expires_at: expiresAt,
    }));
  }
  await Promise.allSettled(tasks);
  if ((shouldRevoke || shouldBanAccount) && (req.auth || req.jti)) clearSessionCookie(res);
  return { ttlMs, expiresAt, action, kind: safeKind };
}

// Resolve an account entry into the legacy `code` shape that /api/me and friends
// already consume. We synthesise the same fields so existing handlers don't need
// to fork on identity type.
function accountAsCodeLike(a) {
  return {
    id: a.id,
    label: a.username,
    note: a.note || '',
    created_at: a.created_at,
    last_used_at: a.last_login_at, // legacy field; semantically "last activity"
    use_count: a.login_count || 0,
    revoked: !!a.revoked,
    membership_years: a.membership_years ?? null,
    activated_at: a.activated_at ?? null,
    expires_at: a.expires_at ?? null,
    promoted_from_code: a.promoted_from_code ?? null,
    __kind: 'account',
    __masked_username: a.username.slice(0, 2) + '…',
    __username: a.username,
  };
}

function membershipForAuth(req) {
  // Returns the membership status synchronously by reading from the cached
  // values populated on `req.auth`. We do the DB lookups ONCE in the cookie
  // middleware so /api/me, denyIfNotMember, and friends don't each repeat
  // the round-trip.
  if (!req.auth) return getMembershipStatus(null);
  if (req.userKind === 'account') {
    return resolveAccountMembership(req.auth.account, req.auth.code);
  }
  return getMembershipStatus(req.code);
}

function activateAccountMembership(accountId) {
  // Synchronous facade around the async membership activation. Returns the
  // updated account record or null. server.js calls this from inside the
  // /api/login handler which is already async; we just await.
  // The actual DB writes happen inside lib/accounts.js.
  // Implemented as an async function below; this wrapper keeps the call sites
  // symmetric with the non-account path.
  return _activateAccountMembershipImpl(accountId);
}

async function _activateAccountMembershipImpl(accountId) {
  const acct = await accounts.findById(accountId);
  if (!acct) return null;
  const code = acct.promoted_from_code ? await store.findById(acct.promoted_from_code) : null;
  if (code) await store.activateMembership(code.id);
  const freshCode = acct.promoted_from_code ? await store.findById(acct.promoted_from_code) : null;
  const source = {
    revoked: acct.revoked,
    membership_years: acct.membership_years ?? freshCode?.membership_years ?? null,
    activated_at: acct.activated_at ?? freshCode?.activated_at ?? null,
    expires_at: acct.expires_at ?? freshCode?.expires_at ?? null,
  };
  const patch = activationPatch(source);
  if (!patch) return acct;
  return await accounts.syncMembership(accountId, {
    membership_years: source.membership_years ?? freshCode?.membership_years ?? null,
    activated_at: patch.activated_at,
    expires_at: patch.expires_at,
  });
}

function membershipPayload(status) {
  return {
    is_member: status.is_member,
    is_permanent: status.is_permanent,
    expires_at: status.expires_at,
    expires_label: formatExpiresLabel(status),
    activated_at: status.activated_at,
    membership_years: status.membership_years,
    reason: status.reason,
  };
}

function adminAccountSummary(account) {
  if (!account) return null;
  const membership = resolveAccountMembership(account);
  return {
    id: account.id,
    username: account.username,
    kind: account.kind || 'registered',
    created_at: account.created_at || null,
    last_login_at: account.last_login_at || null,
    login_count: Number(account.login_count || 0),
    is_member: membership.is_member,
    membership_reason: membership.reason,
    membership_expires_at: membership.expires_at || null,
    membership_activated_at: membership.activated_at || null,
    membership_years: membership.membership_years ?? null,
    membership_label: membership.is_member
      ? (membership.is_permanent ? '永久会员' : '会员')
      : (membership.reason === 'expired' ? '已过期' : '非会员'),
    membership_expires_label: formatExpiresLabel(membership),
    revoked: !!account.revoked,
    revoked_reason: account.revoked_reason || null,
    revoked_at: account.revoked_at || null,
  };
}

function securityEventDetails(event) {
  return event?.payload && typeof event.payload === 'object' ? event.payload : {};
}

function securityEventUserId(event) {
  const details = securityEventDetails(event);
  return event?.user_id || details.user_id || null;
}

function securityEventTs(event) {
  return Number(event?.ts || 0);
}

function buildAdminAccountSecuritySummary(account, {
  activeIpBlocksByUser,
  decoyEventsByUser,
  decoyClearEventsByUser,
  behaviorEventsByUser,
  activeSessionsByUser,
  revokedSessionsByUser,
} = {}) {
  const id = account?.id;
  const activeIpBlocks = id ? (activeIpBlocksByUser.get(id) || []) : [];
  const latestDecoy = id ? (decoyEventsByUser.get(id) || 0) : 0;
  const latestDecoyClear = id ? (decoyClearEventsByUser.get(id) || 0) : 0;
  const decoyActive = latestDecoy > latestDecoyClear;
  const latestBehavior = id ? (behaviorEventsByUser.get(id) || null) : null;
  const activeSessionCount = id ? (activeSessionsByUser.get(id) || 0) : 0;
  const revokedSessionInfo = id ? (revokedSessionsByUser.get(id) || { count: 0, latest: 0 }) : { count: 0, latest: 0 };

  let effectiveStatus = {
    key: 'normal',
    label: '正常',
    class: 'ok',
    detail: '账号没有账号级封禁、活跃 IP 锁定或注入状态。',
  };

  if (account?.revoked) {
    effectiveStatus = {
      key: 'account_banned',
      label: '已封禁',
      class: 'danger',
      detail: account.revoked_reason || '账号已被封禁。',
    };
  } else if (activeIpBlocks.length) {
    effectiveStatus = {
      key: 'ip_blocked',
      label: 'IP锁定',
      class: 'danger',
      detail: `关联 IP 正在封禁中：${activeIpBlocks.map(b => b.ip).join('、')}`,
    };
  } else if (decoyActive) {
    effectiveStatus = {
      key: 'decoy_active',
      label: '注入中',
      class: 'warn',
      detail: '该账号触发过蜜罐/风险标记，当前正文会返回假内容。',
    };
  } else if (revokedSessionInfo.latest && revokedSessionInfo.latest >= Date.now() - 24 * 3600 * 1000) {
    effectiveStatus = {
      key: 'session_revoked',
      label: '会话已踢',
      class: 'warn',
      detail: `最近 24 小时有 ${revokedSessionInfo.count} 个会话被踢出。`,
    };
  } else if (latestBehavior) {
    effectiveStatus = {
      key: 'recent_risk',
      label: '近期风控',
      class: 'warn',
      detail: latestBehavior.reason || '最近 24 小时触发过行为风控。',
    };
  }

  return {
    effective_status: effectiveStatus.key,
    effective_status_label: effectiveStatus.label,
    effective_status_class: effectiveStatus.class,
    effective_status_detail: effectiveStatus.detail,
    active_ip_blocks: activeIpBlocks,
    decoy_active: decoyActive,
    decoy_marked_at: latestDecoy || null,
    decoy_cleared_at: latestDecoyClear || null,
    active_session_count: activeSessionCount,
    revoked_session_count_24h: revokedSessionInfo.count,
    latest_behavior_blocked: latestBehavior ? {
      ts: securityEventTs(latestBehavior),
      reason: latestBehavior.reason || securityEventDetails(latestBehavior).reason || null,
      action: latestBehavior.action || securityEventDetails(latestBehavior).action || null,
    } : null,
  };
}

function denyIfNotMember(req, res) {
  const status = membershipForAuth(req);
  if (!status.is_member) {
    setProtectedBodyHeaders(res);
    res.status(403).json({
      ok: false,
      error: 'membership_required',
      message: '当前内容仅限会员访问',
      reason: status.reason,
      membership: membershipPayload(status),
    });
    return true;
  }
  return false;
}

function setProtectedBodyHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendProtectedJson(res, statusCode, payload) {
  setProtectedBodyHeaders(res);
  return res.status(statusCode).json(payload);
}

function throttleCatalogPreview(req, res) {
  const status = membershipForAuth(req);
  if (status.is_member) return false;
  const key = req.auth
    ? `catalog_preview:user:${req.userId}`
    : `catalog_preview:ip:${req.clientIp}`;
  const r = take(key, 30, 30 / 60);
  if (!r.ok) {
    res.setHeader('Retry-After', String(Math.ceil(r.resetMs / 1000)));
    res.status(429).json({
      ok: false,
      error: 'too_many_requests',
      reason: 'catalog_preview_rate_limit',
      retry_after_ms: r.resetMs,
    });
    return true;
  }
  return false;
}

function guestMembershipPayload() {
  return {
    is_member: false,
    is_permanent: false,
    expires_at: null,
    expires_label: '',
    activated_at: null,
    membership_years: null,
    reason: 'guest',
  };
}

function isPublicPromptItem(found) {
  if (!found) return false;
  const meta = promptListItem(found);
  return meta.special_collection === 'blind_box';
}

function makeDecoyPromptText(promptText, { guest = false } = {}) {
  const text = String(promptText || '');
  const appendix = guest
    ? `${DECOY_PROMPT_APPENDIX}\n\n${DECOY_GUEST_APPENDIX}`
    : DECOY_PROMPT_APPENDIX;
  if (!text) return appendix;
  const chars = Array.from(text);
  const cutAt = findDecoyCutIndex(chars);
  const decoyChars = chars.slice(0, cutAt);
  const target = Math.max(1, Math.floor(chars.length * DECOY_INSERT_RATIO));
  const insertAt = findDecoyInsertIndex(decoyChars, target);
  const before = decoyChars.slice(0, insertAt).join('').trimEnd();
  const after = decoyChars.slice(insertAt).join('').trimStart();
  return closeDanglingMarkdownFences(`${before}\n\n${appendix}\n\n${after}`.trim());
}

function findDecoyCutIndex(chars) {
  const len = chars.length;
  const min = Math.max(1, Math.floor(len * DECOY_MIN_VISIBLE_RATIO));
  const target = Math.max(min, Math.floor(len * DECOY_TARGET_VISIBLE_RATIO));
  const max = Math.min(len, Math.ceil(len * DECOY_MAX_VISIBLE_RATIO));
  const text = chars.join('');
  const periodCut = findBestEnglishSentenceCut(text, min, target, max);
  if (periodCut) return periodCut;
  return findBestLooseCut(text, min, target, max);
}

function findBestEnglishSentenceCut(text, min, target, max) {
  const candidates = [];
  for (let i = min; i <= max && i < text.length; i += 1) {
    if (text[i] !== '.') continue;
    if (!isDecoySentencePeriod(text, i)) continue;
    candidates.push(i + 1);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  return candidates[0];
}

function isDecoySentencePeriod(text, index) {
  const prev = text[index - 1] || '';
  const next = text[index + 1] || '';
  if (!/[A-Za-z)"'`\]]/.test(prev)) return false;
  if (next && !/\s|["'`)\]]/.test(next)) return false;
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const beforeOnLine = text.slice(lineStart, index).trim();
  if (/^\d+$/.test(beforeOnLine)) return false;
  if (/\b(?:e|i)\.g$/i.test(text.slice(Math.max(0, index - 4), index + 2))) return false;
  if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|Fig|No)\.$/.test(text.slice(Math.max(0, index - 12), index + 1))) return false;
  return true;
}

function findBestLooseCut(text, min, target, max) {
  const candidates = [];
  const patterns = [
    { re: /\n```[^\n]*\n/g, offset: 'end' },
    { re: /\n\s*\n/g, offset: 'end' },
    { re: /\n#{2,4}\s+/g, offset: 'start' },
  ];
  for (const { re, offset } of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      const idx = offset === 'start' ? match.index : match.index + match[0].length;
      if (idx >= min && idx <= max) candidates.push(idx);
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
    return candidates[0];
  }
  return Math.min(max, Math.max(min, target));
}

function findDecoyInsertIndex(chars, target) {
  const safeTarget = Math.min(Math.max(1, target), chars.length - 1);
  const text = chars.join('');
  const sentenceCandidates = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] === '.' && isDecoySentencePeriod(text, i)) sentenceCandidates.push(i + 1);
  }
  if (sentenceCandidates.length) {
    sentenceCandidates.sort((a, b) => Math.abs(a - safeTarget) - Math.abs(b - safeTarget));
    return sentenceCandidates[0];
  }
  const maxRadius = Math.min(160, chars.length - 1);
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    const right = safeTarget + radius;
    if (right > 0 && right < chars.length && /\s/.test(chars[right - 1] || '')) return right;
    const left = safeTarget - radius;
    if (left > 0 && left < chars.length && /\s/.test(chars[left - 1] || '')) return left;
  }
  return safeTarget;
}

function closeDanglingMarkdownFences(text) {
  const fenceMatches = text.match(/(^|\n)```/g) || [];
  if (fenceMatches.length % 2 === 0) return text;
  return `${text.trimEnd()}\n\n\`\`\``;
}

function buildDecoyEventFilters(req) {
  const identifiers = [];
  const params = [Date.now() - DECOY_LOOKBACK_MS];
  if (req.userId) {
    identifiers.push("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.user_id')) = ?");
    params.push(req.userId);
  }
  if (req.deviceId) {
    identifiers.push("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.device_id')) = ?");
    params.push(req.deviceId);
  }
  if (req.clientIp) {
    identifiers.push("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.ip')) = ?");
    params.push(req.clientIp);
  }
  if (!identifiers.length) return false;
  return { identifiers, params };
}

async function findLatestDecoyEventTs(req, types) {
  const filters = buildDecoyEventFilters(req);
  if (!filters) return 0;
  const { identifiers, params } = filters;
  try {
    const rows = await mysqlQuery(
      `SELECT ts FROM security_event
       WHERE ts >= ?
         AND type IN (${types.map(() => '?').join(',')})
         AND (${identifiers.join(' OR ')})
       ORDER BY ts DESC
       LIMIT 1`,
      [params[0], ...types, ...params.slice(1)],
    );
    return Number(rows[0]?.ts || 0);
  } catch (err) {
    console.error('[decoy] lookup failed:', err.message);
    return 0;
  }
}

async function isDecoyViewer(req) {
  const decoyTs = await findLatestDecoyEventTs(req, DECOY_EVENT_TYPES);
  if (!decoyTs) return false;
  const clearTs = await findLatestDecoyEventTs(req, DECOY_CLEAR_EVENT_TYPES);
  return decoyTs > clearTs;
}

async function getDecoyClearAt(req) {
  return await findLatestDecoyEventTs(req, DECOY_CLEAR_EVENT_TYPES);
}

function makeWatermark(req, tokenJti = null) {
  const deviceHash = crypto.createHash('sha256')
    .update(String(req.deviceId || ''))
    .digest('hex')
    .slice(0, 12);
  return {
    user_id: req.userId,
    masked_id: req.userId && req.userId.length > 8 ? `${req.userId.slice(0,4)}…${req.userId.slice(-4)}` : req.userId,
    device_id: req.deviceId,
    device_hash: deviceHash,
    ip: req.clientIp,
    ts: Date.now(),
    token_jti: tokenJti,
  };
}

function watermarkPromptText(promptText, watermark) {
  const text = String(promptText || '');
  if (!watermark?.masked_id) return text;
  const stamp = new Date(watermark.ts || Date.now()).toISOString().replace('T', ' ').slice(0, 16);
  const marker = `[PV-WM:${watermark.masked_id}|${watermark.device_hash || ''}|${stamp}|${String(watermark.token_jti || '').slice(0, 10)}]`;
  return `${text.trimEnd()}\n\n${marker}`;
}

function throttleProtectedBodyRead(req, res, resourceKind = 'prompt') {
  const userKey = `${resourceKind}:body:user:${req.userId}:device:${req.deviceId}`;
  const deviceKey = `${resourceKind}:body:device:${req.deviceId}:ip:${req.clientIp}`;
  const userBucket = take(userKey, 90, 90 / 60);
  const deviceBucket = take(deviceKey, 120, 120 / 60);
  if (userBucket.ok && deviceBucket.ok) return false;
  const retryMs = Math.max(userBucket.resetMs || 0, deviceBucket.resetMs || 0);
  db.appendLog('security_event', {
    type: 'content_body_rate_limited',
    resource_kind: resourceKind,
    user_id: req.userId,
    device_id: req.deviceId,
    ip: req.clientIp,
  }).catch(err => console.error('[content] rate log failed:', err.message));
  res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
  sendProtectedJson(res, 429, {
    ok: false,
    error: 'too_many_content_reads',
    message: '正文打开过于频繁，请稍后再试',
    retry_after_ms: retryMs,
  });
  return true;
}

function logContentBehavior(req, {
  action,
  resourceId,
  resourceSource = null,
  library = null,
  tokenJti = null,
  decoy = false,
  extra = null,
} = {}) {
  db.appendLog('user_behavior_log', {
    user_id: req.userId || null,
    device_id: req.deviceId || null,
    ip: req.clientIp,
    api: action,
    resource_id: resourceId || null,
    resource_source: resourceSource || null,
    library: library || null,
    prompt_id: resourceId || null,
    token_jti: tokenJti || null,
    decoy: !!decoy,
    ...extra,
  }).catch(err => console.error('[content] behavior log failed:', err.message));
}

function promptBodyPayload(found, watermark = null, options = {}) {
  const meta = promptListItem(found);
  const promptText = Object.prototype.hasOwnProperty.call(options, 'promptText')
    ? options.promptText
    : found.prompt_text;
  return {
    ok: true,
    id: meta.id,
    title: meta.title,
    category: meta.category,
    original_category: meta.original_category,
    special_collection: meta.special_collection,
    type: meta.type,
    page_type: meta.page_type,
    sort_order: meta.sort_order,
    is_free: meta.is_free,
    prompt_text: promptText || null,
    preview_image_url: meta.preview_image_url,
    preview_thumb_url: meta.preview_thumb_url,
    preview_video_url: meta.preview_video_url,
    playable_video_url: meta.playable_video_url,
    watermark,
    decoy: !!options.decoy,
  };
}

function ideaBodyPayload(item, watermark = null, options = {}) {
  const promptText = Object.prototype.hasOwnProperty.call(options, 'promptText')
    ? options.promptText
    : item.prompt_text;
  return {
    ok: true,
    ...ideaListItem(item),
    prompt_text: promptText ? (item?.source === 'image_ideas' ? scrubImgAiBrandText(promptText) : promptText) : null,
    watermark,
    decoy: !!options.decoy,
  };
}

const inviteLocks = new Map();

function inviteLockKey(scope, id) {
  return `invite:${scope}:${id || 'unknown'}`;
}

function getInviteLock(scope, id) {
  const key = inviteLockKey(scope, id);
  const until = inviteLocks.get(key) || 0;
  if (until <= Date.now()) {
    inviteLocks.delete(key);
    return 0;
  }
  return until;
}

function assertInviteFailureAllowed(req, res, { includeAccount = false } = {}) {
  const ipUntil = getInviteLock('ip', req.clientIp);
  const accountUntil = includeAccount ? getInviteLock('account', req.userId) : 0;
  const until = Math.max(ipUntil, accountUntil);
  if (!until) return false;
  const retryMs = until - Date.now();
  res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
  res.status(429).json({
    ok: false,
    error: 'invite_risk_locked',
    message: '邀请码失败次数过多，已临时锁定，请稍后再试',
    retry_after_ms: retryMs,
  });
  return true;
}

function recordInviteFailure(req, {
  phase,
  reason = 'invalid_code',
  accountId = null,
  username = null,
} = {}) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const lockMs = 10 * 60 * 1000;
  const ipKey = inviteLockKey('fail_ip_window', req.clientIp);
  recordHit(ipKey);
  const ipFailures = countInWindow(ipKey, windowMs);
  let accountFailures = 0;
  if (accountId) {
    const accountKey = inviteLockKey('fail_account_window', accountId);
    recordHit(accountKey);
    accountFailures = countInWindow(accountKey, windowMs);
  }
  const events = [{
    type: 'invite_code_failed',
    phase,
    reason,
    ip: req.clientIp,
    user_id: accountId || null,
    username: username || null,
    ip_failures_10m: ipFailures,
    account_failures_10m: accountFailures || null,
  }];
  if (ipFailures >= 5) {
    inviteLocks.set(inviteLockKey('ip', req.clientIp), now + lockMs);
    events.push({
      type: 'invite_ip_temporarily_locked',
      reason,
      phase,
      ip: req.clientIp,
      failures_10m: ipFailures,
      expires_at: new Date(now + lockMs).toISOString(),
    });
  }
  if (accountId && accountFailures >= 5) {
    inviteLocks.set(inviteLockKey('account', accountId), now + lockMs);
    events.push({
      type: 'invite_account_redeem_locked',
      reason,
      phase,
      ip: req.clientIp,
      user_id: accountId,
      username: username || null,
      failures_10m: accountFailures,
      expires_at: new Date(now + lockMs).toISOString(),
    });
  }
  if (ipFailures >= 10) {
    events.push({
      type: 'invite_many_accounts_same_ip_failed',
      reason,
      phase,
      ip: req.clientIp,
      failures_10m: ipFailures,
      user_id: accountId || null,
    });
  }
  for (const event of events) {
    db.appendLog('security_event', event).catch(err => console.error('[invite] failure log error:', err.message));
  }
}

async function registrationIdentityCounts({ ip, deviceId }) {
  const rows = await mysqlQuery(
    `SELECT
       (
         SELECT COUNT(DISTINCT d.user_id)
         FROM user_device d
         INNER JOIN accounts a ON a.id = d.user_id
         WHERE d.ip = ?
       ) AS ip_count,
       (
         SELECT COUNT(DISTINCT d.user_id)
         FROM user_device d
         INNER JOIN accounts a ON a.id = d.user_id
         WHERE d.device_id = ?
       ) AS device_count`,
    [ip || '', deviceId || ''],
  );
  return {
    ipCount: Number(rows[0]?.ip_count || 0),
    deviceCount: Number(rows[0]?.device_count || 0),
  };
}

async function denyIfRegistrationIdentityLimited(req, res, { clientFp = '', username = '' } = {}) {
  const deviceId = deriveDeviceId({
    ua: req.headers['user-agent'] || '',
    ip: req.clientIp,
    clientFp: clientFp || '',
  });
  const counts = await registrationIdentityCounts({ ip: req.clientIp, deviceId });
  const byIp = counts.ipCount >= MAX_REGISTER_ACCOUNTS_PER_IDENTITY;
  const byDevice = counts.deviceCount >= MAX_REGISTER_ACCOUNTS_PER_IDENTITY;
  if (!byIp && !byDevice) return { limited: false, deviceId, counts };

  db.appendLog('security_event', {
    type: 'register_identity_limited',
    ip: req.clientIp,
    device_id: deviceId,
    username: username || null,
    ip_registered_accounts: counts.ipCount,
    device_registered_accounts: counts.deviceCount,
    limit: MAX_REGISTER_ACCOUNTS_PER_IDENTITY,
    blocked_by: [byIp ? 'ip' : null, byDevice ? 'device' : null].filter(Boolean),
  }).catch(err => console.error('[register] identity limit log error:', err.message));

  res.status(429).json({
    ok: false,
    error: 'registration_identity_limit',
    message: `当前IP或设备注册账号数量已达上限（最多${MAX_REGISTER_ACCOUNTS_PER_IDENTITY}个），请联系管理员处理。`,
    limit: MAX_REGISTER_ACCOUNTS_PER_IDENTITY,
    ip_registered_accounts: counts.ipCount,
    device_registered_accounts: counts.deviceCount,
    blocked_by_ip: byIp,
    blocked_by_device: byDevice,
  });
  return { limited: true, deviceId, counts };
}

async function getAuthFromCookie(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload) return null;
  // Check session not revoked BEFORE the user lookup (cheap O(1))
  if (payload.jti && await isSessionRevoked(payload.jti)) return null;
  // Try account first (newer identity), then fall back to legacy invite code.
  // Both share the JWT subject id space and are prefixed distinctly (u_ vs c_).
  let user = null;
  let kind = null;
  let account = null;
  let code = null;
  if (payload.sub && payload.sub.startsWith('u_')) {
    const a = await accounts.findById(payload.sub);
    if (a && !a.revoked) {
      user = accountAsCodeLike(a);
      kind = 'account';
      account = a;
      // Cache the invite-code lookup that membershipForAuth() needs so the
      // per-request handler doesn't repeat the round-trip.
      code = a.promoted_from_code ? await store.findById(a.promoted_from_code) : null;
    }
  }
  if (!user) {
    const all = await store.readAll();
    const c = all.find(x => x.id === payload.sub);
    if (c && !c.revoked) { user = c; kind = 'code'; code = c; }
  }
  if (!user) return null;
  return { user, payload, kind, account, code };
}

async function getRevokedAccountFromCookie(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload || !payload.sub || !payload.sub.startsWith('u_')) return null;
  const account = await accounts.findById(payload.sub);
  if (!account || !account.revoked) return null;
  return { account, payload };
}

// Attach req.auth + req.deviceIdentity; never throw, just leave undefined.
// We deliberately store derived fields on a sub-object (req._pv) because
// newer Express makes req.clientIp a read-only getter.
app.use(asyncHandler(async (req, _res, next) => {
  try {
    const auth = await getAuthFromCookie(req);
    if (auth) {
      req.auth = auth;
      req.code = auth.user; // legacy alias — both code entries and synthetic account-as-code carry the same shape
      req.userKind = auth.kind; // 'account' | 'code'
      req.deviceId = auth.payload.did;
      req.jti = auth.payload.jti;
      req.userId = auth.user.id;
    }
  } catch (err) {
    // Don't fail the request on a transient DB error during auth — treat as
    // unauthenticated so the login flow still works. Logged for ops triage.
    console.error('[auth] cookie lookup failed:', err.message);
  }
  req._pv = {
    ip: getClientIp(req),
    uaInfo: parseUA(req.headers['user-agent'] || ''),
  };
  // req.clientIp is read-only on Express 4.21+; expose via req._pv instead and
  // alias on req.clientIp for handlers that want a stable name.
  req.clientIp = req._pv.ip;
  req.clientUaInfo = req._pv.uaInfo;
  next();
}));

function requireAuth(req, res, next) {
  if (!req.auth) {
    if (req.path.startsWith('/api/')) {
      return sendProtectedJson(res, 401, {
        ok: false,
        error: 'unauthorized',
        message: '请先登录后再访问该内容',
      });
    }
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const username = req.auth?.account?.username || req.code?.__username || req.code?.username || req.code?.label || null;
  if (ADMIN_USER_IDS.size === 0 && ADMIN_USERNAMES.size === 0) {
    return res.status(503).json({ ok: false, error: 'admin_not_configured' });
  }
  if (ADMIN_USER_IDS.has(req.userId)) return next();
  if (username && ADMIN_USERNAMES.has(username)) return next();
  return res.status(403).json({ ok: false, error: 'forbidden' });
}

// ---------- Global gateway: IP-level rate limit + per-IP burst ----------
const GLOBAL_IP_LIMIT = parseInt(process.env.GLOBAL_IP_LIMIT || '600', 10); // req/min/IP
app.use(asyncHandler(async (req, res, next) => {
  const ipKey = `ip:${req.clientIp}`;
  const r = take(ipKey, GLOBAL_IP_LIMIT, GLOBAL_IP_LIMIT / 60);
  res.setHeader('X-RateLimit-Limit', String(GLOBAL_IP_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, r.remaining)));
  if (!r.ok) {
    res.setHeader('Retry-After', String(Math.ceil(r.resetMs / 1000)));
    return res.status(429).json({ ok: false, error: 'too_many_requests', retry_after_ms: r.resetMs });
  }

  // IP block list (cached server-wide for one process via isIpBlocked())
  try {
    if (await isIpBlocked(req.clientIp)) {
      return res.status(403).json({ ok: false, error: 'ip_blocked' });
    }
  } catch (err) {
    // If the DB is briefly unreachable, fail open — the per-route guards
    // still apply and the next request will retry the lookup.
    console.error('[ip_block] lookup failed:', err.message);
  }

  next();
}));

// Per-user behavior inspection (only for authenticated traffic).
// Whitelist auth-lifecycle endpoints (logout, /api/me read-only) — they must
// always work even if the user is being rate-limited for content scraping.
const INSPECT_WHITELIST = /^\/api\/(logout|me|devices|admin\/security|captcha\/new)$/;
app.use(asyncHandler(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (!req.auth) return next(); // unauthenticated traffic handled by route-level guards
  if (INSPECT_WHITELIST.test(req.path)) return next();
  const r = inspect({ userId: req.userId, deviceId: req.deviceId, ip: req.clientIp, path: req.path });
  if (!r.allowed) {
    const isContentAbuse = r.cls && /^(prompt_list|prompt_access|prompt_detail|file_download|video_segment)$/.test(r.cls);
    const retryAfterMs = r.banTtlMs || 60_000;

    db.appendLog('security_event', {
      type: 'behavior_blocked',
      user_id: req.userId,
      device_id: req.deviceId,
      ip: req.clientIp,
      jti: req.jti,
      cls: r.cls,
      prompt_id: r.promptId || null,
      reason: r.reason,
      score: r.score || 0,
      limit: r.limit ?? null,
      current: r.current ?? null,
      action: r.action || null,
      distinct_prompts: r.distinctPrompts ?? null,
      window_ms: r.windowMs ?? null,
    }).catch(err => console.error('[behavior] block log failed:', err.message));

    // Open the circuit on the current session before we reply so the same
    // cookie cannot keep draining prompt bodies in the background.
    if (r.action === 'revoke_session' && req.jti) {
      await db.update('user_session', req.jti, {
        revoked: true,
        revoked_at: new Date().toISOString(),
      });
      clearSessionCookie(res);
    } else if (r.action === 'revoke_all_sessions') {
      await revokeAllSessionsForUser(req.userId);
      clearSessionCookie(res);
    }

    if (r.score >= 80 && isContentAbuse) {
      autoBan({
        ip: req.clientIp,
        userId: req.userId,
        reason: r.reason,
        ttlMs: retryAfterMs,
      });
    }

    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    return res.status(r.action ? 403 : 429).json({
      ok: false,
      error: r.action ? 'scrape_blocked' : 'too_many_requests',
      reason: r.reason,
      limit: r.limit,
      current: r.current,
      action: r.action || null,
      retry_after_ms: retryAfterMs,
    });
  }
  next();
}));

// ---------- Login page (portal SPA) ----------
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send('User-agent: *\nDisallow: /\n');
});

app.get('/login', (req, res) => {
  if (req.auth) return res.redirect('/');
  const indexHtml = path.join(PORTAL_DIST, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return res.status(503).send(
      'Portal not built yet. Run `cd portal && npm install && npm run build`.'
    );
  }
  // Pass risk info as HTML-attribute embed if a prior risk event redirected here.
  const riskParam = req.query.risk === '1' ? ' data-risk-step="verify"' : '';
  let html = fs.readFileSync(indexHtml, 'utf8');
  if (riskParam) html = html.replace('<div id="root">', `<div id="root"${riskParam}>`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  res.send(html);
});

// ---------- CAPTCHA endpoints ----------
app.get('/api/captcha/new', asyncHandler(async (req, res) => {
  const c = await issueCaptcha();
  res.json({ ok: true, ...c });
}));
app.post('/api/captcha/verify', asyncHandler(async (req, res) => {
  const { challenge_id, answer } = req.body || {};
  if (!challenge_id || answer == null) return res.status(400).json({ ok: false, error: 'missing_params' });
  const r = await verifyCaptcha({ challenge_id, answer: Number(answer) });
  res.json({ ok: r.ok, reason: r.reason || null });
}));

// ---------- LOGIN (mode='password', with risk + device binding) ----------
app.post('/api/login', asyncHandler(async (req, res) => {
  const start = Date.now();
  const {
    mode = 'password',
    username,
    password,
    website,
    contact_method,
    captcha_id,
    captcha_answer,
    client_fp,
    next = '/',
  } = req.body || {};

  const filledTrapFields = collectFilledHoneypotFields({ website, contact_method });
  if (filledTrapFields.length && isTrustedHoneypotRequest(req)) {
    await triggerHoneypot(req, res, {
      kind: 'auth_form_fill',
      source: 'login_form',
      severity: 'high',
      action: 'revoke_session',
      fields: filledTrapFields,
      detail: { mode: String(mode || 'password') },
    });
    return res.status(403).json({
      ok: false,
      error: 'risk_blocked',
      message: '请求已被安全策略拦截，请稍后再试。',
    });
  }

  // Per-IP login throttling (10/min) — separate from global limit so login
  // bursts stand out from regular browsing.
  const loginKey = `login:${req.clientIp}`;
  const lr = take(loginKey, 10, 10 / 60);
  if (!lr.ok) {
    return res.status(429).json({ ok: false, error: '登录尝试过于频繁，请稍后再试' });
  }

  if (mode !== 'password') {
    return res.status(410).json({
      ok: false,
      error: 'code_login_removed',
      message: '邀请码登录已关闭，请先用邀请码注册账号，再使用用户名密码登录',
    });
  }

  // ----- Identify the account candidate -----
  let account = null;
  let lookupError = null;

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ ok: false, error: '请输入用户名与密码' });
  }
  const found = await accounts.verifyPassword(username, password);
  if (!found) {
    const revokedCandidate = await accounts.verifyPasswordIncludingRevoked(username, password);
    if (revokedCandidate?.revoked) {
      db.appendLog('security_event', {
        type: 'login_blocked_revoked_account',
        user_id: revokedCandidate.id,
        mode,
        ip: req.clientIp,
        ua: req.headers['user-agent'],
      }).catch(err => console.error('[login] revoked-event log error:', err.message));
      return res.status(403).json({
        ok: false,
        error: 'account_banned',
        title: ACCOUNT_BANNED_TITLE,
        message: ACCOUNT_BANNED_MESSAGE.join('\n\n'),
        message_lines: ACCOUNT_BANNED_MESSAGE,
        revoked_reason: revokedCandidate.revoked_reason || null,
        revoked_at: revokedCandidate.revoked_at || null,
      });
    }
    lookupError = '用户名或密码错误';
  } else {
    account = { id: found.id, username: found.username, kind: 'account' };
  }

  if (!account) {
    db.appendLog('security_event', {
      type: 'login_failed', mode, ip: req.clientIp, ua: req.headers['user-agent'],
      username_hint: mode === 'password' ? String(username || '').slice(0, 4) : undefined,
    }).catch(err => console.error('[login] failed-event log error:', err.message));
    return res.status(401).json({ ok: false, error: lookupError || '登录失败' });
  }

  // Risk evaluation (uses the same userId (account.id) — risk service treats it as opaque string)
  const risk = await evaluateLoginRisk({
    userId: account.id, ua: req.headers['user-agent'] || '',
    ip: req.clientIp, clientFp: client_fp || '',
  });

  if (risk.level === 'high') {
    db.appendLog('security_event', {
      type: 'login_high_risk_blocked', user_id: account.id, mode, ip: req.clientIp,
      reasons: risk.reasons, score: risk.score,
    }).catch(err => console.error('[login] high-risk log error:', err.message));
    await revokeAllSessionsForUser(account.id);
    return res.status(403).json({
      ok: false, error: 'risk_blocked', reasons: risk.reasons,
      message: '登录被风控拦截，请联系客服。',
    });
  }

  if (risk.level === 'medium') {
    if (!captcha_id || captcha_answer == null) {
      const c = await issueCaptcha();
      return res.status(401).json({
        ok: false, error: 'captcha_required', captcha: c,
        reasons: risk.reasons, score: risk.score,
      });
    }
    const cv = await verifyCaptcha({ challenge_id: captcha_id, answer: Number(captcha_answer) });
    if (!cv.ok) {
      return res.status(401).json({
        ok: false, error: 'captcha_wrong', reasons: risk.reasons,
      });
    }
    db.appendLog('login_risk', {
      type: 'medium_risk_cleared', user_id: account.id, ip: req.clientIp,
      reasons: risk.reasons, score: risk.score,
    }).catch(err => console.error('[login] risk log error:', err.message));
  }

  // Device binding (with limit enforcement)
  const reg = await registerDevice({
    userId: account.id, ua: req.headers['user-agent'] || '',
    ip: req.clientIp, clientFp: client_fp || '',
  });

  if (!reg.ok && reg.reason === 'device_limit') {
    return res.status(409).json({
      ok: false, error: 'device_limit',
      message: `已达设备上限 (${reg.limit}台)。请在已登录设备上踢出新设备后再试。`,
      existing_devices: reg.existingDevices.map(d => ({
        device_id: d.device_id, browser: d.browser, os: d.os,
        last_active_time: d.last_active_time, location: d.location,
      })),
    });
  }

  const jti = newJti();
  const token = signSessionToken({ codeId: account.id, deviceId: reg.device.device_id, ip: req.clientIp, jti });
  await recordSession({
    jti, userId: account.id, deviceId: reg.device.device_id,
    ip: req.clientIp, ua: req.headers['user-agent'] || '',
    expires_at: new Date(Date.now() + COOKIE_MAX_AGE_MS).toISOString(),
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: COOKIE_MAX_AGE_MS,
  });

  // Record login stat on the underlying record (account or code).
  if (account.kind === 'account') {
    await activateAccountMembership(account.id);
    await accounts.recordLogin(account.id);
  } else {
    await store.activateMembership(account.id);
    await store.recordUse(account.id);
  }

  db.appendLog('security_event', {
    type: 'login_ok', user_id: account.id, mode, ip: req.clientIp,
    device_id: reg.device.device_id, ms: Date.now() - start,
  }).catch(err => console.error('[login] success log error:', err.message));

  res.json({ ok: true, next, device_id: reg.device.device_id, kind: account.kind });
}));

// ---------- REGISTER (optional invite-code upgrade, otherwise normal account) ----------
// Body: { code?, captcha_id?, captcha_answer?, client_fp?, username, password }
// Behaviour:
//   1. Validate username (4-20 chars, charset) + uniqueness (case-sensitive).
//   2. If a code is provided, verify invite-code plaintext (bcrypt) — must be unused, not revoked, not promoted.
//   3. bcrypt the password, create an account record, and if this was an invite, mark the code consumed_for_account.
//   4. Reuse the same risk+captcha+device pipeline as login.
//   5. Mint session cookie immediately so the user lands logged-in (we still cap the device list).
app.post('/api/register', asyncHandler(async (req, res) => {
  const start = Date.now();
  const {
    code, username, password,
    website, contact_method,
    captcha_id, captcha_answer, client_fp,
  } = req.body || {};

  const filledTrapFields = collectFilledHoneypotFields({ website, contact_method });
  if (filledTrapFields.length && isTrustedHoneypotRequest(req)) {
    await triggerHoneypot(req, res, {
      kind: 'register_form_fill',
      source: 'register_form',
      severity: 'critical',
      action: 'revoke_session',
      fields: filledTrapFields,
      detail: { has_code: !!(typeof code === 'string' && code.trim()) },
    });
    return res.status(403).json({
      ok: false,
      error: 'risk_blocked',
      message: '请求已被安全策略拦截，请稍后再试。',
    });
  }

  // Throttle: per-IP and per-code. Same key namespace idea as login so refills match human latency.
  const ipThrottle = take(`register:ip:${req.clientIp}`, 5, 5 / (10 * 60));
  if (!ipThrottle.ok) {
    return res.status(429).json({ ok: false, error: '注册尝试过于频繁，请稍后再试' });
  }
  if (assertInviteFailureAllowed(req, res)) return;
  if ((code != null && typeof code !== 'string') || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: '请求参数不完整' });
  }
  // Pre-validate username/password shape before doing any bcrypt work (cheap).
  const uv = accounts.validateUsername(username);
  if (!uv.ok) return res.status(400).json({ ok: false, error: uv.error });
  const pv = accounts.validatePassword(password);
  if (!pv.ok) return res.status(400).json({ ok: false, error: pv.error });

  const identityLimit = await denyIfRegistrationIdentityLimited(req, res, {
    clientFp: client_fp || '',
    username: uv.value,
  });
  if (identityLimit.limited) return;

  const hasInvite = typeof code === 'string' && code.trim().length > 0;
  let entry = null;
  if (hasInvite) {
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    if (![32, 50].includes(normalized.length)) {
      recordInviteFailure(req, { phase: 'register', reason: 'invalid_code_format', username: uv.value });
      return res.status(400).json({ ok: false, error: '邀请码格式不正确（应为 32 位；旧邀请码 50 位也可用）' });
    }

    // Find the invite; reject if consumed/revoked/promoted.
    entry = await store.findByPlaintext(normalized);
    if (!entry) {
      recordInviteFailure(req, { phase: 'register', reason: 'invalid_code', username: uv.value });
      db.appendLog('security_event', { type: 'register_failed', reason: 'invalid_code', ip: req.clientIp })
        .catch(err => console.error('[register] log error:', err.message));
      return res.status(401).json({ ok: false, error: '邀请码无效' });
    }
    if (entry.revoked) {
      return res.status(409).json({ ok: false, error: '邀请码已吊销' });
    }
    if (store.isLoginDisabled(entry)) {
      return res.status(409).json({ ok: false, error: '邀请码已被注册过' });
    }

    // Per-code throttle (after we know it's a real code, so a single attacker can't burn the global limit).
    const codeThrottle = take(`register:code:${entry.id}`, 3, 3 / (10 * 60));
    if (!codeThrottle.ok) {
      return res.status(429).json({ ok: false, error: '此邀请码注册尝试过于频繁' });
    }
  }

  // Risk evaluation — treat registration like a login for risk purposes.
  const risk = await evaluateLoginRisk({
    userId: entry?.id || null, ua: req.headers['user-agent'] || '',
    ip: req.clientIp, clientFp: client_fp || '',
  });
  if (risk.level === 'high') {
    db.appendLog('security_event', { type: 'register_high_risk_blocked', ip: req.clientIp, reasons: risk.reasons })
      .catch(err => console.error('[register] log error:', err.message));
    return res.status(403).json({ ok: false, error: 'risk_blocked', message: '注册被风控拦截，请联系客服。' });
  }
  if (risk.level === 'medium') {
    if (!captcha_id || captcha_answer == null) {
      const c = await issueCaptcha();
      return res.status(401).json({ ok: false, error: 'captcha_required', captcha: c });
    }
    const cv = await verifyCaptcha({ challenge_id: captcha_id, answer: Number(captcha_answer) });
    if (!cv.ok) return res.status(401).json({ ok: false, error: 'captcha_wrong' });
  }

  const accountKind = entry ? 'promoted' : 'registered';
  const promotedFromCode = entry ? entry.id : null;
  const membershipPatch = entry ? (activationPatch(entry) || {
    membership_years: entry.membership_years ?? null,
    activated_at: entry.activated_at ?? null,
    expires_at: entry.expires_at ?? null,
  }) : null;
  let acct;
  try {
    if (entry) {
      acct = await transaction(async (conn) => {
        const created = await accounts.createAccount({
          username: uv.value, password: pv.value,
          kind: accountKind, promoted_from_code: promotedFromCode,
          note: 'auto-registered via invite',
          membership_years: membershipPatch?.membership_years ?? null,
          activated_at: membershipPatch?.activated_at ?? null,
          expires_at: membershipPatch?.expires_at ?? null,
        }, conn);
        const consumed = await store.consumeForPromotion(entry.id, created.id, conn);
        if (!consumed) {
          const err = new Error('邀请码已被使用');
          err.code = 'code_already_used';
          throw err;
        }
        if (membershipPatch?.activated_at || membershipPatch?.expires_at) {
          await conn.execute(
            `UPDATE codes
             SET activated_at = ?,
                 expires_at = ?,
                 updated_at = ?
             WHERE id = ?`,
            [
              toMysqlDt(membershipPatch.activated_at),
              toMysqlDt(membershipPatch.expires_at),
              toMysqlDt(new Date()),
              entry.id,
            ]
          );
        }
        return created;
      });
    } else {
      acct = await accounts.createAccount({
        username: uv.value, password: pv.value,
        kind: accountKind, promoted_from_code: promotedFromCode,
        note: 'self-registered account',
        membership_years: null,
        activated_at: null,
        expires_at: null,
      });
    }
  } catch (e) {
    if (e && e.code === 'username_taken') {
      return res.status(409).json({ ok: false, error: '用户名已被占用' });
    }
    if (e && e.code === 'code_already_used') {
      return res.status(409).json({ ok: false, error: '邀请码已被注册过' });
    }
    return res.status(400).json({ ok: false, error: e.message || '注册失败' });
  }

  // Device binding for the new account.
  const reg = await registerDevice({
    userId: acct.id, ua: req.headers['user-agent'] || '',
    ip: req.clientIp, clientFp: client_fp || '',
  });

  if (!reg.ok && reg.reason === 'device_limit') {
    return res.status(409).json({
      ok: false, error: 'device_limit',
      message: `已达设备上限 (${reg.limit}台)。`,
    });
  }

  const jti = newJti();
  const token = signSessionToken({ codeId: acct.id, deviceId: reg.device.device_id, ip: req.clientIp, jti });
  await recordSession({
    jti, userId: acct.id, deviceId: reg.device.device_id,
    ip: req.clientIp, ua: req.headers['user-agent'] || '',
    expires_at: new Date(Date.now() + COOKIE_MAX_AGE_MS).toISOString(),
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: COOKIE_MAX_AGE_MS,
  });
  // First login counts.
  await accounts.recordLogin(acct.id);

  db.appendLog('security_event', {
    type: 'register_ok', user_id: acct.id, from_code: entry?.id || null, ip: req.clientIp,
    device_id: reg.device.device_id, ms: Date.now() - start,
  }).catch(err => console.error('[register] log error:', err.message));

  res.json({ ok: true, next: '/', device_id: reg.device.device_id, username: acct.username });
}));

app.post('/api/logout', asyncHandler(async (req, res) => {
  if (req.jti) {
    await db.update('user_session', req.jti, { revoked: true, revoked_at: new Date().toISOString() });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}));

app.post('/api/trap/honeypot', asyncHandler(async (req, res) => {
  if (!isTrustedHoneypotRequest(req)) return res.status(204).end();
  const rawKind = sanitizeTrapKind(req.body?.kind, 'dom_trap');
  const severity = ['medium', 'high', 'critical'].includes(req.body?.severity)
    ? req.body.severity
    : (/export|dump|bulk|copy_all/i.test(rawKind) ? 'critical' : 'high');
  let detail = null;
  if (req.body?.detail && typeof req.body.detail === 'object') {
    try {
      detail = JSON.parse(JSON.stringify(req.body.detail).slice(0, 4000));
    } catch {
      detail = { parse_failed: true };
    }
  }
  await triggerHoneypot(req, res, {
    kind: rawKind,
    source: 'dom_honeypot',
    severity,
    action: 'serve_decoy',
    detail,
  });
  res.status(204).end();
}));

// ---------- Pages ----------
app.get('/', requireAuth, (_req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  res.sendFile(path.join(__dirname,'public','app.html'));
});
app.get('/app', requireAuth, (_req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  res.sendFile(path.join(__dirname,'public','app.html'));
});
app.get('/me', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'me.html')));
app.get('/admin/security', requireAuth, requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'security.html')));
app.get('/admin/content', requireAuth, requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'content.html')));

// ---------- Authenticated APIs ----------

// /api/me — unified user view for both invite-code and account identities.
// Legacy fields (member_days, use_count, note, created_at, last_used_at, masked, id)
// are preserved so me.html keeps working unchanged. New fields `kind` and
// `username` are added so newer UIs can distinguish identity type cleanly.
app.get('/api/me', asyncHandler(async (req, res) => {
  const decoyClearedAt = await getDecoyClearAt(req);
  if (decoyClearedAt) {
    res.clearCookie(DECOY_COOKIE_NAME, {
      sameSite: 'lax',
      secure: IS_PRODUCTION,
      path: '/',
    });
  }
  if (!req.auth && req.query.optional === '1') {
    const revoked = await getRevokedAccountFromCookie(req);
    if (revoked) {
      return res.json({
        ok: true,
        authenticated: true,
        banned: true,
        kind: 'account',
        username: revoked.account.username,
        membership: {
          is_member: false,
          is_permanent: false,
          expires_at: null,
          expires_label: '账号已封禁',
          activated_at: null,
          membership_years: null,
          reason: 'revoked',
        },
        ban_notice: {
          title: ACCOUNT_BANNED_TITLE,
          message: ACCOUNT_BANNED_MESSAGE.join('\n\n'),
          message_lines: ACCOUNT_BANNED_MESSAGE,
          revoked_reason: revoked.account.revoked_reason || null,
          revoked_at: revoked.account.revoked_at || null,
        },
        code: {
          id: revoked.account.id,
          masked: revoked.account.id.length > 8 ? `${revoked.account.id.slice(0, 4)}…${revoked.account.id.slice(-4)}` : revoked.account.id,
          label: revoked.account.username,
          note: '',
          created_at: revoked.account.created_at,
          last_used_at: revoked.account.last_login_at,
          use_count: revoked.account.login_count || 0,
          member_days: 0,
          revoked: true,
          expires_at: null,
          expires_label: '账号已封禁',
        },
        session: {
          device_id: req.deviceId,
          jti: revoked.payload.jti || null,
        },
        security: {
          decoy_cleared_at: decoyClearedAt || null,
        },
      });
    }
    return res.json({
      ok: true,
      authenticated: false,
      membership: guestMembershipPayload(),
      security: {
        decoy_cleared_at: decoyClearedAt || null,
      },
    });
  }
  if (!req.auth) return res.status(401).json({ ok: false });
  const code = req.code;
  const id = code.id || '';
  const masked = id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
  const createdAt = code.created_at ? new Date(code.created_at) : null;
  const memberDays = createdAt ? Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 86400000)) : 0;
  const devices = await listDevices(code.id);
  // The 'account' identity has its own username label; code identity uses label.
  const username = req.userKind === 'account' ? code.label : (code.__username || null);
  const membership = membershipForAuth(req);
  res.json({
    ok: true,
    kind: req.userKind || 'code', // 'account' | 'code'
    username,                     // string|null — only present for accounts
    membership: membershipPayload(membership),
    code: {
      id, masked, label: code.label, note: code.note || '',
      created_at: code.created_at, last_used_at: code.last_used_at,
      use_count: code.use_count || 0, member_days: memberDays,
      revoked: !!code.revoked,
      expires_at: membership.expires_at,
      expires_label: formatExpiresLabel(membership),
    },
    session: {
      device_id: req.deviceId,
      ip: req.clientIp,
      country: req.clientUaInfo && countryFromIp(req.clientIp),
      browser: req.clientUaInfo.browser,
      os: req.clientUaInfo.os,
      device_type: req.clientUaInfo.deviceType,
    },
    security: {
      decoy_cleared_at: decoyClearedAt || null,
    },
    devices: devices.map(d => ({
      device_id: d.device_id,
      browser: d.browser,
      os: d.os,
      device_type: d.device_type,
      ip: d.ip,
      country: d.country,
      location: d.location,
      last_active_time: d.last_active_time,
      is_current: d.device_id === req.deviceId,
    })),
  });
}));

// /api/account/redeem-invite — redeem a fresh invite code onto the current
// account so self-registered users can upgrade later, and expired members can
// renew without creating a second account.
app.post('/api/account/redeem-invite', requireAuth, asyncHandler(async (req, res) => {
  if (req.userKind !== 'account' || !req.userId) {
    return res.status(400).json({ ok: false, error: 'account_required' });
  }

  const redeemThrottle = take(`redeem:account:${req.userId}`, 5, 5 / (10 * 60));
  if (!redeemThrottle.ok) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts', message: '兑换尝试过于频繁，请稍后再试' });
  }
  if (assertInviteFailureAllowed(req, res, { includeAccount: true })) return;

  const rawCode = String(req.body?.code || '').trim();
  if (!rawCode) {
    return res.status(400).json({ ok: false, error: 'missing_code', message: '请输入邀请码' });
  }

  const normalized = rawCode.replace(/[\s-]/g, '').toUpperCase();
  if (![32, 50].includes(normalized.length)) {
    recordInviteFailure(req, {
      phase: 'redeem',
      reason: 'invalid_code_format',
      accountId: req.userId,
      username: req.auth?.account?.username || null,
    });
    return res.status(400).json({ ok: false, error: 'invalid_code_format', message: '邀请码格式不正确（应为 32 位；旧邀请码 50 位也可用）' });
  }

  const account = await accounts.findById(req.userId);
  if (!account) return res.status(404).json({ ok: false, error: 'account_not_found' });

  const currentSourceCode = account.promoted_from_code ? await store.findById(account.promoted_from_code) : null;
  const currentMembership = resolveAccountMembership(account, currentSourceCode);
  if (currentMembership.is_member && currentMembership.is_permanent) {
    return res.status(409).json({ ok: false, error: 'already_permanent_member', message: '当前账号已是永久会员，无需再次兑换' });
  }

  const entry = await store.findByPlaintext(normalized);
  if (!entry) {
    recordInviteFailure(req, {
      phase: 'redeem',
      reason: 'invalid_code',
      accountId: req.userId,
      username: account.username || null,
    });
    db.appendLog('security_event', { type: 'redeem_failed', reason: 'invalid_code', user_id: req.userId, ip: req.clientIp })
      .catch(err => console.error('[redeem] log error:', err.message));
    return res.status(401).json({ ok: false, error: 'invalid_code', message: '邀请码无效' });
  }
  if (entry.revoked) {
    return res.status(409).json({ ok: false, error: 'revoked_code', message: '邀请码已吊销' });
  }
  if (store.isLoginDisabled(entry) || entry.consumed_for_account) {
    return res.status(409).json({ ok: false, error: 'code_already_used', message: '邀请码已被使用' });
  }

  const redeemedAt = new Date().toISOString();
  let membershipPatch;
  if (isLegacyPermanent(entry)) {
    membershipPatch = {
      membership_years: null,
      activated_at: redeemedAt,
      expires_at: null,
    };
  } else {
    const years = entry.membership_years ?? DEFAULT_MEMBERSHIP_YEARS;
    const baseIso = currentMembership.is_member && currentMembership.expires_at
      ? currentMembership.expires_at
      : redeemedAt;
    membershipPatch = {
      membership_years: years,
      activated_at: redeemedAt,
      expires_at: addYears(baseIso, years),
    };
  }

  const nextNote = (!account.note || account.note === 'self-registered account')
    ? 'upgraded via invite'
    : account.note;

  try {
    await transaction(async (conn) => {
      const consumed = await store.consumeForPromotion(entry.id, account.id, conn);
      if (!consumed) {
        const err = new Error('邀请码已被使用');
        err.code = 'code_already_used';
        throw err;
      }
      const updated = await accounts.applyInviteRedemption(account.id, {
        promoted_from_code: entry.id,
        membership_years: membershipPatch.membership_years,
        activated_at: membershipPatch.activated_at,
        expires_at: membershipPatch.expires_at,
        kind: 'promoted',
        note: nextNote,
      }, conn);
      if (!updated) {
        const err = new Error('account_not_found');
        err.code = 'account_not_found';
        throw err;
      }
    });
  } catch (err) {
    if (err?.code === 'code_already_used') {
      return res.status(409).json({ ok: false, error: 'code_already_used', message: '邀请码已被使用' });
    }
    if (err?.code === 'account_not_found') {
      return res.status(404).json({ ok: false, error: 'account_not_found' });
    }
    throw err;
  }

  const updatedAccount = await accounts.findById(account.id);
  const updatedCode = updatedAccount?.promoted_from_code ? await store.findById(updatedAccount.promoted_from_code) : null;
  const updatedMembership = resolveAccountMembership(updatedAccount, updatedCode);
  db.appendLog('security_event', {
    type: 'invite_redeemed_for_account',
    user_id: account.id,
    by: req.userId,
    ip: req.clientIp,
    code_id: entry.id,
  }).catch(err => console.error('[redeem] log error:', err.message));

  res.json({
    ok: true,
    membership: membershipPayload(updatedMembership),
    code_id: entry.id,
  });
}));

// ---------- Announcements ----------
// Public read endpoint — any logged-in user can fetch active announcements.
// Returns pinned-first, then newest-first. Expired or inactive rows are hidden.
app.get('/api/announcements', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ ok: true, announcements: await announcements.listActive() });
}));

// ---------- User messages ----------
// Admin-to-user inbox. Users can only read and mark messages that belong to
// the authenticated identity.
app.get('/api/messages', requireAuth, asyncHandler(async (req, res) => {
  const list = await messages.listForUser(req.userId, { limit: 50 });
  res.json({
    ok: true,
    messages: list,
    unread_count: list.filter(item => !item.read).length,
  });
}));

app.post('/api/messages/:id/read', requireAuth, asyncHandler(async (req, res) => {
  const entry = await messages.markRead(req.params.id, req.userId);
  if (!entry) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, message: entry });
}));

// /api/devices — list / kick
app.get('/api/devices', requireAuth, asyncHandler(async (req, res) => {
  res.json({ ok: true, devices: await listDevices(req.userId) });
}));
app.post('/api/devices/kick', requireAuth, asyncHandler(async (req, res) => {
  const { device_id } = req.body || {};
  if (!device_id) return res.status(400).json({ ok: false, error: 'missing_device_id' });
  if (device_id === req.deviceId) {
    return res.status(400).json({ ok: false, error: 'cannot_kick_self' });
  }
  const ok = await kickDevice(req.userId, device_id);
  res.json({ ok });
}));

const PROMPT_URL_RE = /https?:\/\/[^\s<>)\]"']+/g;
const IMAGE_PREVIEW_RE = /\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i;
const VIDEO_PREVIEW_RE = /\.(?:mp4|webm|mov|m4v|m3u8)(?:[?#]|$)/i;

function cleanPromptUrl(raw) {
  return String(raw || '').replace(/[`'".,;:!?，。；：！？]+$/u, '');
}

function classifyPreviewUrl(url) {
  const value = String(url || '');
  const decoded = (() => {
    try { return decodeURIComponent(value); } catch { return value; }
  })();
  if (IMAGE_PREVIEW_RE.test(value) || IMAGE_PREVIEW_RE.test(decoded)) return 'image';
  if (VIDEO_PREVIEW_RE.test(value) || VIDEO_PREVIEW_RE.test(decoded)) return 'video';
  try {
    const u = new URL(value);
    const output = (u.searchParams.get('output') || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(output)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v', 'm3u8'].includes(output)) return 'video';
  } catch {}
  return null;
}

function previewWords(value) {
  return new Set(String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && ![
      'hero',
      'preview',
      'landing',
      'page',
      'agency',
      'studio',
      'design',
      'designer',
      'portfolio',
      'website',
      'assets',
      'sections',
      'animated',
    ].includes(word)));
}

function isCompatiblePromptPreview(p, url) {
  const value = String(url || '');
  if (!/motionsites\.ai\/assets\/hero-/i.test(value)) return true;
  let file = value;
  try {
    file = decodeURIComponent(new URL(value).pathname.split('/').pop() || value);
  } catch {}
  const assetWords = previewWords(file
    .replace(/^hero-/i, '')
    .replace(/-preview-.*/i, '')
    .replace(/\.(?:png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v)$/i, ''));
  const promptWords = previewWords(`${p.id || ''} ${p.title || ''}`);
  if (!assetWords.size) return true;
  for (const word of assetWords) {
    if (promptWords.has(word)) return true;
  }
  return false;
}

function extractPreviewFromPromptText(p) {
  if (p.disable_auto_preview) return null;
  const promptText = p.prompt_text;
  const urls = String(promptText || '').match(PROMPT_URL_RE) || [];
  for (const raw of urls) {
    const url = cleanPromptUrl(raw);
    const kind = classifyPreviewUrl(url);
    if (kind && isCompatiblePromptPreview(p, url)) return { kind, url };
  }
  return null;
}

function promptListItem(p) {
  const explicitImage = p.preview_image_url || p.image_preview_url || null;
  const explicitVideo = p.preview_video_url || p.video_preview_url || null;
  const explicitPlayable = p.playable_video_url || null;
  const derived = (!explicitImage && !explicitVideo && !explicitPlayable)
    ? extractPreviewFromPromptText(p)
    : null;
  const previewImageUrl = explicitImage || (derived?.kind === 'image' ? derived.url : null);
  const previewVideoUrl = explicitVideo || null;
  const playableVideoUrl = explicitPlayable || (derived?.kind === 'video' ? derived.url : null);
  const previewThumbUrl = previewImageUrl ? (COVER_THUMBS[previewImageUrl] || null) : null;
  const hasPreview = !!(previewImageUrl || previewVideoUrl || playableVideoUrl);
  const wasBlindBox = p.special_collection === 'blind_box';
  const forceBlindBox = wasBlindBox && p.disable_auto_preview;

  const item = {
    id: p.id,
    title: p.title,
    category: !forceBlindBox && wasBlindBox && hasPreview && p.original_category ? p.original_category : p.category,
    original_category: p.original_category || null,
    special_collection: !forceBlindBox && wasBlindBox && hasPreview ? null : (p.special_collection || null),
    sort_order: p.sort_order,
    type: p.type,
    page_type: p.page_type,
    row_span: p.row_span,
    is_free: !!p.is_free,
    preview_image_url: previewImageUrl,
    preview_thumb_url: previewThumbUrl,
    preview_video_url: previewVideoUrl,
    playable_video_url: playableVideoUrl,
    // has_prompt_text: hint that content is available; never include the body.
    // prompt_text_length is only a coarse UI hint for the card/modal loading
    // copy; the full body still stays behind /api/prompts/:id membership gates.
    has_prompt_text: !!(p.prompt_text && !String(p.prompt_text).startsWith('(Prompt text not')),
    prompt_text_length: p.prompt_text ? String(p.prompt_text).length : 0,
  };
  return item;
}

// /api/prompts — REWRITTEN: list endpoint returns metadata ONLY.
// prompt_text is fetched chapter-by-chapter via /api/prompts/:id with a
// fresh content_token (5-min, single-use, bound to user+device+ip).
//
// Optional: ?page=N&limit=96 for pagination (default limit 96, max 96).
// We default to 96 (rather than a smaller page size) so the SPA's first fetch
// gets the whole catalog in one round-trip — the client UI then renders
// / filters / sorts entirely from that dataset.
app.get('/api/prompts', requireAuth, asyncHandler(async (req, res) => {
  if (throttleCatalogPreview(req, res)) return;
  const cache = await getBestPromptsCacheAsync();
  // Negotiate 304 — both ETag and Last-Modified supported, browser picks one.
  // Note: the catalog is per-user but the LIST metadata is identical across
  // users (only /api/prompts/:id is gated by membership), so shared caches
  // must not reuse it. Keep browser HTTP cache revalidation strict; the SPA has
  // its own localStorage catalog cache and can refresh from the network.
  res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  res.setHeader('ETag', cache.etag);
  res.setHeader('Last-Modified', cache.lastModified);
  const ifNoneMatch = req.headers['if-none-match'];
  const ifModifiedSince = req.headers['if-modified-since'];
  if ((ifNoneMatch && ifNoneMatch === cache.etag) ||
      (ifModifiedSince && new Date(ifModifiedSince).getTime() >= new Date(cache.lastModified).getTime())) {
    return res.status(304).end();
  }
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(96, Math.max(1, parseInt(req.query.limit || '96', 10)));
  const start = (page - 1) * limit;
  const items = cache.sanitized.slice(start, start + limit);
  res.json({
    ok: true,
    viewer: { authenticated: true, membership: membershipPayload(membershipForAuth(req)) },
    total: cache.sanitized.length,
    page, limit,
    has_more: start + limit < cache.sanitized.length,
    items,
  });
}));

app.all(HONEYPOT_RESOURCE_ROUTES, asyncHandler(async (req, res) => {
  if (isTrustedHoneypotRequest(req)) {
    await triggerHoneypot(req, res, {
      kind: 'fake_resource_probe',
      source: 'fake_resource',
      severity: 'critical',
      action: 'serve_decoy',
      detail: { route: req.path, query: req.query || null },
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  if (req.method === 'HEAD') return res.status(410).end();
  return res.status(410).json({ ok: false, error: 'gone' });
}));

// /api/prompts/:id — chapter-level detail.
// Requires a valid content_token issued by /api/prompts/:id/access.
app.get('/api/prompts/:id/access', requireAuth, asyncHandler(async (req, res) => {
  setProtectedBodyHeaders(res);
  const id = req.params.id;
  const cache = await getBestPromptsCacheAsync();
  const found = cache.byId.get(id);
  if (!found) return res.status(404).json({ ok: false, error: 'not_found' });

  if (isPublicPromptItem(found)) {
    const decoy = await isDecoyViewer(req);
    if (decoy) {
      db.appendLog('security_event', {
        type: 'decoy_public_prompt_served',
        user_id: req.userId || null,
        device_id: req.deviceId || null,
        ip: req.clientIp,
        prompt_id: id,
      }).catch(err => console.error('[decoy] public serve log failed:', err.message));
      return res.json({
        ...promptBodyPayload(found, null, {
          promptText: makeDecoyPromptText(found.prompt_text, { guest: !req.auth }),
          decoy: true,
        }),
        access: 'public',
      });
    }
    return res.json({
      ...promptBodyPayload(found, null),
      access: 'public',
    });
  }
  if (denyIfNotMember(req, res)) return;

  const resource = `prompt:${id}`;
  const token = await issueContentToken({
    userId: req.userId, deviceId: req.deviceId,
    ip: req.clientIp, resource,
    ttlMs: 5 * 60 * 1000,
  });
  db.appendLog('user_behavior_log', {
    user_id: req.userId, device_id: req.deviceId, ip: req.clientIp,
    api: 'prompt_detail_access', course_id: id,
  }).catch(err => console.error('[prompts] log error:', err.message));
  res.json({
    ok: true,
    resource,
    content_token: token,
    expires_in: 300,
    detail_url: `/api/prompts/${encodeURIComponent(id)}`,
  });
}));

app.get('/api/prompts/:id', requireAuth, asyncHandler(async (req, res) => {
  setProtectedBodyHeaders(res);
  if (denyIfNotMember(req, res)) return;
  if (throttleProtectedBodyRead(req, res, 'motionsites')) return;
  const id = req.params.id;
  const token = req.query.content_token || req.headers['x-content-token'];
  if (!token) {
    return sendProtectedJson(res, 401, {
      ok: false,
      error: 'content_token_required',
      message: '访问凭证缺失，请重新打开正文',
    });
  }
  const cv = await consumeContentToken({
    token, expectedResource: `prompt:${id}`,
    userId: req.userId, deviceId: req.deviceId, ip: req.clientIp,
  });
  if (!cv.ok) {
    return sendProtectedJson(res, 401, {
      ok: false,
      error: 'content_token_invalid',
      message: '访问凭证无效或已过期，请重新打开正文',
      reason: cv.reason,
    });
  }

  const cache = await getBestPromptsCacheAsync();
  const found = cache.byId.get(id);
  if (!found) return res.status(404).json({ ok: false, error: 'not_found' });

  // Watermark metadata injected on EVERY chapter read.
  const watermark = makeWatermark(req, cv.payload.jti);
  const decoy = await isDecoyViewer(req);
  if (decoy) {
    logContentBehavior(req, {
      action: 'content_body_open',
      resourceId: id,
      resourceSource: 'motionsites',
      tokenJti: cv.payload.jti,
      decoy: true,
    });
    db.appendLog('security_event', {
      type: 'decoy_prompt_served',
      user_id: req.userId,
      device_id: req.deviceId,
      ip: req.clientIp,
      prompt_id: id,
      token_jti: cv.payload.jti,
    }).catch(err => console.error('[decoy] serve log failed:', err.message));
    return res.json(promptBodyPayload(found, watermark, {
      promptText: watermarkPromptText(makeDecoyPromptText(found.prompt_text), watermark),
      decoy: true,
    }));
  }
  logContentBehavior(req, {
    action: 'content_body_open',
    resourceId: id,
    resourceSource: 'motionsites',
    tokenJti: cv.payload.jti,
  });
  res.json(promptBodyPayload(found, watermark, {
    promptText: watermarkPromptText(found.prompt_text, watermark),
  }));
}));

app.get('/api/idea-libraries/:kind', requireAuth, asyncHandler(async (req, res) => {
  const library = await getIdeaLibrary(req.params.kind);
  if (!library) return res.status(404).json({ ok: false, error: 'library_not_found' });
  if (throttleCatalogPreview(req, res)) return;
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  res.setHeader('ETag', library.etag);
  if (req.headers['if-none-match'] === library.etag) return res.status(304).end();
  res.json({
    ok: true,
    kind: req.params.kind,
    label: library.label,
    total: library.items.length,
    viewer: { authenticated: true, membership: membershipPayload(membershipForAuth(req)) },
    items: library.items,
  });
}));

app.get('/api/cover-proxy', requireAuth, asyncHandler(async (req, res) => {
  const sourceUrl = String(req.query.url || '').trim();
  const mode = req.query.mode === 'detail' ? 'detail' : 'card';
  if (!sourceUrl) return res.status(400).json({ ok: false, error: 'missing_url' });
  if (!isKnownCoverUrl(sourceUrl)) {
    return res.status(404).json({ ok: false, error: 'cover_not_found' });
  }

  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid_url' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ ok: false, error: 'invalid_protocol' });
  }

  const normalizedUrl = normalizeRemoteCoverUrl(sourceUrl, mode);
  const etag = '"' + crypto.createHash('sha1')
    .update(mode)
    .update(normalizedUrl)
    .digest('hex') + '"';
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  const upstream = await fetch(normalizedUrl, {
    signal: AbortSignal.timeout(12000),
    headers: {
      // Some remote image hosts (notably images.meigen.ai behind Cloudflare)
      // reject obviously synthetic user agents. Present as a normal browser so
      // card covers keep loading through the authenticated proxy.
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'referer': `${parsed.origin}/`,
    },
  });
  if (!upstream.ok) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(502).json({ ok: false, error: 'cover_fetch_failed', status: upstream.status });
  }
  const contentType = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(415).json({ ok: false, error: 'cover_not_image', content_type: contentType || null });
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(body.length));
  res.send(body);
}));

app.get('/api/idea-libraries/:kind/:id/access', requireAuth, asyncHandler(async (req, res) => {
  setProtectedBodyHeaders(res);
  const library = await getIdeaLibrary(req.params.kind);
  if (!library) return res.status(404).json({ ok: false, error: 'library_not_found' });
  const found = library.byId.get(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: 'not_found' });
  if (denyIfNotMember(req, res)) return;
  const resource = `idea:${req.params.kind}:${req.params.id}`;
  const token = await issueContentToken({
    userId: req.userId,
    deviceId: req.deviceId,
    ip: req.clientIp,
    resource,
    ttlMs: 5 * 60 * 1000,
  });
  db.appendLog('user_behavior_log', {
    user_id: req.userId,
    device_id: req.deviceId,
    ip: req.clientIp,
    api: 'idea_detail_access',
    library: req.params.kind,
    prompt_id: req.params.id,
  }).catch(err => console.error('[ideas] access log error:', err.message));
  res.json({
    ok: true,
    resource,
    content_token: token,
    expires_in: 300,
    detail_url: `/api/idea-libraries/${encodeURIComponent(req.params.kind)}/${encodeURIComponent(req.params.id)}`,
  });
}));

app.get('/api/idea-libraries/:kind/:id', requireAuth, asyncHandler(async (req, res) => {
  setProtectedBodyHeaders(res);
  const library = await getIdeaLibrary(req.params.kind);
  if (!library) return res.status(404).json({ ok: false, error: 'library_not_found' });
  const found = library.byId.get(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: 'not_found' });
  if (denyIfNotMember(req, res)) return;
  if (throttleProtectedBodyRead(req, res, `idea:${req.params.kind}`)) return;

  const token = req.query.content_token || req.headers['x-content-token'];
  if (!token) {
    return sendProtectedJson(res, 401, {
      ok: false,
      error: 'content_token_required',
      message: '访问凭证缺失，请重新打开正文',
    });
  }
  const cv = await consumeContentToken({
    token,
    expectedResource: `idea:${req.params.kind}:${req.params.id}`,
    userId: req.userId,
    deviceId: req.deviceId,
    ip: req.clientIp,
  });
  if (!cv.ok) {
    return sendProtectedJson(res, 401, {
      ok: false,
      error: 'content_token_invalid',
      message: '访问凭证无效或已过期，请重新打开正文',
      reason: cv.reason,
    });
  }

  const watermark = makeWatermark(req, cv.payload.jti);
  const decoy = await isDecoyViewer(req);
  if (decoy) {
    logContentBehavior(req, {
      action: 'content_body_open',
      resourceId: req.params.id,
      resourceSource: `idea:${req.params.kind}`,
      library: req.params.kind,
      tokenJti: cv.payload.jti,
      decoy: true,
    });
    db.appendLog('security_event', {
      type: 'decoy_idea_prompt_served',
      library: req.params.kind,
      user_id: req.userId,
      device_id: req.deviceId,
      ip: req.clientIp,
      prompt_id: req.params.id,
      token_jti: cv.payload.jti,
    }).catch(err => console.error('[decoy] idea serve log failed:', err.message));
    return res.json(ideaBodyPayload(found, watermark, {
      promptText: watermarkPromptText(makeDecoyPromptText(found.prompt_text), watermark),
      decoy: true,
    }));
  }
  logContentBehavior(req, {
    action: 'content_body_open',
    resourceId: req.params.id,
    resourceSource: `idea:${req.params.kind}`,
    library: req.params.kind,
    tokenJti: cv.payload.jti,
  });
  res.json(ideaBodyPayload(found, watermark, {
    promptText: watermarkPromptText(found.prompt_text, watermark),
  }));
}));

app.post('/api/content/copy', requireAuth, asyncHandler(async (req, res) => {
  if (denyIfNotMember(req, res)) return;
  const rawAction = String(req.body?.action || 'copy').trim();
  const action = rawAction === 'ai_use' ? 'content_ai_use' : 'content_copy';
  const copyBucket = take(`content:copy:user:${req.userId}:device:${req.deviceId}`, 100, 100 / (10 * 60));
  if (!copyBucket.ok) {
    db.appendLog('security_event', {
      type: 'content_copy_rate_limited',
      user_id: req.userId,
      device_id: req.deviceId,
      ip: req.clientIp,
      action,
      resource_id: req.body?.id || null,
      resource_source: req.body?.source || null,
    }).catch(err => console.error('[content] copy log failed:', err.message));
    res.setHeader('Retry-After', String(Math.ceil(copyBucket.resetMs / 1000)));
    return res.status(429).json({
      ok: false,
      error: 'too_many_copies',
      message: '复制过于频繁，请稍后再试',
      retry_after_ms: copyBucket.resetMs,
    });
  }
  logContentBehavior(req, {
    action,
    resourceId: req.body?.id || null,
    resourceSource: req.body?.source || null,
    library: req.body?.library || null,
    extra: {
      ai_url: action === 'content_ai_use' ? (req.body?.ai_url || null) : null,
    },
  });
  res.json({ ok: true });
}));

// ---------- File / PDF proxy with signed URLs ----------
// /api/file/access?id=xxx  -> returns a signed URL (5 min TTL) the front-end
// can hit directly. The actual stream endpoint /api/file/stream verifies the
// signature + user + device before streaming bytes.
app.get('/api/file/access', requireAuth, (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
  // (In production) verify user has entitlement for this file via entitlements table.
  const base = `${req.protocol}://${req.get('host')}/api/file/stream`;
  const url = signDownloadUrl({
    id, userId: req.userId, deviceId: req.deviceId,
    ttlMs: 5 * 60 * 1000, base,
  });
  logContentBehavior(req, {
    action: 'file_download_access',
    resourceId: id,
    resourceSource: 'file',
  });
  res.json({ ok: true, url, expires_in: 300 });
});

app.get('/api/file/stream', (req, res) => {
  const { id, expires, signature, payload } = req.query;
  if (!req.auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const r = verifyDownloadSignature({
    id, expires: Number(expires), signature, payload,
    userId: req.userId, deviceId: req.deviceId, ip: req.clientIp,
  });
  if (!r.ok) return res.status(403).json({ ok: false, error: r.reason });
  logContentBehavior(req, {
    action: 'file_download_stream',
    resourceId: id,
    resourceSource: 'file',
  });

  // DEMO: synthesize a tiny PDF on the fly so the route is observable.
  // In production: stream the real file from object storage with a server-side
  // fetch (never expose the bucket to the client).
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(id)}.pdf"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // minimal valid PDF header
  const pdf = `%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n` +
              `This is a watermarked preview for ${id}\n` +
              `User: ${req.userId}  Device: ${req.deviceId}  IP: ${req.clientIp}\n` +
              `Issued: ${new Date().toISOString()}\n`;
  res.send(pdf);
});

// ---------- Video HLS key issuance ----------
app.get('/api/video/:id/key', requireAuth, asyncHandler(async (req, res) => {
  if (denyIfNotMember(req, res)) return;
  const id = req.params.id;
  const token = req.query.content_token;
  if (!token) return res.status(401).json({ ok: false, error: 'content_token_required' });
  const cv = await verifyVideoKeyToken({ token, resource: id, userId: req.userId, deviceId: req.deviceId, ip: req.clientIp });
  if (!cv.ok) return res.status(401).json({ ok: false, error: 'content_token_invalid', reason: cv.reason });
  const key = issueVideoKey({ userId: req.userId, deviceId: req.deviceId, resource: id });
  db.appendLog('user_behavior_log', {
    user_id: req.userId, device_id: req.deviceId, ip: req.clientIp,
    api: 'video_segment', resource: id,
  }).catch(err => console.error('[video] log error:', err.message));
  // HLS key URI typically returns binary key. We also return base64 for JSON clients.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(key);
}));

// /api/video/:id/access — mint a 1h video key token (single-use, IP+device bound).
app.get('/api/video/:id/access', requireAuth, asyncHandler(async (req, res) => {
  if (denyIfNotMember(req, res)) return;
  const id = req.params.id;
  const token = await issueVideoKeyToken({ userId: req.userId, deviceId: req.deviceId, resource: id });
  res.json({
    ok: true,
    resource: `video:${id}`,
    content_token: token,
    expires_in: 3600,
    key_url: `/api/video/${encodeURIComponent(id)}/key`,
  });
}));

// ---------- Admin security console (read-only APIs) ----------
app.get('/api/admin/security/overview', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const today = Date.now() - 24 * 3600 * 1000;
  const [eventsAll, behAll, ipBlocksAll, sessionsAll, accountsAll] = await Promise.all([
    db.list('security_event'),
    db.list('user_behavior_log'),
    db.list('ip_block'),
    db.list('user_session'),
    accounts.listAll(),
  ]);
  const events = eventsAll.filter(e => (e.ts || 0) >= today);
  const beh = behAll.filter(e => (e.ts || 0) >= today);
  const ipBlocks = ipBlocksAll.filter(b => !b.expires_at || new Date(b.expires_at).getTime() > Date.now());
  const sessions = sessionsAll.filter(s => !s.revoked);
  const accountMap = new Map(accountsAll.map(account => [account.id, account]));

  const ipUserMap = new Map();
  function rememberIpUser(ip, userId, ts) {
    if (!ip || !userId) return;
    const key = String(ip);
    const bucket = ipUserMap.get(key) || new Map();
    const prev = bucket.get(userId);
    if (!prev || (ts || 0) > prev.last_seen_ts) {
      bucket.set(userId, {
        user_id: userId,
        username: accountMap.get(userId)?.username || null,
        last_seen_ts: ts || 0,
      });
    }
    ipUserMap.set(key, bucket);
  }

  for (const row of behAll) rememberIpUser(row.ip, row.user_id, row.ts || 0);
  for (const row of sessionsAll) {
    const ts = row.updated_at || row.created_at || 0;
    rememberIpUser(row.ip, row.user_id, new Date(ts || 0).getTime() || 0);
  }
  for (const row of eventsAll) {
    const details = securityEventDetails(row);
    rememberIpUser(row.ip || details.ip, row.user_id || details.user_id, row.ts || 0);
  }

  const activeIpBlocksByUser = new Map();
  for (const block of ipBlocks) {
    const relatedUsers = [...(ipUserMap.get(block.ip)?.values() || [])];
    for (const item of relatedUsers) {
      const bucket = activeIpBlocksByUser.get(item.user_id) || [];
      bucket.push(block);
      activeIpBlocksByUser.set(item.user_id, bucket);
    }
  }

  const decoyEventsByUser = new Map();
  const decoyClearEventsByUser = new Map();
  const behaviorEventsByUser = new Map();
  for (const event of eventsAll) {
    const userId = securityEventUserId(event);
    if (!userId) continue;
    const ts = securityEventTs(event);
    if (DECOY_EVENT_TYPES.includes(event.type)) {
      decoyEventsByUser.set(userId, Math.max(decoyEventsByUser.get(userId) || 0, ts));
    }
    if (DECOY_CLEAR_EVENT_TYPES.includes(event.type)) {
      decoyClearEventsByUser.set(userId, Math.max(decoyClearEventsByUser.get(userId) || 0, ts));
    }
    if (event.type === 'behavior_blocked') {
      const prev = behaviorEventsByUser.get(userId);
      if (!prev || ts > securityEventTs(prev)) behaviorEventsByUser.set(userId, event);
    }
  }

  const activeSessionsByUser = new Map();
  const revokedSessionsByUser = new Map();
  const revokedSessionSince = Date.now() - 24 * 3600 * 1000;
  for (const row of sessionsAll) {
    if (!row.user_id) continue;
    if (!row.revoked) {
      activeSessionsByUser.set(row.user_id, (activeSessionsByUser.get(row.user_id) || 0) + 1);
      continue;
    }
    const revokedTs = new Date(row.revoked_at || row.updated_at || row.created_at || 0).getTime() || 0;
    if (revokedTs < revokedSessionSince) continue;
    const info = revokedSessionsByUser.get(row.user_id) || { count: 0, latest: 0 };
    info.count += 1;
    info.latest = Math.max(info.latest, revokedTs);
    revokedSessionsByUser.set(row.user_id, info);
  }

  // Top users
  const byUser = new Map();
  for (const b of beh) {
    const k = b.user_id || 'anon';
    byUser.set(k, (byUser.get(k) || 0) + 1);
  }
  const topUsers = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([user_id, hits]) => ({
      user_id,
      username: accountMap.get(user_id)?.username || null,
      hits,
    }));

  const byIp = new Map();
  for (const b of beh) {
    const k = b.ip || 'unknown';
    byIp.set(k, (byIp.get(k) || 0) + 1);
  }
  const topIps = [...byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([ip, hits]) => ({ ip, hits }));

  const recentEvents = events.slice(-30).reverse().map((event) => {
      const details = securityEventDetails(event);
    const userId = event.user_id || details.user_id || null;
    const by = event.by || details.by || null;
    const ip = event.ip || details.ip || null;
    return {
      ...event,
      ...details,
      user_id: userId,
      by,
      ip,
      username: userId ? (accountMap.get(userId)?.username || null) : null,
      actor_username: by ? (accountMap.get(by)?.username || null) : null,
    };
  });

  res.json({
    ok: true,
    window: '24h',
    counts: {
      total_requests: beh.length,
      security_events: events.length,
      blocked_ips: ipBlocks.length,
      active_sessions: sessions.length,
      login_failed: events.filter(e => e.type === 'login_failed').length,
      login_ok: events.filter(e => e.type === 'login_ok').length,
      login_high_risk: events.filter(e => e.type === 'login_high_risk_blocked').length,
      auto_ban: events.filter(e => e.type === 'auto_ban_candidate' || e.type === 'auto_honeypot_user_ban').length,
      auto_honeypot_user_ban: events.filter(e => e.type === 'auto_honeypot_user_ban').length,
    },
    top_users: topUsers,
    top_ips: topIps,
    recent_events: recentEvents,
    blocked_ips: ipBlocks.map((block) => {
      const relatedUsers = [...(ipUserMap.get(block.ip)?.values() || [])]
        .sort((a, b) => b.last_seen_ts - a.last_seen_ts)
        .slice(0, 5);
      return {
        ...block,
        related_users: relatedUsers,
        related_usernames: relatedUsers.map((item) => item.username).filter(Boolean),
      };
    }),
    accounts: accountsAll.map((account) => ({
      ...adminAccountSummary(account),
      ...buildAdminAccountSecuritySummary(account, {
        activeIpBlocksByUser,
        decoyEventsByUser,
        decoyClearEventsByUser,
        behaviorEventsByUser,
        activeSessionsByUser,
        revokedSessionsByUser,
      }),
    })),
  });
}));

app.post('/api/admin/security/ban-user', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const userId = String(req.body?.user_id || '').trim();
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (userId === req.userId) return res.status(400).json({ ok: false, error: 'cannot_ban_self' });

  const found = await accounts.findById(userId);
  if (!found) return res.status(404).json({ ok: false, error: 'user_not_found' });

  const updated = await accounts.ban(userId, reason || '管理员手动封禁');
  await revokeAllSessionsForUser(userId);
  db.appendLog('security_event', {
    type: 'manual_user_ban',
    user_id: userId,
    by: req.userId,
    ip: req.clientIp,
    reason: updated?.revoked_reason || reason || null,
  }).catch(err => console.error('[admin] log error:', err.message));

  res.json({ ok: true, account: adminAccountSummary(updated) });
}));

app.post('/api/admin/security/unban-user', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const userId = String(req.body?.user_id || '').trim();
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const found = await accounts.findById(userId);
  if (!found) return res.status(404).json({ ok: false, error: 'user_not_found' });

  const updated = await accounts.unban(userId);
  db.appendLog('security_event', {
    type: 'manual_user_unban',
    user_id: userId,
    by: req.userId,
    ip: req.clientIp,
  }).catch(err => console.error('[admin] log error:', err.message));

  res.json({ ok: true, account: adminAccountSummary(updated) });
}));

app.post('/api/admin/security/clear-decoy-state', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const userId = String(req.body?.user_id || '').trim();
  const note = String(req.body?.note || '').trim();
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const found = await accounts.findById(userId);
  if (!found) return res.status(404).json({ ok: false, error: 'user_not_found' });

  const clearedAt = new Date().toISOString();
  await db.appendLog('security_event', {
    type: 'decoy_cleared',
    user_id: userId,
    username: found.username || null,
    by: req.userId,
    ip: req.clientIp,
    note: note || 'manual clear',
    cleared_at: clearedAt,
  });

  res.json({
    ok: true,
    user_id: userId,
    username: found.username || null,
    cleared_at: clearedAt,
  });
}));

app.post('/api/admin/security/reset-password', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const userId = String(req.body?.user_id || '').trim();
  const password = req.body?.password;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (typeof password !== 'string') return res.status(400).json({ ok: false, error: 'missing_password' });

  const found = await accounts.findById(userId);
  if (!found) return res.status(404).json({ ok: false, error: 'user_not_found' });

  let updated;
  try {
    updated = await accounts.resetPassword(userId, password);
  } catch (err) {
    if (err?.code === 'invalid_password') {
      return res.status(400).json({ ok: false, error: err.message || 'invalid_password' });
    }
    throw err;
  }
  const revokedSessions = await revokeAllSessionsForUser(userId);
  db.appendLog('security_event', {
    type: 'manual_password_reset',
    user_id: userId,
    username: found.username || null,
    by: req.userId,
    ip: req.clientIp,
    revoked_sessions: revokedSessions,
  }).catch(err => console.error('[admin] log error:', err.message));

  res.json({ ok: true, account: adminAccountSummary(updated), revoked_sessions: revokedSessions });
}));

app.post('/api/admin/security/upgrade-member', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const userId = String(req.body?.user_id || '').trim();
  const requestedYears = Number(req.body?.membership_years || DEFAULT_MEMBERSHIP_YEARS);
  const years = Number.isFinite(requestedYears) && requestedYears > 0
    ? Math.min(Math.floor(requestedYears), 100)
    : DEFAULT_MEMBERSHIP_YEARS;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const account = await accounts.findById(userId);
  if (!account) return res.status(404).json({ ok: false, error: 'user_not_found' });
  if (account.revoked) return res.status(409).json({ ok: false, error: 'account_revoked', message: '账号已封禁，请先解封后再升级会员' });

  const currentSourceCode = account.promoted_from_code ? await store.findById(account.promoted_from_code) : null;
  const currentMembership = resolveAccountMembership(account, currentSourceCode);
  if (currentMembership.is_member) {
    return res.status(409).json({
      ok: false,
      error: 'already_member',
      message: currentMembership.is_permanent ? '该账号已经是永久会员' : '该账号当前已经是会员',
      account: adminAccountSummary(account),
    });
  }

  const nowIso = new Date().toISOString();
  const invite = await store.add({
    label: `admin-upgrade:${account.username || account.id}`,
    note: `管理员后台升级会员，操作者 ${req.auth?.account?.username || req.userId}`,
    membership_years: years,
  });
  const membershipPatch = {
    membership_years: years,
    activated_at: nowIso,
    expires_at: addYears(nowIso, years),
  };
  const nextNote = (!account.note || account.note === 'self-registered account')
    ? 'upgraded by admin'
    : account.note;

  try {
    await transaction(async (conn) => {
      const consumed = await store.consumeForPromotion(invite.id, account.id, conn);
      if (!consumed) {
        const err = new Error('邀请码已被使用');
        err.code = 'code_already_used';
        throw err;
      }
      const updated = await accounts.applyInviteRedemption(account.id, {
        promoted_from_code: invite.id,
        membership_years: membershipPatch.membership_years,
        activated_at: membershipPatch.activated_at,
        expires_at: membershipPatch.expires_at,
        kind: 'promoted',
        note: nextNote,
      }, conn);
      if (!updated) {
        const err = new Error('account_not_found');
        err.code = 'account_not_found';
        throw err;
      }
    });
  } catch (err) {
    if (err?.code === 'code_already_used') {
      return res.status(409).json({ ok: false, error: 'code_already_used', message: '内部邀请码已被使用，请重试' });
    }
    if (err?.code === 'account_not_found') {
      return res.status(404).json({ ok: false, error: 'account_not_found' });
    }
    throw err;
  }

  const updatedAccount = await accounts.findById(account.id);
  db.appendLog('security_event', {
    type: 'admin_member_upgraded',
    user_id: account.id,
    username: account.username || null,
    by: req.userId,
    ip: req.clientIp,
    code_id: invite.id,
    membership_years: years,
    expires_at: membershipPatch.expires_at,
  }).catch(err => console.error('[admin] log error:', err.message));

  res.json({
    ok: true,
    account: adminAccountSummary(updatedAccount),
    code_id: invite.id,
    membership: membershipPayload(resolveAccountMembership(updatedAccount)),
  });
}));

app.post('/api/admin/messages', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const userId = String(req.body?.user_id || '').trim();
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  const kind = String(req.body?.kind || 'info').trim();
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!title || !body) return res.status(400).json({ ok: false, error: 'missing_title_or_body' });

  const found = await accounts.findById(userId);
  if (!found) return res.status(404).json({ ok: false, error: 'user_not_found' });

  const entry = await messages.create({
    user_id: userId,
    title,
    body,
    kind,
    created_by: req.userId,
  });
  db.appendLog('security_event', {
    type: 'admin_message_sent',
    message_id: entry.id,
    user_id: userId,
    username: found.username || null,
    by: req.userId,
    ip: req.clientIp,
  }).catch(err => console.error('[admin] log error:', err.message));

  res.json({ ok: true, message: entry });
}));

app.post('/api/admin/security/unblock-ip', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ ok: false, error: 'missing_ip' });
  const before = await db.list('ip_block');
  const targets = before.filter(b => b.ip === ip);
  for (const b of targets) await db.remove('ip_block', b.id);
  res.json({ ok: true, removed: targets.length });
}));

app.post('/api/admin/security/block-ip', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { ip, reason, ttl_seconds } = req.body || {};
  if (!ip) return res.status(400).json({ ok: false, error: 'missing_ip' });
  const ttl = Number(ttl_seconds || 86400);
  await db.insert('ip_block', {
    ip, reason: reason || 'manual', expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  });
  db.appendLog('security_event', { type: 'manual_block', ip, reason })
    .catch(err => console.error('[admin] log error:', err.message));
  res.json({ ok: true });
}));

// ---------- Admin: announcements ----------
// List every announcement (including inactive/expired) for the admin console.
app.get('/api/admin/announcements', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  res.json({ ok: true, announcements: await announcements.listAll() });
}));

// Create a new announcement. Body fields: kind, title, body, expires_at, pinned.
app.post('/api/admin/announcements', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { kind, title, body, expires_at, pinned } = req.body || {};
  if (!title || !body) return res.status(400).json({ ok: false, error: 'missing_title_or_body' });
  const entry = await announcements.create({
    kind: kind || 'info',
    title,
    body,
    expires_at: expires_at || null,
    pinned: !!pinned,
    created_by: req.userId,
  });
  db.appendLog('security_event', { type: 'announcement_created', id: entry.id, kind: entry.kind, by: req.userId })
    .catch(err => console.error('[admin] log error:', err.message));
  res.json({ ok: true, announcement: entry });
}));

// Patch an existing announcement (toggle active, edit content, etc).
app.post('/api/admin/announcements/:id/update', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const entry = await announcements.update(req.params.id, req.body || {});
  if (!entry) return res.status(404).json({ ok: false, error: 'not_found' });
  db.appendLog('security_event', { type: 'announcement_updated', id: entry.id, by: req.userId })
    .catch(err => console.error('[admin] log error:', err.message));
  res.json({ ok: true, announcement: entry });
}));

// Hard-delete an announcement.
app.post('/api/admin/announcements/:id/delete', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const ok = await announcements.remove(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  db.appendLog('security_event', { type: 'announcement_deleted', id: req.params.id, by: req.userId })
    .catch(err => console.error('[admin] log error:', err.message));
  res.json({ ok: true });
}));

// ---------- Admin: batch invite-code generation ----------
// POST { count: <1..200>, label?: string, note?: string, years?: number }
// Returns { ok, codes: [{ id, plaintext, label, note, membership_years }, ...] }.
// Cap at 200 to keep the response size sane and the bcrypt batch short.
app.post('/api/admin/invites/batch', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const count = Math.max(1, Math.min(200, Number(req.body?.count || 0)));
  const label = String(req.body?.label || '').slice(0, 100);
  const note = String(req.body?.note || '').slice(0, 500);
  const years = Number(req.body?.years || 10);
  if (!Number.isFinite(count) || count < 1) return res.status(400).json({ ok: false, error: 'invalid_count' });
  const out = [];
  for (let i = 0; i < count; i++) {
    const { plaintext, ...entry } = await store.add({
      label,
      note: note + (count > 1 ? ` [batch ${i + 1}/${count}]` : ''),
      membership_years: years,
    });
    out.push({ id: entry.id, plaintext, label: entry.label, note: entry.note, membership_years: entry.membership_years });
  }
  db.appendLog('security_event', { type: 'invites_batch_generated', count, by: req.userId })
    .catch(err => console.error('[admin] log error:', err.message));
  res.json({ ok: true, codes: out });
}));

app.post('/api/admin/invites/revoke', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const inviteId = String(req.body?.invite_id || '').trim();
  const rawCode = String(req.body?.code || '').trim();
  const normalizedCode = rawCode.replace(/[\s-]/g, '').toUpperCase();

  if (!inviteId && !normalizedCode) {
    return res.status(400).json({ ok: false, error: 'missing_invite_identifier', message: '请提供邀请码 ID 或邀请码明文' });
  }

  let entry = null;
  if (inviteId) {
    entry = await store.findById(inviteId);
  } else if ([32, 50].includes(normalizedCode.length)) {
    entry = await store.findByPlaintext(normalizedCode);
  } else {
    return res.status(400).json({ ok: false, error: 'invalid_code_format', message: '邀请码格式不正确' });
  }

  if (!entry) {
    return res.status(404).json({ ok: false, error: 'invite_not_found', message: '没有找到这个邀请码，可能已被使用或已销毁' });
  }

  if (entry.revoked) {
    return res.json({ ok: true, already_revoked: true, invite: { id: entry.id, label: entry.label, note: entry.note } });
  }

  await store.revoke(entry.id);
  db.appendLog('security_event', {
    type: 'invite_revoked',
    invite_id: entry.id,
    label: entry.label || null,
    note: entry.note || null,
    by: req.userId,
    ip: req.clientIp,
  }).catch(err => console.error('[admin] log error:', err.message));

  res.json({
    ok: true,
    invite: {
      id: entry.id,
      label: entry.label,
      note: entry.note,
    },
  });
}));

// ============================================================
// CONTENT MANAGEMENT — Admin APIs
// All require requireAuth + requireAdmin
// ============================================================

// ---- Helper: write security event ----
async function adminLogEvent(type, req, extra = {}) {
  return db.appendLog('security_event', {
    type,
    admin_user_id: req.userId,
    ip: req.clientIp,
    ...extra,
  }).catch(err => console.error('[admin] log error:', err.message));
}

// ---- Helper: assert operation succeeded ----
function assertOp(rows, id) {
  if (!rows || rows.affectedRows === 0) {
    const e = new Error('not_found');
    e.status = 404;
    throw e;
  }
  return rows;
}

// ---- Link Health Admin ----

// GET /api/admin/content/link-health
app.get('/api/admin/content/link-health', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const data = await listLinkHealth({
    status: req.query.status || 'all',
    contentType: req.query.content_type || 'all',
    q: req.query.q || '',
    page: req.query.page || 1,
    limit: req.query.limit || 50,
    sort: req.query.sort || 'checked_desc',
  });
  res.json({ ok: true, ...data });
}));

// POST /api/admin/content/link-health/scan
app.post('/api/admin/content/link-health/scan', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    scope = 'all',
    q = '',
    limit = 100,
    timeout_ms = 7000,
    concurrency = 6,
  } = req.body || {};

  const data = await scanLinkHealth({
    scope,
    q,
    limit: Math.min(500, Math.max(1, Number(limit) || 100)),
    timeoutMs: Math.min(20000, Math.max(1000, Number(timeout_ms) || 7000)),
    concurrency: Math.min(12, Math.max(1, Number(concurrency) || 6)),
  });
  await adminLogEvent('link_health_scan', req, { scope, q, limit: Number(limit) || 100, ...data });
  res.json({ ok: true, ...data });
}));

// ---- Prompt Cards Admin ----

// GET /api/admin/content/cards
app.get('/api/admin/content/cards', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    q = '',
    category = '',
    source = '',
    active = 'all',
    free = 'all',
    blindbox = 'all',
    page = '1',
    limit = '30',
    sort = 'created_desc',
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  const params = [];

  if (q) {
    conditions.push('(title LIKE ? OR summary LIKE ? OR description LIKE ?)');
    const likeQ = `%${q}%`;
    params.push(likeQ, likeQ, likeQ);
  }
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (source) {
    conditions.push('source = ?');
    params.push(source);
  }
  if (active !== 'all') {
    conditions.push('active = ?');
    params.push(active === '1' ? 1 : 0);
  }
  if (free !== 'all') {
    conditions.push('is_free = ?');
    params.push(free === '1' ? 1 : 0);
  }
  if (blindbox !== 'all') {
    conditions.push('is_blindbox = ?');
    params.push(blindbox === '1' ? 1 : 0);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  let orderBy = 'created_at DESC';
  switch (sort) {
    case 'created_asc':  orderBy = 'created_at ASC'; break;
    case 'updated_desc': orderBy = 'updated_at DESC'; break;
    case 'updated_asc':  orderBy = 'updated_at ASC'; break;
    case 'sort_order':   orderBy = 'sort_order ASC, created_at ASC'; break;
    case 'title':        orderBy = 'title ASC'; break;
    default:             orderBy = 'created_at DESC';
  }

  const countRows = await mysqlQuery(
    `SELECT COUNT(*) AS total FROM prompt_cards ${where}`,
    params
  );
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await mysqlQuery(
    `SELECT id, title, category, page_type, summary, is_free, is_blindbox, member_only,
            active, sort_order, heat, source, preview_image_url, created_at, updated_at
       FROM prompt_cards ${where}
       ORDER BY ${orderBy}
       LIMIT ${limitNum} OFFSET ${offset}`,
    params
  );

  res.json({ ok: true, total, page: pageNum, limit: limitNum, items: rows });
}));

// GET /api/admin/content/cards/:id
app.get('/api/admin/content/cards/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cards = await mysqlQuery(
    `SELECT * FROM prompt_cards WHERE id = ?`,
    [id]
  );
  if (!cards.length) return res.status(404).json({ ok: false, error: 'not_found' });

  const card = cards[0];
  const bodies = await mysqlQuery(
    `SELECT prompt_text, prompt_text_length, prompt_hash FROM prompt_card_bodies WHERE card_id = ?`,
    [id]
  );

  res.json({
    ok: true,
    item: {
      ...card,
      prompt_text: bodies[0]?.prompt_text || '',
      prompt_text_length: bodies[0]?.prompt_text_length || 0,
      prompt_hash: bodies[0]?.prompt_hash || null,
    },
  });
}));

// POST /api/admin/content/cards
app.post('/api/admin/content/cards', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    id,
    title,
    category = null,
    original_category = null,
    page_type = null,
    summary = null,
    description = null,
    tags = [],
    preview_image_url = null,
    preview_thumb_url = null,
    image_preview_url = null,
    source_url = null,
    demo_url = null,
    sort_order = 0,
    source = 'manual',
    is_free = 0,
    is_blindbox = 0,
    member_only = 1,
    active = 1,
    prompt_text = '',
  } = req.body || {};

  if (!id || !title) {
    return res.status(400).json({ ok: false, error: 'missing_required_fields' });
  }

  const now = toMysqlDt(Date.now());

  await mysqlQuery(
    `INSERT INTO prompt_cards
       (id, title, category, original_category, page_type, summary, description, tags,
        preview_image_url, preview_thumb_url, image_preview_url, source_url, demo_url,
        sort_order, source, is_free, is_blindbox, member_only, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       title=VALUES(title), category=VALUES(category), original_category=VALUES(original_category),
       page_type=VALUES(page_type), summary=VALUES(summary), description=VALUES(description),
       tags=VALUES(tags), preview_image_url=VALUES(preview_image_url),
       preview_thumb_url=VALUES(preview_thumb_url), image_preview_url=VALUES(image_preview_url),
       source_url=VALUES(source_url), demo_url=VALUES(demo_url),
       sort_order=VALUES(sort_order), source=VALUES(source),
       is_free=VALUES(is_free), is_blindbox=VALUES(is_blindbox),
       member_only=VALUES(member_only), active=VALUES(active), updated_at=VALUES(updated_at)`,
    [
      id, title, category, original_category, page_type, summary, description,
      JSON.stringify(tags || []),
      preview_image_url, preview_thumb_url, image_preview_url, source_url, demo_url,
      Number(sort_order), source,
      is_free ? 1 : 0, is_blindbox ? 1 : 0, member_only ? 1 : 0, active ? 1 : 0,
      now, now,
    ]
  );

  await mysqlQuery(
    `INSERT INTO prompt_card_bodies (card_id, prompt_text, prompt_text_length, prompt_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       prompt_text=VALUES(prompt_text), prompt_text_length=VALUES(prompt_text_length),
       prompt_hash=VALUES(prompt_hash), updated_at=VALUES(updated_at)`,
    [id, String(prompt_text || ''), prompt_text.length, null, now, now]
  );

  await adminLogEvent('card_created', req, { card_id: id, title });
  refreshMySQLPromptsCache().catch(() => {});
  res.json({ ok: true, id });
}));

// PUT /api/admin/content/cards/:id
app.put('/api/admin/content/cards/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    title,
    category = null,
    original_category = null,
    page_type = null,
    summary = null,
    description = null,
    tags = [],
    preview_image_url = null,
    preview_thumb_url = null,
    image_preview_url = null,
    source_url = null,
    demo_url = null,
    sort_order = 0,
    source = null,
    is_free,
    is_blindbox,
    member_only,
    active,
    prompt_text = null,
  } = req.body || {};

  if (!title) return res.status(400).json({ ok: false, error: 'missing_required_fields' });

  const existing = await mysqlQuery(`SELECT id FROM prompt_cards WHERE id = ?`, [id]);
  if (!existing.length) return res.status(404).json({ ok: false, error: 'not_found' });

  const now = toMysqlDt(Date.now());
  const updates = [];
  const params = [];

  const addField = (col, val) => {
    updates.push(`${col}=?`);
    params.push(val);
  };

  addField('title', title);
  if (category !== undefined) addField('category', category);
  if (original_category !== undefined) addField('original_category', original_category);
  if (page_type !== undefined) addField('page_type', page_type);
  if (summary !== undefined) addField('summary', summary);
  if (description !== undefined) addField('description', description);
  if (tags !== undefined) addField('tags', JSON.stringify(tags || []));
  if (preview_image_url !== undefined) addField('preview_image_url', preview_image_url);
  if (preview_thumb_url !== undefined) addField('preview_thumb_url', preview_thumb_url);
  if (image_preview_url !== undefined) addField('image_preview_url', image_preview_url);
  if (source_url !== undefined) addField('source_url', source_url);
  if (demo_url !== undefined) addField('demo_url', demo_url);
  if (sort_order !== undefined) addField('sort_order', Number(sort_order));
  if (source !== undefined) addField('source', source);
  if (is_free !== undefined) addField('is_free', is_free ? 1 : 0);
  if (is_blindbox !== undefined) addField('is_blindbox', is_blindbox ? 1 : 0);
  if (member_only !== undefined) addField('member_only', member_only ? 1 : 0);
  if (active !== undefined) addField('active', active ? 1 : 0);
  addField('updated_at', now);

  params.push(id);
  await mysqlQuery(`UPDATE prompt_cards SET ${updates.join(', ')} WHERE id = ?`, params);

  if (prompt_text !== null) {
    await mysqlQuery(
      `INSERT INTO prompt_card_bodies (card_id, prompt_text, prompt_text_length, prompt_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         prompt_text=VALUES(prompt_text), prompt_text_length=VALUES(prompt_text_length),
         prompt_hash=VALUES(prompt_hash), updated_at=VALUES(updated_at)`,
      [id, String(prompt_text), prompt_text.length, null, now, now]
    );
  }

  await adminLogEvent('card_updated', req, { card_id: id, title });
  refreshMySQLPromptsCache().catch(() => {});
  res.json({ ok: true });
}));

// PATCH /api/admin/content/cards/:id/status
app.patch('/api/admin/content/cards/:id/status', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { active, reason = '' } = req.body || {};
  if (active === undefined) return res.status(400).json({ ok: false, error: 'missing_active_field' });

  const now = toMysqlDt(Date.now());
  const rows = await mysqlQuery(
    `UPDATE prompt_cards SET active = ?, updated_at = ? WHERE id = ?`,
    [active ? 1 : 0, now, id]
  );

  if (!rows.affectedRows) return res.status(404).json({ ok: false, error: 'not_found' });

  await adminLogEvent('card_status_changed', req, { card_id: id, active: active ? 1 : 0, reason });
  refreshMySQLPromptsCache().catch(() => {});
  res.json({ ok: true });
}));

// DELETE /api/admin/content/cards/:id  (soft delete)
app.delete('/api/admin/content/cards/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const now = toMysqlDt(Date.now());
  const rows = await mysqlQuery(
    `UPDATE prompt_cards SET active = 0, updated_at = ? WHERE id = ? AND active = 1`,
    [now, id]
  );

  if (!rows.affectedRows) return res.status(404).json({ ok: false, error: 'not_found_or_inactive' });

  await adminLogEvent('card_deleted', req, { card_id: id });
  refreshMySQLPromptsCache().catch(() => {});
  res.json({ ok: true });
}));

// POST /api/admin/content/cards/import-json
app.post('/api/admin/content/cards/import-json', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { items = [] } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, error: 'invalid_payload' });
  }

  const now = toMysqlDt(Date.now());
  let inserted = 0, updated = 0;
  const errors = [];

  for (const raw of items) {
    try {
      if (!raw.id || !raw.title) {
        errors.push({ id: raw.id || 'unknown', error: 'missing id or title' });
        continue;
      }
      const cardId = String(raw.id).trim();
      const result = await mysqlQuery(
        `INSERT INTO prompt_cards
           (id, title, category, original_category, page_type, summary, description, tags,
            preview_image_url, preview_thumb_url, image_preview_url, source_url, demo_url,
            sort_order, source, is_free, is_blindbox, member_only, active, heat, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title=VALUES(title), category=VALUES(category), original_category=VALUES(original_category),
           page_type=VALUES(page_type), summary=VALUES(summary), description=VALUES(description),
           tags=VALUES(tags), preview_image_url=VALUES(preview_image_url),
           preview_thumb_url=VALUES(preview_thumb_url), image_preview_url=VALUES(image_preview_url),
           source_url=VALUES(source_url), demo_url=VALUES(demo_url),
           sort_order=VALUES(sort_order), source=VALUES(source),
           is_free=VALUES(is_free), is_blindbox=VALUES(is_blindbox),
           member_only=VALUES(member_only), active=VALUES(active), heat=VALUES(heat),
           updated_at=VALUES(updated_at)`,
        [
          cardId, String(raw.title).trim(),
          raw.category || null, raw.original_category || null, raw.page_type || null,
          raw.summary || null, raw.description || null,
          JSON.stringify(raw.tags || []),
          raw.preview_image_url || null, raw.preview_thumb_url || null, raw.image_preview_url || null,
          raw.source_url || null, raw.demo_url || null,
          Number(raw.sort_order || 0), String(raw.source || 'import'),
          raw.is_free ? 1 : 0, raw.is_blindbox ? 1 : 0,
          raw.member_only !== false ? 1 : 0, raw.active !== false ? 1 : 0,
          Number(raw.heat || 0), now, now,
        ]
      );

      const affected = result.affectedRows || 0;
      if (affected <= 2) updated++;
      else inserted++;

      if (raw.prompt_text) {
        await mysqlQuery(
          `INSERT INTO prompt_card_bodies (card_id, prompt_text, prompt_text_length, prompt_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             prompt_text=VALUES(prompt_text), prompt_text_length=VALUES(prompt_text_length),
             prompt_hash=VALUES(prompt_hash), updated_at=VALUES(updated_at)`,
          [cardId, String(raw.prompt_text), String(raw.prompt_text).length, null, now, now]
        );
      }
    } catch (err) {
      errors.push({ id: raw.id || 'unknown', error: err.message });
    }
  }

  await adminLogEvent('cards_imported', req, { count: items.length, inserted, updated });
  await adminLogEvent('cards_imported', req, { count: items.length, inserted, updated });
  refreshMySQLPromptsCache().catch(() => {});
  res.json({ ok: true, total: items.length, inserted, updated, errors: errors.length ? errors : undefined });
}));

// ---- Idea Prompts Admin ----

// GET /api/admin/content/ideas
app.get('/api/admin/content/ideas', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    q = '',
    kind = '',
    active = 'all',
    page = '1',
    limit = '30',
    sort = 'created_desc',
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  const params = [];

  if (q) {
    conditions.push('(title LIKE ? OR summary LIKE ?)');
    const likeQ = `%${q}%`;
    params.push(likeQ, likeQ);
  }
  if (kind) {
    conditions.push('kind = ?');
    params.push(kind);
  }
  if (active !== 'all') {
    conditions.push('active = ?');
    params.push(active === '1' ? 1 : 0);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  let orderBy = 'created_at DESC';
  switch (sort) {
    case 'created_asc':  orderBy = 'created_at ASC'; break;
    case 'updated_desc': orderBy = 'updated_at DESC'; break;
    case 'sort_order':   orderBy = 'sort_order ASC'; break;
    case 'title':        orderBy = 'title ASC'; break;
    default:             orderBy = 'created_at DESC';
  }

  const countRows = await mysqlQuery(
    `SELECT COUNT(*) AS total FROM idea_prompts ${where}`,
    params
  );
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await mysqlQuery(
    `SELECT id, kind, title, category, page_type, sort_order, source, heat,
            1 AS is_member_only, active, prompt_text_length,
            preview_image_url, preview_video_url, created_at, updated_at
       FROM idea_prompts ${where}
       ORDER BY ${orderBy}
       LIMIT ${limitNum} OFFSET ${offset}`,
    params
  );

  res.json({ ok: true, total, page: pageNum, limit: limitNum, items: rows });
}));

// GET /api/admin/content/ideas/:id
app.get('/api/admin/content/ideas/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const rows = await mysqlQuery(`SELECT * FROM idea_prompts WHERE id = ?`, [id]);
  if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, item: rows[0] });
}));

// POST /api/admin/content/ideas
app.post('/api/admin/content/ideas', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    id, kind, title, category = null, type = null, page_type = null,
    sort_order = 0, source = 'manual', prompt_text = '', tags = [],
    summary = null, preview_image_url = null, preview_video_url = null,
    active = 1,
  } = req.body || {};

  if (!id || !kind || !title) {
    return res.status(400).json({ ok: false, error: 'missing_required_fields' });
  }

  const now = toMysqlDt(Date.now());
  await mysqlQuery(
    `INSERT INTO idea_prompts
       (id, kind, title, category, type, page_type, sort_order, source, prompt_text,
        prompt_text_length, tags, summary, preview_image_url, preview_video_url,
        active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       kind=VALUES(kind), title=VALUES(title), category=VALUES(category), type=VALUES(type),
       page_type=VALUES(page_type), sort_order=VALUES(sort_order), source=VALUES(source),
       prompt_text=VALUES(prompt_text), prompt_text_length=VALUES(prompt_text_length),
       tags=VALUES(tags), summary=VALUES(summary), preview_image_url=VALUES(preview_image_url),
       preview_video_url=VALUES(preview_video_url), active=VALUES(active), updated_at=VALUES(updated_at)`,
    [
      id, kind, String(title), category, type, page_type,
      Number(sort_order), source, String(prompt_text),
      prompt_text.length, JSON.stringify(tags || []),
      summary, preview_image_url, preview_video_url,
      active ? 1 : 0, now, now,
    ]
  );

  await adminLogEvent('idea_created', req, { idea_id: id, kind, title });
  refreshIdeaLibrariesCache().catch(() => {});
  res.json({ ok: true, id });
}));

// PUT /api/admin/content/ideas/:id
app.put('/api/admin/content/ideas/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    title, category, type, page_type, sort_order, source,
    prompt_text, tags, summary, preview_image_url, preview_video_url, active,
  } = req.body || {};

  if (!title) return res.status(400).json({ ok: false, error: 'missing_required_fields' });

  const existing = await mysqlQuery(`SELECT id FROM idea_prompts WHERE id = ?`, [id]);
  if (!existing.length) return res.status(404).json({ ok: false, error: 'not_found' });

  const now = toMysqlDt(Date.now());
  const updates = [];
  const params = [];

  const addField = (col, val) => { updates.push(`${col}=?`); params.push(val); };
  addField('title', title);
  if (category !== undefined) addField('category', category);
  if (type !== undefined) addField('type', type);
  if (page_type !== undefined) addField('page_type', page_type);
  if (sort_order !== undefined) addField('sort_order', Number(sort_order));
  if (source !== undefined) addField('source', source);
  if (prompt_text !== undefined) {
    addField('prompt_text', String(prompt_text));
    addField('prompt_text_length', prompt_text.length);
  }
  if (tags !== undefined) addField('tags', JSON.stringify(tags || []));
  if (summary !== undefined) addField('summary', summary);
  if (preview_image_url !== undefined) addField('preview_image_url', preview_image_url);
  if (preview_video_url !== undefined) addField('preview_video_url', preview_video_url);
  if (active !== undefined) addField('active', active ? 1 : 0);
  addField('updated_at', now);

  params.push(id);
  await mysqlQuery(`UPDATE idea_prompts SET ${updates.join(', ')} WHERE id = ?`, params);

  await adminLogEvent('idea_updated', req, { idea_id: id, title });
  refreshIdeaLibrariesCache().catch(() => {});
  res.json({ ok: true });
}));

// PATCH /api/admin/content/ideas/:id/status
app.patch('/api/admin/content/ideas/:id/status', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { active, reason = '' } = req.body || {};
  if (active === undefined) return res.status(400).json({ ok: false, error: 'missing_active_field' });

  const now = toMysqlDt(Date.now());
  const rows = await mysqlQuery(
    `UPDATE idea_prompts SET active = ?, updated_at = ? WHERE id = ?`,
    [active ? 1 : 0, now, id]
  );

  if (!rows.affectedRows) return res.status(404).json({ ok: false, error: 'not_found' });

  await adminLogEvent('idea_status_changed', req, { idea_id: id, active: active ? 1 : 0, reason });
  refreshIdeaLibrariesCache().catch(() => {});
  res.json({ ok: true });
}));

// DELETE /api/admin/content/ideas/:id
app.delete('/api/admin/content/ideas/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const now = toMysqlDt(Date.now());
  const rows = await mysqlQuery(
    `UPDATE idea_prompts SET active = 0, updated_at = ? WHERE id = ? AND active = 1`,
    [now, id]
  );

  if (!rows.affectedRows) return res.status(404).json({ ok: false, error: 'not_found_or_inactive' });

  await adminLogEvent('idea_deleted', req, { idea_id: id });
  refreshIdeaLibrariesCache().catch(() => {});
  res.json({ ok: true });
}));

// ---- Tutorials Admin ----

// GET /api/admin/content/tutorials
app.get('/api/admin/content/tutorials', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const rows = await mysqlQuery(
    `SELECT id, title, description, button_label, video_url, external_url, cover_url,
            platform, sort_order, enabled, open_mode, created_at, updated_at
       FROM tutorials
       ORDER BY sort_order ASC, created_at ASC`
  );
  res.json({ ok: true, items: rows });
}));

// GET /api/admin/content/tutorials/:id
app.get('/api/admin/content/tutorials/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const rows = await mysqlQuery(`SELECT * FROM tutorials WHERE id = ?`, [id]);
  if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, item: rows[0] });
}));

// POST /api/admin/content/tutorials
app.post('/api/admin/content/tutorials', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    id, title, description = null, button_label = null,
    video_url = null, external_url = null, cover_url = null,
    platform = null, sort_order = 0, enabled = 1, open_mode = 'external',
  } = req.body || {};

  if (!id || !title) return res.status(400).json({ ok: false, error: 'missing_required_fields' });

  const now = toMysqlDt(Date.now());
  await mysqlQuery(
    `INSERT INTO tutorials
       (id, title, description, button_label, video_url, external_url, cover_url,
        platform, sort_order, enabled, open_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       title=VALUES(title), description=VALUES(description), button_label=VALUES(button_label),
       video_url=VALUES(video_url), external_url=VALUES(external_url), cover_url=VALUES(cover_url),
       platform=VALUES(platform), sort_order=VALUES(sort_order),
       enabled=VALUES(enabled), open_mode=VALUES(open_mode), updated_at=VALUES(updated_at)`,
    [id, title, description, button_label, video_url, external_url, cover_url,
     platform, Number(sort_order), enabled ? 1 : 0, open_mode, now, now]
  );

  await adminLogEvent('tutorial_created', req, { tutorial_id: id, title });
  res.json({ ok: true, id });
}));

// PUT /api/admin/content/tutorials/:id
app.put('/api/admin/content/tutorials/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    title, description, button_label, video_url, external_url, cover_url,
    platform, sort_order, enabled, open_mode,
  } = req.body || {};

  if (!title) return res.status(400).json({ ok: false, error: 'missing_required_fields' });

  const existing = await mysqlQuery(`SELECT id FROM tutorials WHERE id = ?`, [id]);
  if (!existing.length) return res.status(404).json({ ok: false, error: 'not_found' });

  const now = toMysqlDt(Date.now());
  const updates = [];
  const params = [];

  const addField = (col, val) => { updates.push(`${col}=?`); params.push(val); };
  addField('title', title);
  if (description !== undefined) addField('description', description);
  if (button_label !== undefined) addField('button_label', button_label);
  if (video_url !== undefined) addField('video_url', video_url);
  if (external_url !== undefined) addField('external_url', external_url);
  if (cover_url !== undefined) addField('cover_url', cover_url);
  if (platform !== undefined) addField('platform', platform);
  if (sort_order !== undefined) addField('sort_order', Number(sort_order));
  if (enabled !== undefined) addField('enabled', enabled ? 1 : 0);
  if (open_mode !== undefined) addField('open_mode', open_mode);
  addField('updated_at', now);

  params.push(id);
  await mysqlQuery(`UPDATE tutorials SET ${updates.join(', ')} WHERE id = ?`, params);

  await adminLogEvent('tutorial_updated', req, { tutorial_id: id, title });
  res.json({ ok: true });
}));

// PATCH /api/admin/content/tutorials/:id/status
app.patch('/api/admin/content/tutorials/:id/status', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { enabled, reason = '' } = req.body || {};
  if (enabled === undefined) return res.status(400).json({ ok: false, error: 'missing_enabled_field' });

  const now = toMysqlDt(Date.now());
  const rows = await mysqlQuery(
    `UPDATE tutorials SET enabled = ?, updated_at = ? WHERE id = ?`,
    [enabled ? 1 : 0, now, id]
  );

  if (!rows.affectedRows) return res.status(404).json({ ok: false, error: 'not_found' });

  await adminLogEvent('tutorial_status_changed', req, { tutorial_id: id, enabled: enabled ? 1 : 0, reason });
  res.json({ ok: true });
}));

// DELETE /api/admin/content/tutorials/:id
app.delete('/api/admin/content/tutorials/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const rows = await mysqlQuery(`DELETE FROM tutorials WHERE id = ?`, [id]);

  if (!rows.affectedRows) return res.status(404).json({ ok: false, error: 'not_found' });

  await adminLogEvent('tutorial_deleted', req, { tutorial_id: id });
  res.json({ ok: true });
}));

// ---- Public Tutorials API ----

// GET /api/tutorials — for login page / front-end
app.get('/api/tutorials', asyncHandler(async (req, res) => {
  const rows = await mysqlQuery(
    `SELECT id, title, description, button_label, video_url, external_url, cover_url,
            platform, open_mode, sort_order
       FROM tutorials
       WHERE enabled = 1
       ORDER BY sort_order ASC, created_at ASC`
  );
  res.json({ ok: true, items: rows });
}));

// ---- Public Skills API ----

// AI 编程超能力 · 20 个 skills
const AI_SKILLS = [
  // 🧠 翻译的 Skills（14 个）
  {
    id: 'brainstorming',
    name: '头脑风暴',
    tagline: '需求不清晰时，先想清楚再做',
    description: '通过系统化的提问和分析，将模糊的想法转化为明确的设计规格，避免一开始就埋头写代码。',
    category: '需求分析',
    isChina: false,
  },
  {
    id: 'writing-plans',
    name: '编写计划',
    tagline: '把大目标拆成可执行的小步骤',
    description: '将设计规格拆解为具体可执行的实施步骤，每一步都有明确的交付物和验收标准。',
    category: '需求分析',
    isChina: false,
  },
  {
    id: 'executing-plans',
    name: '执行计划',
    tagline: '按计划一步步来，每步都验证',
    description: '严格按照计划逐步实施，每完成一步就验证结果，确保方向正确再继续。',
    category: '实施',
    isChina: false,
  },
  {
    id: 'test-driven-development',
    name: '测试驱动开发',
    tagline: '先写测试，再写代码，严格 TDD',
    description: '遵循严格的 TDD 流程：先写失败的测试，再写代码让它通过，保证代码质量。',
    category: '实施',
    isChina: false,
  },
  {
    id: 'systematic-debugging',
    name: '系统化调试',
    tagline: '遇到 Bug 不慌，按四阶段法来定位',
    description: '四阶段调试法：定位问题 → 分析原因 → 形成假设 → 修复验证，告别盲目试错。',
    category: '调试',
    isChina: false,
  },
  {
    id: 'requesting-code-review',
    name: '请求代码审查',
    tagline: '让 AI agent 帮你审查代码质量',
    description: '派遣专门的审查 agent 检查代码质量、逻辑漏洞、安全隐患，从他人视角发现问题。',
    category: '审查',
    isChina: false,
  },
  {
    id: 'receiving-code-review',
    name: '接收代码审查',
    tagline: '严谨处理审查反馈，不敷衍',
    description: '技术严谨地处理审查反馈：接受合理的改进建议，有理有据地拒绝不合适的意见。',
    category: '审查',
    isChina: false,
  },
  {
    id: 'verification-before-completion',
    name: '完成前验证',
    tagline: '声称完成前必须跑验证，有证据再说',
    description: '证据先行原则：每项"完成"的工作都必须有测试、日志、截图等客观证据支撑。',
    category: '质量',
    isChina: false,
  },
  {
    id: 'dispatching-parallel-agents',
    name: '派遣并行 Agent',
    tagline: '多任务并发执行，效率翻倍',
    description: '同时调度多个 AI agent 并行处理独立任务，充分利用计算资源加速开发。',
    category: '协作',
    isChina: false,
  },
  {
    id: 'subagent-driven-development',
    name: '子 Agent 驱动开发',
    tagline: '每个任务一个 agent，两轮审查',
    description: '为每个子任务创建专门的 agent，处理完再由主 agent 汇总，两轮审查确保质量。',
    category: '协作',
    isChina: false,
  },
  {
    id: 'using-git-worktrees',
    name: 'Git Worktree 使用',
    tagline: '隔离式特性开发，多分支并行',
    description: '利用 Git worktree 创建隔离的开发环境，同时在多个分支上工作而不互相干扰。',
    category: 'Git',
    isChina: false,
  },
  {
    id: 'finishing-a-development-branch',
    name: '完成开发分支',
    tagline: '合并/PR/保留/丢弃，四选一',
    description: '特性开发完成后的决策流程：合并到主分支、创建 PR、保留待用还是丢弃，四选一明确处理。',
    category: 'Git',
    isChina: false,
  },
  {
    id: 'writing-skills',
    name: '编写 Skills',
    tagline: '创建新的 skill，扩展 AI 能力',
    description: '创建新的 skill 来教 AI 学会特定的工作方法论，持续扩展 AI 的能力边界。',
    category: '进阶',
    isChina: false,
  },
  {
    id: 'using-superpowers',
    name: '使用 Superpowers',
    tagline: '元技能：如何调用和优先使用 skills',
    description: '了解 superpowers 框架的工作机制，学会在合适的时机调用合适的 skill。',
    category: '进阶',
    isChina: false,
  },
  // 🇨🇳 中国特色 Skills（6 个）
  {
    id: 'chinese-code-review',
    name: '中文代码审查',
    tagline: '符合国内团队文化的代码审查规范',
    description: '适配国内团队沟通文化的代码审查规范，强调建设性反馈和尊重团队共识。',
    category: '中国特色',
    isChina: true,
  },
  {
    id: 'chinese-git-workflow',
    name: '中文 Git 工作流',
    tagline: '适配 Gitee/Coding/极狐 GitLab/CNB',
    description: '面向国内 Git 平台的开发工作流，支持 Gitee、Coding、极狐 GitLab、腾讯云原生构建。',
    category: '中国特色',
    isChina: true,
  },
  {
    id: 'chinese-documentation',
    name: '中文技术文档',
    tagline: '中文排版规范，告别机翻味',
    description: '中文排版规范、中英混排规则，让技术文档读起来专业地道，不会有机翻的感觉。',
    category: '中国特色',
    isChina: true,
  },
  {
    id: 'chinese-commit-conventions',
    name: '中文提交规范',
    tagline: '适配国内团队的 commit message 规范',
    description: '基于 Conventional Commits 的中文适配版，适合国内团队使用的 commit message 规范。',
    category: '中国特色',
    isChina: true,
  },
  {
    id: 'mcp-builder',
    name: 'MCP 服务器构建',
    tagline: '构建生产级 MCP 工具，扩展 AI 能力边界',
    description: '使用 MCP（Model Context Protocol）构建生产级的工具服务器，扩展 AI 的能力边界。',
    category: '进阶',
    isChina: true,
  },
  {
    id: 'workflow-runner',
    name: '工作流执行器',
    tagline: '在 AI 工具内运行多角色 YAML 工作流',
    description: '通过 YAML 配置多角色工作流，在 AI 编程工具内实现复杂的自动化任务编排。',
    category: '进阶',
    isChina: true,
  },
];

app.get('/api/skills', (req, res) => {
  res.json({ ok: true, items: AI_SKILLS });
});

// 获取单个 SKILL 的完整内容（原版 SKILL.md 文件）
app.get('/api/skill/:id/content', async (req, res) => {
  const { id } = req.params;
  const skillsPath = path.join(__dirname, '..', 'MVP-dev-zhisheng', '.skills-all', id, 'SKILL.md');
  try {
    const content = await fs.promises.readFile(skillsPath, 'utf8');
    res.json({ ok: true, id, content });
  } catch (e) {
    // 如果找不到原版文件，返回占位内容
    const skill = AI_SKILLS.find(s => s.id === id);
    if (skill) {
      res.json({
        ok: true,
        id,
        content: generateSkillFallbackContent(skill),
        fallback: true
      });
    } else {
      res.status(404).json({ ok: false, error: 'Skill not found' });
    }
  }
});

function generateSkillFallbackContent(skill) {
  return `# ${skill.name}

## 核心理念
${skill.tagline}

## 详细说明
${skill.description}

## 使用场景
当遇到以下情况时，使用此技能：
- 需要系统化思考和分析问题
- 面对模糊或不明确的需求
- 需要找到最佳解决方案
- 需要深入分析和评估选项

## 调用方式
在 Cursor、Claude Code 等 AI 编程工具中输入：
\`/${skill.id}\`

${skill.isChina ? '## 中文增强\n此技能专为中文用户优化。' : ''}

---
Skill ID: ${skill.id}
分类: ${skill.category}
${skill.isChina ? 'CN 原创增强' : '翻译自 superpowers'}`;
}

// ---------- Static ----------
app.get('/teach.mp4', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.join(__dirname, 'public', 'teach.mp4'));
});

app.use('/static/covers-thumbs', express.static(path.join(__dirname, 'public', 'static', 'covers-thumbs'), {
  maxAge: '1y',
  immutable: true,
  index: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

app.get('/static/:file', (req, res, next) => {
  if (!PROTECTED_STATIC_JSON_FILES.has(String(req.params.file || ''))) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  return res.status(404).json({
    ok: false,
    error: 'not_found',
    message: 'This source file is private. Use /api/idea-libraries instead.',
  });
});

app.use('/static', express.static(path.join(__dirname, 'public', 'static'), {
  maxAge: '1d',
  index: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

if (fs.existsSync(path.join(PORTAL_DIST, 'assets'))) {
  app.use('/assets', express.static(path.join(PORTAL_DIST, 'assets'), {
    maxAge: '1d', immutable: true, index: false,
  }));
}

// ---------- 404 + error handler ----------
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});
app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  const dbCodes = new Set([
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'ER_ACCESS_DENIED_ERROR',
    'ER_BAD_DB_ERROR',
    'ER_NO_SUCH_TABLE',
    'PV_DB_TIMEOUT',
    'PROTOCOL_CONNECTION_LOST',
  ]);
  if (dbCodes.has(err?.code)) {
    return res.status(503).json({ ok: false, error: 'service_unavailable', reason: 'database_unavailable' });
  }
  res.status(500).json({ ok: false, error: 'internal' });
});

// Prime the in-memory prompts cache before accepting traffic, and start a
// file watcher so content edits hot-reload without restart.
loadPromptsCache();
loadMySQLPromptsCache().catch(err => console.warn('[prompts] MySQL cache warmup failed:', err?.message || err));
if (!process.env.VERCEL) watchPromptsFile();

// In Vercel / serverless deployments we don't call listen() — Vercel hands
// requests to the exported `app` via the api/index.js entry. Locally we
// still want to bind to a port so `node server.js` works as before.
//
// Export FIRST so serverless runtimes can pick up the handler before any
// async / side-effectful setup (file watcher, prompt cache) has a chance
// to throw — and so importing the module without invoking listen() is safe.
export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`\n  Prompt Vault running (hardened)`);
    console.log(`  → http://localhost:${PORT}\n`);
    // Note: MySQL prompts cache loads lazily on first request
    // This avoids blocking server startup on slow DB connections
  });
}

// Global unhandled rejection handler
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason?.message || reason);
});
