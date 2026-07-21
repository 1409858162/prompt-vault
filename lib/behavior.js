// Behavior analysis: detect "1 minute, 500 chapters" scrapers vs "20-50/day" humans.
//
// Strategy: rolling window counters per (user, api-class). If a counter
// exceeds a threshold, the request is blocked (429) AND the user gets
// recorded as a security event. The admin console surfaces the top offenders.
//
// API classes (thresholds per minute unless noted):
//   prompt_list    — 60/min (humans scroll, bots prefetch)
//   prompt_detail  — 30/min (each chapter is a detail)
//   file_download  — 10/min  (humans don't download 600 PDFs in a minute)
//   video_segment  — 300/min (HLS segments; high but bounded)

import * as db from './db.js';
import { countInWindow, recordHit } from './rateLimit.js';

const THRESHOLDS = {
  prompt_list:    { perMinute: 200, perHour: 2000 },
  prompt_access:  { perMinute: 100, perHour: 1200 },
  prompt_detail:  { perMinute: 80, perHour: 1200 },
  file_download:  { perMinute: 10, perHour: 60 },
  video_segment:  { perMinute: 300, perHour: 3000 },
  login:          { perMinute: 10, perHour: 30 },
  // "other" is anything else under /api/* — /api/me polling, /api/devices, etc.
  // Keep generous to avoid breaking legitimate single-page-app polling.
  other:          { perMinute: 120, perHour: 1200 },
};

const ABUSE_SCORE_THRESHOLD = 80; // sum of score-weighted triggers
// Only auto-ban on content-scraping endpoints, never on /api/me polling.
const AUTO_BAN_CLASSES = new Set(['prompt_list', 'prompt_access', 'prompt_detail', 'file_download']);

// Distinct prompt-body reads are a much stronger scraping signal than raw
// request counts. Keep this tolerant enough for fast human browsing: the fast
// sweep rule now only trips above roughly 10 different prompt bodies/minute.
const PROMPT_SWEEP_RULES = [
  {
    windowMs: 3 * 60_000,
    distinctLimit: 45,
    reason: 'prompt_sweep_fast',
    action: 'revoke_session',
    score: 120,
    banTtlMs: 30 * 60 * 1000,
  },
  {
    windowMs: 10 * 60_000,
    distinctLimit: 140,
    reason: 'prompt_sweep_10m',
    action: 'revoke_all_sessions',
    score: 150,
    banTtlMs: 12 * 60 * 60 * 1000,
  },
  {
    windowMs: 60 * 60_000,
    distinctLimit: 601,
    reason: 'prompt_sweep_1h',
    action: 'revoke_all_sessions',
    score: 180,
    banTtlMs: 24 * 60 * 60 * 1000,
  },
];

const PROMPT_TOUCH_KEEP_MS = PROMPT_SWEEP_RULES[PROMPT_SWEEP_RULES.length - 1].windowMs;
const _promptTouches = new Map(); // key -> [{ ts, promptId }]
const PROMPT_TOUCH_MAX_KEYS = 5000;

function promptTouchKey(userId, deviceId) {
  return `prompt-touch:${userId}:${deviceId || '-'}`;
}

function trimPromptTouches(key, now = Date.now()) {
  const cutoff = now - PROMPT_TOUCH_KEEP_MS;
  const trimmed = (_promptTouches.get(key) || []).filter((entry) => entry.ts >= cutoff);
  if (trimmed.length) _promptTouches.set(key, trimmed);
  else _promptTouches.delete(key);
  if (_promptTouches.size > PROMPT_TOUCH_MAX_KEYS) {
    const oldest = [..._promptTouches.keys()].slice(0, 500);
    for (const stale of oldest) _promptTouches.delete(stale);
  }
  return trimmed;
}

function extractPromptId(path) {
  const accessMatch = String(path || '').match(/^\/api\/prompts\/([^/]+)\/access$/);
  if (accessMatch) return decodeURIComponent(accessMatch[1]);
  const detailMatch = String(path || '').match(/^\/api\/prompts\/([^/]+)$/);
  if (detailMatch) return decodeURIComponent(detailMatch[1]);
  return null;
}

function inspectPromptSweep({ userId, deviceId, path, cls }) {
  if (cls !== 'prompt_detail') return null;
  const promptId = extractPromptId(path);
  if (!promptId) return null;

  const now = Date.now();
  const key = promptTouchKey(userId, deviceId);
  const arr = trimPromptTouches(key, now);
  arr.push({ ts: now, promptId });
  _promptTouches.set(key, arr);

  for (const rule of PROMPT_SWEEP_RULES) {
    const cutoff = now - rule.windowMs;
    const distinct = new Set(arr.filter((entry) => entry.ts >= cutoff).map((entry) => entry.promptId));
    if (distinct.size >= rule.distinctLimit) {
      return {
        allowed: false,
        cls,
        promptId,
        distinctPrompts: distinct.size,
        windowMs: rule.windowMs,
        reason: rule.reason,
        action: rule.action,
        score: rule.score,
        banTtlMs: rule.banTtlMs,
      };
    }
  }

  return { promptId };
}

export function classifyApi(path) {
  if (/^\/api\/prompts(\/|$|\?)/.test(path)) {
    if (/^\/api\/prompts\/[^/]+\/access$/.test(path)) return 'prompt_access';
    if (/^\/api\/prompts\/[^/]+$/.test(path)) return 'prompt_detail';
    return 'prompt_list';
  }
  if (/^\/api\/file\//.test(path)) return 'file_download';
  if (/^\/api\/video\//.test(path)) return 'video_segment';
  if (/^\/api\/login/.test(path)) return 'login';
  return 'other';
}

// Returns { allowed, reason, action }.
//   allowed=false → caller should respond 429 and may auto-ban.
//
// Synchronous: the rate-window counters are in-memory (lib/rateLimit.js). The
// `appendLog` writes are fire-and-forget — they don't gate the request. We
// swallow rejections so an unreachable DB never produces an UnhandledPromise.
export function inspect({ userId, deviceId, ip, path }) {
  const cls = classifyApi(path);
  const th = THRESHOLDS[cls];
  if (!th) return { allowed: true, cls };

  const sweep = inspectPromptSweep({ userId, deviceId, path, cls });
  if (sweep && sweep.allowed === false) {
    db.appendLog('security_event', {
      type: 'prompt_sweep_detected',
      user_id: userId,
      device_id: deviceId,
      ip,
      cls,
      prompt_id: sweep.promptId,
      distinct_prompts: sweep.distinctPrompts,
      window_ms: sweep.windowMs,
      action: sweep.action,
      score: sweep.score,
      reason: sweep.reason,
    }).catch(err => console.error('[behavior] prompt sweep log failed:', err.message));
    return sweep;
  }
  const promptId = sweep?.promptId || extractPromptId(path);

  const mKey = `u:${userId}:${cls}:m`;
  const hKey = `u:${userId}:${cls}:h`;
  recordHit(mKey);
  recordHit(hKey);

  const m = countInWindow(mKey, 60_000);
  const h = countInWindow(hKey, 3_600_000);

  // Log every request (cheap; later wired to ELK / ClickHouse)
  db.appendLog('user_behavior_log', {
    user_id: userId, device_id: deviceId, ip,
    cls, api: cls, path, prompt_id: promptId,
  }).catch(err => console.error('[behavior] log failed:', err.message));

  let score = 0;
  if (m > th.perMinute) score += 50;
  if (h > th.perHour) score += 30;
  // 5x over: instant block
  if (m > th.perMinute * 5) score += 100;
  if (h > th.perHour * 5) score += 80;

  if (m > th.perMinute) {
    return {
      allowed: false,
      cls,
      promptId,
      reason: 'rate_per_minute',
      limit: th.perMinute, current: m, score,
    };
  }
  if (h > th.perHour) {
    return {
      allowed: false,
      cls,
      promptId,
      reason: 'rate_per_hour',
      limit: th.perHour, current: h, score,
    };
  }
  if (score >= ABUSE_SCORE_THRESHOLD && AUTO_BAN_CLASSES.has(cls)) {
    db.appendLog('security_event', {
      type: 'auto_ban_candidate', user_id: userId, device_id: deviceId, ip,
      score, cls, m, h,
    }).catch(err => console.error('[behavior] security log failed:', err.message));
    return {
      allowed: false,
      cls,
      promptId,
      reason: 'abuse_score',
      score,
    };
  }
  return { allowed: true, cls, score, promptId };
}

// Auto-ban a user/IP after repeated abuse. Fire-and-forget; same rationale as
// `inspect` — the request has already been 429'd, no need to await the DB.
export function autoBan({ ip, userId, reason, ttlMs = 24 * 3600 * 1000 }) {
  if (ip) {
    db.insert('ip_block', {
      ip, reason: `auto:${reason}`,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    }).catch(err => console.error('[behavior] ip_block insert failed:', err.message));
  }
  if (userId) {
    db.appendLog('security_event', {
      type: 'user_flagged', user_id: userId, reason,
    }).catch(err => console.error('[behavior] security log failed:', err.message));
  }
}
