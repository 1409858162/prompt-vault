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
} from './lib/membership.js';
import {
  issueContentToken, consumeContentToken,
  signDownloadUrl, verifyDownloadSignature,
  issueVideoKey, issueVideoKeyToken, verifyVideoKeyToken,
} from './lib/contentToken.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? null : 'dev-jwt-secret-change-me');
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required when NODE_ENV=production');
}
const ADMIN_USER_IDS = new Set(
  String(process.env.ADMIN_USER_IDS || '')
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

const PORTAL_DIST = path.join(__dirname, 'portal', 'dist');
const PROMPTS_PATH = path.join(__dirname, 'merged-prompts.json');

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
app.use(async (req, _res, next) => {
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
});

function requireAuth(req, res, next) {
  if (!req.auth) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (ADMIN_USER_IDS.size === 0) {
    if (IS_PRODUCTION) return res.status(503).json({ ok: false, error: 'admin_not_configured' });
    return next();
  }
  if (ADMIN_USER_IDS.has(req.userId)) return next();
  return res.status(403).json({ ok: false, error: 'forbidden' });
}

// ---------- Global gateway: IP-level rate limit + per-IP burst ----------
const GLOBAL_IP_LIMIT = parseInt(process.env.GLOBAL_IP_LIMIT || '600', 10); // req/min/IP
app.use(async (req, res, next) => {
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
});

// Per-user behavior inspection (only for authenticated traffic).
// Whitelist auth-lifecycle endpoints (logout, /api/me read-only) — they must
// always work even if the user is being rate-limited for content scraping.
const INSPECT_WHITELIST = /^\/api\/(logout|me|devices|admin\/security|captcha\/new)$/;
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (!req.auth) return next(); // unauthenticated traffic handled by route-level guards
  if (INSPECT_WHITELIST.test(req.path)) return next();
  const r = inspect({ userId: req.userId, deviceId: req.deviceId, ip: req.clientIp, path: req.path });
  if (!r.allowed) {
    // Auto-ban ONLY for content-scraping patterns (see AUTO_BAN_CLASSES).
    // /api/me or /api/devices bursts are rate-limited but not auto-banned.
    if (r.score >= 80 && r.cls && /^(prompt_list|prompt_detail|file_download|video_segment)$/.test(r.cls)) {
      autoBan({ ip: req.clientIp, userId: req.userId, reason: r.reason });
    }
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, error: 'too_many_requests', reason: r.reason, limit: r.limit, current: r.current });
  }
  next();
});

// ---------- Login page (portal SPA) ----------
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
  res.send(html);
});

// ---------- CAPTCHA endpoints ----------
app.get('/api/captcha/new', async (req, res) => {
  const c = await issueCaptcha();
  res.json({ ok: true, ...c });
});
app.post('/api/captcha/verify', async (req, res) => {
  const { challenge_id, answer } = req.body || {};
  if (!challenge_id || answer == null) return res.status(400).json({ ok: false, error: 'missing_params' });
  const r = await verifyCaptcha({ challenge_id, answer: Number(answer) });
  res.json({ ok: r.ok, reason: r.reason || null });
});

// ---------- LOGIN (mode='password', with risk + device binding) ----------
app.post('/api/login', async (req, res) => {
  const start = Date.now();
  const {
    mode = 'password',
    username,
    password,
    captcha_id,
    captcha_answer,
    client_fp,
    next = '/',
  } = req.body || {};

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
});

// ---------- REGISTER (invite-code bound, then sets username+password) ----------
// Body: { code, captcha_id?, captcha_answer?, client_fp?, username, password }
// Behaviour:
//   1. Verify invite-code plaintext (bcrypt) — must be unused, not revoked, not promoted.
//   2. Validate username (4-20 chars, charset) + uniqueness (case-sensitive).
//   3. bcrypt the password, create accounts record, mark the code consumed_for_account.
//   4. Reuse the same risk+captcha+device pipeline as login (skip 'medium risk if first ever' for promotions).
//   5. Mint session cookie immediately so the user lands logged-in (we still cap the device list).
app.post('/api/register', async (req, res) => {
  const start = Date.now();
  const {
    code, username, password,
    captcha_id, captcha_answer, client_fp,
  } = req.body || {};

  // Throttle: per-IP and per-code. Same key namespace idea as login so refills match human latency.
  const ipThrottle = take(`register:ip:${req.clientIp}`, 5, 5 / (10 * 60));
  if (!ipThrottle.ok) {
    return res.status(429).json({ ok: false, error: '注册尝试过于频繁，请稍后再试' });
  }
  if (typeof code !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: '请求参数不完整' });
  }
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  if (normalized.length !== 50) {
    return res.status(400).json({ ok: false, error: '邀请码格式不正确（应为 50 位）' });
  }

  // Pre-validate username/password shape before doing any bcrypt work (cheap).
  const uv = accounts.validateUsername(username);
  if (!uv.ok) return res.status(400).json({ ok: false, error: uv.error });
  const pv = accounts.validatePassword(password);
  if (!pv.ok) return res.status(400).json({ ok: false, error: pv.error });

  // Find the invite; reject if consumed/revoked/promoted.
  const entry = await store.findByPlaintext(normalized);
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

  // Risk evaluation — treat registration like a login for risk purposes.
  const risk = await evaluateLoginRisk({
    userId: entry.id, ua: req.headers['user-agent'] || '',
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

  // Create the account record FIRST (username uniqueness check inside).
  await store.activateMembership(entry.id);
  const activatedCode = await store.findById(entry.id);
  let acct;
  try {
    acct = await accounts.createAccount({
      username: uv.value, password: pv.value,
      kind: 'promoted', promoted_from_code: entry.id,
      note: 'auto-registered via invite',
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

  // Mark the invite consumed NOW that the account exists. If a concurrent
  // register also passed pre-validate, the second consumeForPromotion is a no-op
  // (we still re-check below before issuing cookies).
  await store.consumeForPromotion(entry.id, acct.id);

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
    type: 'register_ok', user_id: acct.id, from_code: entry.id, ip: req.clientIp,
    device_id: reg.device.device_id, ms: Date.now() - start,
  }).catch(err => console.error('[register] log error:', err.message));

  res.json({ ok: true, next: '/', device_id: reg.device.device_id, username: acct.username });
});

app.post('/api/logout', async (req, res) => {
  if (req.jti) {
    await db.update('user_session', req.jti, { revoked: true, revoked_at: new Date().toISOString() });
  }
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ---------- Pages ----------
app.get('/', requireAuth, (_req, res) => { res.setHeader('Cache-Control','no-store'); res.sendFile(path.join(__dirname,'public','app.html')); });
app.get('/app', requireAuth, (_req, res) => { res.setHeader('Cache-Control','no-store'); res.sendFile(path.join(__dirname,'public','app.html')); });
app.get('/me', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'me.html')));
app.get('/admin/security', requireAuth, requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'security.html')));

// ---------- Authenticated APIs ----------

// /api/me — unified user view for both invite-code and account identities.
// Legacy fields (member_days, use_count, note, created_at, last_used_at, masked, id)
// are preserved so me.html keeps working unchanged. New fields `kind` and
// `username` are added so newer UIs can distinguish identity type cleanly.
app.get('/api/me', async (req, res) => {
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
});

// ---------- Announcements ----------
// Public read endpoint — any logged-in user can fetch active announcements.
// Returns pinned-first, then newest-first. Expired or inactive rows are hidden.
app.get('/api/announcements', requireAuth, async (_req, res) => {
  res.json({ ok: true, announcements: await announcements.listActive() });
});

// /api/devices — list / kick
app.get('/api/devices', requireAuth, async (req, res) => {
  res.json({ ok: true, devices: await listDevices(req.userId) });
});
app.post('/api/devices/kick', requireAuth, async (req, res) => {
  const { device_id } = req.body || {};
  if (!device_id) return res.status(400).json({ ok: false, error: 'missing_device_id' });
  if (device_id === req.deviceId) {
    return res.status(400).json({ ok: false, error: 'cannot_kick_self' });
  }
  const ok = await kickDevice(req.userId, device_id);
  res.json({ ok });
});

const PROMPT_URL_RE = /https?:\/\/[^\s<>)\]"']+/g;
const IMAGE_PREVIEW_RE = /\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i;
const VIDEO_PREVIEW_RE = /\.(?:mp4|webm|mov|m4v|m3u8)(?:[?#]|$)/i;

function cleanPromptUrl(raw) {
  return String(raw || '').replace(/[.,;:!?，。；：！？]+$/u, '');
}

function classifyPreviewUrl(url) {
  if (IMAGE_PREVIEW_RE.test(url)) return 'image';
  if (VIDEO_PREVIEW_RE.test(url)) return 'video';
  return null;
}

function extractPreviewFromPromptText(promptText) {
  const urls = String(promptText || '').match(PROMPT_URL_RE) || [];
  for (const raw of urls) {
    const url = cleanPromptUrl(raw);
    const kind = classifyPreviewUrl(url);
    if (kind) return { kind, url };
  }
  return null;
}

function promptListItem(p) {
  const explicitImage = p.preview_image_url || p.image_preview_url || null;
  const explicitVideo = p.preview_video_url || p.video_preview_url || null;
  const explicitPlayable = p.playable_video_url || null;
  const derived = (!explicitImage && !explicitVideo && !explicitPlayable)
    ? extractPreviewFromPromptText(p.prompt_text)
    : null;
  const previewImageUrl = explicitImage || (derived?.kind === 'image' ? derived.url : null);
  const previewVideoUrl = explicitVideo || null;
  const playableVideoUrl = explicitPlayable || (derived?.kind === 'video' ? derived.url : null);
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
    preview_video_url: previewVideoUrl,
    playable_video_url: playableVideoUrl,
    // has_prompt_text: hint that content is available; never include the body
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
app.get('/api/prompts', requireAuth, (req, res) => {
  const cache = getPromptsCache();
  // Negotiate 304 — both ETag and Last-Modified supported, browser picks one.
  // Note: the catalog is per-user but the LIST metadata is identical across
  // users (only /api/prompts/:id is gated by membership), so caching here
  // is safe. We set `private` so shared proxies don't serve user A's list to
  // user B; `max-age=60` lets the browser skip the round-trip entirely on
  // F5 / page-reload within a minute.
  res.setHeader('Cache-Control', 'private, max-age=60');
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
    total: cache.sanitized.length,
    page, limit,
    has_more: start + limit < cache.sanitized.length,
    items,
  });
});

// /api/prompts/:id — chapter-level detail.
// Requires a valid content_token issued by /api/prompts/:id/access.
app.get('/api/prompts/:id/access', requireAuth, async (req, res) => {
  if (denyIfNotMember(req, res)) return;
  const id = req.params.id;
  // Look up via the in-memory cache (built once at boot, hot-reloaded on file change).
  const cache = getPromptsCache();
  const found = cache.byId.get(id);
  if (!found) return res.status(404).json({ ok: false, error: 'not_found' });

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
});

app.get('/api/prompts/:id', requireAuth, async (req, res) => {
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
  const meta = promptListItem(found);

  res.json({
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
    preview_video_url: meta.preview_video_url,
    playable_video_url: meta.playable_video_url,
    watermark,
  });
});

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
app.get('/api/video/:id/key', requireAuth, async (req, res) => {
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
});

// /api/video/:id/access — mint a 1h video key token (single-use, IP+device bound).
app.get('/api/video/:id/access', requireAuth, async (req, res) => {
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
});

// ---------- Admin security console (read-only APIs) ----------
app.get('/api/admin/security/overview', requireAuth, requireAdmin, async (req, res) => {
  const today = Date.now() - 24 * 3600 * 1000;
  const [eventsAll, behAll, ipBlocksAll, sessionsAll] = await Promise.all([
    db.list('security_event'),
    db.list('user_behavior_log'),
    db.list('ip_block'),
    db.list('user_session'),
  ]);
  const events = eventsAll.filter(e => (e.ts || 0) >= today);
  const beh = behAll.filter(e => (e.ts || 0) >= today);
  const ipBlocks = ipBlocksAll.filter(b => !b.expires_at || new Date(b.expires_at).getTime() > Date.now());
  const sessions = sessionsAll.filter(s => !s.revoked);

  // Top users
  const byUser = new Map();
  for (const b of beh) {
    const k = b.user_id || 'anon';
    byUser.set(k, (byUser.get(k) || 0) + 1);
  }
  const topUsers = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([user_id, hits]) => ({ user_id, hits }));

  const byIp = new Map();
  for (const b of beh) {
    const k = b.ip || 'unknown';
    byIp.set(k, (byIp.get(k) || 0) + 1);
  }
  const topIps = [...byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([ip, hits]) => ({ ip, hits }));

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
    recent_events: events.slice(-30).reverse(),
    blocked_ips: ipBlocks,
  });
});

app.post('/api/admin/security/unblock-ip', requireAuth, requireAdmin, async (req, res) => {
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ ok: false, error: 'missing_ip' });
  const before = await db.list('ip_block');
  const targets = before.filter(b => b.ip === ip);
  for (const b of targets) await db.remove('ip_block', b.id);
  res.json({ ok: true, removed: targets.length });
});

app.post('/api/admin/security/block-ip', requireAuth, requireAdmin, async (req, res) => {
  const { ip, reason, ttl_seconds } = req.body || {};
  if (!ip) return res.status(400).json({ ok: false, error: 'missing_ip' });
  const ttl = Number(ttl_seconds || 86400);
  await db.insert('ip_block', {
    ip, reason: reason || 'manual', expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  });
  db.appendLog('security_event', { type: 'manual_block', ip, reason })
    .catch(err => console.error('[admin] log error:', err.message));
  res.json({ ok: true });
});

// ---------- Admin: announcements ----------
// List every announcement (including inactive/expired) for the admin console.
app.get('/api/admin/announcements', requireAuth, requireAdmin, async (_req, res) => {
  res.json({ ok: true, announcements: await announcements.listAll() });
});

// Create a new announcement. Body fields: kind, title, body, expires_at, pinned.
app.post('/api/admin/announcements', requireAuth, requireAdmin, async (req, res) => {
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
});

// Patch an existing announcement (toggle active, edit content, etc).
app.post('/api/admin/announcements/:id/update', requireAuth, requireAdmin, async (req, res) => {
  const entry = await announcements.update(req.params.id, req.body || {});
  if (!entry) return res.status(404).json({ ok: false, error: 'not_found' });
  db.appendLog('security_event', { type: 'announcement_updated', id: entry.id, by: req.userId })
    .catch(err => console.error('[admin] log error:', err.message));
  res.json({ ok: true, announcement: entry });
});

// Hard-delete an announcement.
app.post('/api/admin/announcements/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  const ok = await announcements.remove(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  db.appendLog('security_event', { type: 'announcement_deleted', id: req.params.id, by: req.userId })
    .catch(err => console.error('[admin] log error:', err.message));
  res.json({ ok: true });
});

// ---------- Admin: batch invite-code generation ----------
// POST { count: <1..200>, label?: string, note?: string, years?: number }
// Returns { ok, codes: [{ id, plaintext, label, note, membership_years }, ...] }.
// Cap at 200 to keep the response size sane and the bcrypt batch short.
app.post('/api/admin/invites/batch', requireAuth, requireAdmin, async (req, res) => {
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
});

// ---------- Static ----------
app.use('/static', express.static(path.join(__dirname, 'public', 'static'), {
  maxAge: 0,
  // Disable directory listing / execution
  index: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
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
  res.status(500).json({ ok: false, error: 'internal' });
});

// Prime the in-memory prompts cache before accepting traffic, and start a
// file watcher so content edits hot-reload without restart.
loadPromptsCache();
watchPromptsFile();

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
