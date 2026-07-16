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
import { describeConnection, query as mysqlQuery, transaction } from './lib/mysql.js';

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
const COOKIE_NAME = 'pv_session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (re-issued on each login)

const app = express();
const TRUST_PROXY = process.env.TRUST_PROXY ?? (IS_PRODUCTION ? '1' : 'true');
app.set('trust proxy', TRUST_PROXY === 'true' ? true : TRUST_PROXY === 'false' ? false : Number(TRUST_PROXY) || TRUST_PROXY);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(cookieParser());

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
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
// Cache shape:
//   sanitized[]       — list view (no prompt_text)
//   byId: Map         — id -> raw record (used by /:id/access and /:id)
let PROMPTS_CACHE = null;
function loadPromptsCache() {
  const raw = fs.readFileSync(PROMPTS_PATH, 'utf8');
  const data = JSON.parse(raw);
  const sanitized = data.map(promptListItem);
  const byId = new Map();
  for (const p of data) byId.set(p.id, p);
  const etag = '"' + crypto.createHash('sha1')
    .update('v1')
    .update(String(sanitized.length))
    .update(raw.slice(0, 4096))
    .update(raw.slice(-4096))
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
  console.log(`  -> prompts cache loaded: ${sanitized.length} items (${(raw.length / 1024).toFixed(0)}KB source)`);
}
function getPromptsCache() {
  if (!PROMPTS_CACHE) loadPromptsCache();
  return PROMPTS_CACHE;
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
  if (req.clientIp) {
    tasks.push(db.insert('ip_block', {
      ip: req.clientIp,
      reason: `honeypot:${safeKind}`,
      expires_at: expiresAt,
    }));
  }
  await Promise.allSettled(tasks);
  if (req.auth || req.jti) clearSessionCookie(res);
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

function denyIfNotMember(req, res) {
  const status = membershipForAuth(req);
  if (!status.is_member) {
    res.status(403).json({
      ok: false,
      error: 'membership_required',
      reason: status.reason,
      membership: membershipPayload(status),
    });
    return true;
  }
  return false;
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

function promptBodyPayload(found, watermark = null) {
  const meta = promptListItem(found);
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
    prompt_text: found.prompt_text || null,
    preview_image_url: meta.preview_image_url,
    preview_thumb_url: meta.preview_thumb_url,
    preview_video_url: meta.preview_video_url,
    playable_video_url: meta.playable_video_url,
    watermark,
  };
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
  if (!req.auth) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
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
  if ((code != null && typeof code !== 'string') || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: '请求参数不完整' });
  }
  // Pre-validate username/password shape before doing any bcrypt work (cheap).
  const uv = accounts.validateUsername(username);
  if (!uv.ok) return res.status(400).json({ ok: false, error: uv.error });
  const pv = accounts.validatePassword(password);
  if (!pv.ok) return res.status(400).json({ ok: false, error: pv.error });

  const hasInvite = typeof code === 'string' && code.trim().length > 0;
  let entry = null;
  if (hasInvite) {
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    if (![32, 50].includes(normalized.length)) {
      return res.status(400).json({ ok: false, error: '邀请码格式不正确（应为 32 位；旧邀请码 50 位也可用）' });
    }

    // Find the invite; reject if consumed/revoked/promoted.
    entry = await store.findByPlaintext(normalized);
    if (!entry) {
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
  const activatedCode = entry ? await store.activateMembership(entry.id) : null;
  let acct;
  try {
    acct = await accounts.createAccount({
      username: uv.value, password: pv.value,
      kind: accountKind, promoted_from_code: promotedFromCode,
      note: entry ? 'auto-registered via invite' : 'self-registered account',
      membership_years: activatedCode?.membership_years ?? null,
      activated_at: activatedCode?.activated_at ?? null,
      expires_at: activatedCode?.expires_at ?? null,
    });
  } catch (e) {
    if (e && e.code === 'username_taken') {
      return res.status(409).json({ ok: false, error: '用户名已被占用' });
    }
    return res.status(400).json({ ok: false, error: e.message || '注册失败' });
  }

  // Mark the invite consumed NOW that the account exists. If this was a normal
  // registration, there is no invite to consume.
  if (entry) {
    await store.consumeForPromotion(entry.id, acct.id);
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
  const action = severity === 'critical' ? 'revoke_all_sessions' : 'revoke_session';
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
    action,
    detail,
  });
  res.status(204).end();
}));

// ---------- Pages ----------
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  res.sendFile(path.join(__dirname,'public','app.html'));
});
app.get('/app', (_req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, noimageindex');
  res.sendFile(path.join(__dirname,'public','app.html'));
});
app.get('/me', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'me.html')));
app.get('/admin/security', requireAuth, requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'security.html')));

// ---------- Authenticated APIs ----------

// /api/me — unified user view for both invite-code and account identities.
// Legacy fields (member_days, use_count, note, created_at, last_used_at, masked, id)
// are preserved so me.html keeps working unchanged. New fields `kind` and
// `username` are added so newer UIs can distinguish identity type cleanly.
app.get('/api/me', asyncHandler(async (req, res) => {
  if (!req.auth && req.query.optional === '1') {
    return res.json({
      ok: true,
      authenticated: false,
      membership: guestMembershipPayload(),
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

  const rawCode = String(req.body?.code || '').trim();
  if (!rawCode) {
    return res.status(400).json({ ok: false, error: 'missing_code', message: '请输入邀请码' });
  }

  const normalized = rawCode.replace(/[\s-]/g, '').toUpperCase();
  if (![32, 50].includes(normalized.length)) {
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

  const item = {
    id: p.id,
    title: p.title,
    category: wasBlindBox && hasPreview && p.original_category ? p.original_category : p.category,
    original_category: p.original_category || null,
    special_collection: wasBlindBox && hasPreview ? null : (p.special_collection || null),
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
app.get('/api/prompts', (req, res) => {
  if (throttleCatalogPreview(req, res)) return;
  const cache = getPromptsCache();
  // Negotiate 304 — both ETag and Last-Modified supported, browser picks one.
  // Note: the catalog is per-user but the LIST metadata is identical across
  // users (only /api/prompts/:id is gated by membership), so caching here
  // is safe. We set `private` so shared proxies don't serve user A's list to
  // user B; `max-age=60` lets the browser skip the round-trip entirely on
  // F5 / page-reload within a minute.
  res.setHeader('Cache-Control', 'private, max-age=60');
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
    viewer: req.auth
      ? { authenticated: true, membership: membershipPayload(membershipForAuth(req)) }
      : { authenticated: false, membership: guestMembershipPayload() },
    total: cache.sanitized.length,
    page, limit,
    has_more: start + limit < cache.sanitized.length,
    items,
  });
});

app.all(HONEYPOT_RESOURCE_ROUTES, asyncHandler(async (req, res) => {
  if (isTrustedHoneypotRequest(req)) {
    await triggerHoneypot(req, res, {
      kind: 'fake_resource_probe',
      source: 'fake_resource',
      severity: 'critical',
      action: 'revoke_all_sessions',
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
app.get('/api/prompts/:id/access', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const cache = getPromptsCache();
  const found = cache.byId.get(id);
  if (!found) return res.status(404).json({ ok: false, error: 'not_found' });

  if (isPublicPromptItem(found)) {
    return res.json({
      ...promptBodyPayload(found, null),
      access: 'public',
    });
  }

  if (!req.auth) {
    return res.status(403).json({
      ok: false,
      error: 'membership_required',
      reason: 'guest',
      message: '开通会员后可查看和复制完整提示词',
      membership: guestMembershipPayload(),
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
  if (denyIfNotMember(req, res)) return;
  const id = req.params.id;
  const token = req.query.content_token || req.headers['x-content-token'];
  if (!token) {
    return res.status(401).json({ ok: false, error: 'content_token_required' });
  }
  const cv = await consumeContentToken({
    token, expectedResource: `prompt:${id}`,
    userId: req.userId, deviceId: req.deviceId, ip: req.clientIp,
  });
  if (!cv.ok) {
    return res.status(401).json({ ok: false, error: 'content_token_invalid', reason: cv.reason });
  }

  const cache = getPromptsCache();
  const found = cache.byId.get(id);
  if (!found) return res.status(404).json({ ok: false, error: 'not_found' });

  // Watermark metadata injected on EVERY chapter read.
  const watermark = {
    user_id: req.userId,
    masked_id: req.userId.length > 8 ? `${req.userId.slice(0,4)}…${req.userId.slice(-4)}` : req.userId,
    device_id: req.deviceId,
    ip: req.clientIp,
    ts: Date.now(),
    token_jti: cv.payload.jti,
  };
  res.json(promptBodyPayload(found, watermark));
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
    const details = row.payload && typeof row.payload === 'object' ? row.payload : {};
    rememberIpUser(row.ip || details.ip, row.user_id || details.user_id, row.ts || 0);
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
    const details = event.payload && typeof event.payload === 'object' ? event.payload : {};
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
      auto_ban: events.filter(e => e.type === 'auto_ban_candidate').length,
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
    accounts: accountsAll.map(adminAccountSummary),
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
  app.listen(PORT, () => {
    console.log(`\n  Prompt Vault running (hardened)`);
    console.log(`  → http://localhost:${PORT}\n`);
  });
}
