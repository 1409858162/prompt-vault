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
  prompt_detail:  { perMinute: 100, perHour: 600 },
  file_download:  { perMinute: 10, perHour: 60 },
  video_segment:  { perMinute: 300, perHour: 3000 },
  login:          { perMinute: 10, perHour: 30 },
  // "other" is anything else under /api/* — /api/me polling, /api/devices, etc.
  // Keep generous to avoid breaking legitimate single-page-app polling.
  other:          { perMinute: 120, perHour: 1200 },
};

const ABUSE_SCORE_THRESHOLD = 80; // sum of score-weighted triggers
// Only auto-ban on content-scraping endpoints, never on /api/me polling.
const AUTO_BAN_CLASSES = new Set(['prompt_list', 'prompt_detail', 'file_download']);

export function classifyApi(path) {
  if (/^\/api\/prompts(\/|$|\?)/.test(path)) {
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

  const mKey = `u:${userId}:${cls}:m`;
  const hKey = `u:${userId}:${cls}:h`;
  recordHit(mKey);
  recordHit(hKey);

  const m = countInWindow(mKey, 60_000);
  const h = countInWindow(hKey, 3_600_000);

  // Log every request (cheap; later wired to ELK / ClickHouse)
  db.appendLog('user_behavior_log', {
    user_id: userId, device_id: deviceId, ip,
    api: cls, path,
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
      reason: 'rate_per_minute',
      limit: th.perMinute, current: m, score,
    };
  }
  if (h > th.perHour) {
    return {
      allowed: false,
      cls,
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
      reason: 'abuse_score',
      score,
    };
  }
  return { allowed: true, cls, score };
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