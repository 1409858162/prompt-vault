// LoginRiskService + DeviceManager.
// Encapsulates "is this login suspicious?" + "is this device allowed?".
//
// Risk levels:
//   low     — green, no action
//   medium  — require captcha / phone verification, but allow
//   high    — block & force logout of all sessions, alert admin
//
// Heuristics (any one triggers):
//   - IP changed in last 10 min AND country changed
//   - UA changed dramatically (browser+os family both flipped)
//   - More than 2 distinct cities active in last 10 min (impossible travel)
//   - Same user logging in from too many devices in last hour
//   - IP appears in ip_block list
//
// MySQL-backed: every read goes through lib/db.js. All exported functions are
// async — callers in server.js now `await` them.

import * as db from './db.js';
import { parseUA, countryFromIp, distanceBucket, deriveDeviceId } from './device.js';

const MAX_DEVICES_PER_USER = parseInt(process.env.MAX_DEVICES_PER_USER || '2', 10);

// Find an active IP block for an IP. Returns null if not blocked, else the row.
// "Active" = no expiry OR expiry in the future.
async function findActiveIpBlock(ip) {
  const blocks = await db.list('ip_block');
  return blocks.find(b => b.ip === ip && (!b.expires_at || new Date(b.expires_at).getTime() > Date.now())) || null;
}

export async function evaluateLoginRisk({ userId, ua, ip, clientFp }) {
  const uaInfo = parseUA(ua);
  const country = countryFromIp(ip);
  const deviceId = deriveDeviceId({ ua, ip, clientFp });

  const reasons = [];
  let score = 0;

  // Blocked IP?
  const blocked = await findActiveIpBlock(ip);
  if (blocked) {
    return { level: 'high', reasons: ['ip_blocked'], score: 100, deviceId, country, uaInfo };
  }

  // Suspicious UA strings — applied even on first login (no prior devices).
  const uaLower = String(ua || '').toLowerCase();
  if (/headlesschrome/.test(uaLower)) { reasons.push('headless_ua'); score += 40; }
  else if (/phantomjs|selenium|puppeteer|playwright/.test(uaLower)) { reasons.push('automation_ua'); score += 40; }
  else if (uaInfo.browser === 'curl' || uaInfo.browser === 'node-fetch' || uaInfo.browser === 'python-requests') {
    reasons.push('non_browser_client'); score += 60;
  }

  // Recent devices (last 1h) for this user
  const allDevices = await db.list('user_device');
  const userDevices = allDevices.filter(d => d.user_id === userId);
  const recentDevices = userDevices.filter(d => {
    const ts = d.last_active_time ? new Date(d.last_active_time).getTime() : 0;
    return Date.now() - ts < 3600_000;
  });
  const recentCountries = new Set(recentDevices.map(d => d.country).filter(Boolean));

  // 1. country mismatch with any recent device (last 10 min window)
  const recent10 = recentDevices.filter(d => {
    const ts = d.last_active_time ? new Date(d.last_active_time).getTime() : 0;
    return Date.now() - ts < 600_000;
  });
  const recent10Countries = new Set(recent10.map(d => d.country).filter(Boolean));
  if (recent10Countries.size > 0 && ![...recent10Countries].includes(country)) {
    reasons.push(`country_mismatch:${[...recent10Countries].join(',')}->${country}`);
    score += 30;
  }

  // 2. UA family mismatch (browser changed)
  const lastDevice = recentDevices.sort((a, b) => new Date(b.last_active_time) - new Date(a.last_active_time))[0];
  if (lastDevice && lastDevice.browser !== uaInfo.browser && lastDevice.os !== uaInfo.os) {
    reasons.push(`ua_family_change:${lastDevice.browser}/${lastDevice.os}->${uaInfo.browser}/${uaInfo.os}`);
    score += 20;
  }

  // 3. >2 distinct countries active in last hour
  if (recentCountries.size >= 3) {
    reasons.push(`multi_country_active:${[...recentCountries].join(',')}`);
    score += 50;
  }

  // 4. too many devices in last hour
  if (recentDevices.length >= MAX_DEVICES_PER_USER) {
    reasons.push(`device_flood:${recentDevices.length}`);
    score += 25;
  }

  // 5. distance heuristic (cross-border)
  if (lastDevice?.country) {
    const dist = distanceBucket(lastDevice.country, country);
    if (dist === 'cross_border') {
      reasons.push('cross_border_jump');
      score += 35;
    }
  }

  let level = 'low';
  if (score >= 70) level = 'high';
  else if (score >= 30) level = 'medium';

  return { level, reasons, score, deviceId, country, uaInfo };
}

// Record or refresh a device for a user.
// If account already has MAX_DEVICES_PER_USER devices AND this deviceId is new,
// returns { ok: false, reason: 'device_limit', existingDevices } so the caller
// can prompt the user to kick one out (or block, depending on policy).
export async function registerDevice({ userId, ua, ip, clientFp, location }) {
  const uaInfo = parseUA(ua);
  const country = countryFromIp(ip);
  const deviceId = deriveDeviceId({ ua, ip, clientFp });

  const all = await db.list('user_device');
  const existing = all.find(d => d.user_id === userId && d.device_id === deviceId);

  if (existing) {
    existing.last_active_time = new Date().toISOString();
    existing.ip = ip;
    existing.country = country;
    existing.location = location || existing.location;
    await db.update('user_device', existing.id, existing);
    return { ok: true, device: existing, isNew: false };
  }

  const userDevices = all.filter(d => d.user_id === userId);
  const legacySameBrowser = userDevices
    .filter(d =>
      d.browser === uaInfo.browser &&
      d.os === uaInfo.os &&
      (d.device_type || uaInfo.deviceType) === uaInfo.deviceType
    )
    .sort((a, b) => new Date(b.last_active_time) - new Date(a.last_active_time));

  if (legacySameBrowser.length) {
    const primary = legacySameBrowser[0];
    const oldDeviceIds = legacySameBrowser.slice(1).map(d => d.device_id);
    primary.device_id = deviceId;
    primary.device_type = uaInfo.deviceType;
    primary.browser = uaInfo.browser;
    primary.os = uaInfo.os;
    primary.ip = ip;
    primary.country = country;
    primary.location = location || primary.location;
    primary.last_active_time = new Date().toISOString();
    await db.update('user_device', primary.id, primary);

    for (const stale of legacySameBrowser.slice(1)) await db.remove('user_device', stale.id);

    // Revoke any session bound to a stale device id.
    const allSessions = await db.list('user_session');
    const sessions = allSessions.filter(s => s.user_id === userId && oldDeviceIds.includes(s.device_id));
    for (const s of sessions) await db.update('user_session', s.id, { revoked: true });

    return { ok: true, device: primary, isNew: false };
  }

  if (userDevices.length >= MAX_DEVICES_PER_USER) {
    return {
      ok: false,
      reason: 'device_limit',
      deviceId,
      limit: MAX_DEVICES_PER_USER,
      existingDevices: userDevices,
    };
  }

  const created = await db.insert('user_device', {
    user_id: userId,
    device_id: deviceId,
    device_type: uaInfo.deviceType,
    browser: uaInfo.browser,
    os: uaInfo.os,
    ip,
    country,
    location: location || null,
    last_active_time: new Date().toISOString(),
  });
  return { ok: true, device: created, isNew: true };
}

export async function listDevices(userId) {
  const all = await db.list('user_device');
  return all
    .filter(d => d.user_id === userId)
    .sort((a, b) => new Date(b.last_active_time) - new Date(a.last_active_time));
}

export async function kickDevice(userId, deviceId) {
  const all = await db.list('user_device');
  const d = all.find(x => x.user_id === userId && x.device_id === deviceId);
  if (!d) return false;
  await db.remove('user_device', d.id);
  const sessions = (await db.list('user_session')).filter(s => s.user_id === userId && s.device_id === deviceId);
  for (const s of sessions) await db.remove('user_session', s.id);
  return true;
}

// Create / look up an active session for a JWT.
export async function recordSession({ jti, userId, deviceId, ip, ua, expiresAt, expires_at }) {
  // Support both naming styles — server.js calls with `expires_at` and the old
  // lib accepted `expiresAt`. Whichever is present wins.
  const exp = expiresAt || expires_at || null;
  return await db.insert('user_session', {
    id: jti,
    jti,
    user_id: userId,
    device_id: deviceId,
    ip,
    ua,
    expires_at: exp,
    revoked: false,
  });
}

export async function isSessionRevoked(jti) {
  const s = await db.findById('user_session', jti); // by record id (== jti)
  return s ? !!s.revoked : false;
}

export async function revokeAllSessionsForUser(userId) {
  const sessions = (await db.list('user_session')).filter(s => s.user_id === userId);
  for (const s of sessions) await db.update('user_session', s.id, { revoked: true });
  return sessions.length;
}

// Helper used by the global IP-block middleware in server.js.
export async function isIpBlocked(ip) {
  const b = await findActiveIpBlock(ip);
  return !!b;
}