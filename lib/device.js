// Fingerprint & bot-detection helpers.
// Server-side uses User-Agent + IP + Accept-Language to derive a coarse
// device id. Real device fingerprinting happens client-side via
// /portal/src/fingerprint.ts; the server combines it with UA to a stable
// device_id that survives cookie clears (so we can re-bind on same device).

import crypto from 'node:crypto';

export function getClientIp(req) {
  // Trust X-Forwarded-For only if behind a known proxy (configurable later).
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || '0.0.0.0';
}

export function parseUA(ua = '') {
  const s = String(ua);
  const lower = s.toLowerCase();
  let os = 'unknown';
  if (/windows nt 10/.test(lower)) os = 'Windows 10/11';
  else if (/windows/.test(lower)) os = 'Windows';
  else if (/mac os x/.test(lower)) os = 'macOS';
  else if (/iphone os/.test(lower)) os = 'iOS';
  else if (/ipad/.test(lower)) os = 'iPadOS';
  else if (/android/.test(lower)) os = 'Android';
  else if (/linux/.test(lower)) os = 'Linux';

  let browser = 'unknown';
  if (/edg\//.test(lower)) browser = 'Edge';
  else if (/headlesschrome/.test(lower)) browser = 'HeadlessChrome';
  else if (/chrome\//.test(lower) && !/chromium/.test(lower)) browser = 'Chrome';
  else if (/firefox\//.test(lower)) browser = 'Firefox';
  else if (/safari\//.test(lower) && !/chrome/.test(lower)) browser = 'Safari';
  else if (/curl\//.test(lower)) browser = 'curl';
  else if (/^node\.js\//i.test(ua)) browser = 'node';
  else if (/node-fetch/.test(lower)) browser = 'node-fetch';
  else if (/python-requests/.test(lower)) browser = 'python-requests';

  const deviceType = /mobile|android|iphone/.test(lower) ? 'mobile'
                   : /ipad|tablet/.test(lower) ? 'tablet'
                   : 'desktop';
  return { os, browser, deviceType, raw: s };
}

// Stable per-device id from server-side signals. Keep IP out of this id:
// network changes are handled by LoginRiskService, but should not consume a
// second device slot for the same browser.
export function deriveDeviceId({ ua, ip, clientFp }) {
  const h = crypto.createHash('sha256');
  h.update(String(ua || ''));
  h.update('|');
  h.update(String(clientFp || '')); // browser-side fingerprint, may be empty
  return 'd_' + h.digest('hex').slice(0, 24);
}

// Cheap IP → country (offline). For a real deployment use MaxMind GeoLite2
// or Cloudflare's CF-IPCountry header behind the gateway.
const _ipCountryCache = new Map();
export function countryFromIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.')) {
    return 'LOCAL';
  }
  if (_ipCountryCache.has(ip)) return _ipCountryCache.get(ip);
  // Coarse heuristic: first octet / known ranges. Real impl: GeoLite2.
  let country = 'UNKNOWN';
  const first = parseInt(ip.split('.')[0] || '0', 10);
  // CN: 1, 14, 27, 36, 39, 58, 59, 60, 61, 101, 103, 106, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 175, 180, 182, 183, 202, 203, 210, 211, 218, 219, 220, 221, 222, 223
  // US: 3, 4, 6, 7, 8, 12, 13, 23, 24, 32, 35, 40, 44, 45, 47, 50, 52, 54, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 96, 97, 98, 99, 100, 104, 107, 108, 162, 165, 166, 167, 168, 169, 170, 173, 174, 184, 199, 204, 205, 206, 207, 208, 209, 216, 216
  if ([1,14,27,36,39,58,59,60,61,101,103,106,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,175,180,182,183,202,203,210,211,218,219,220,221,222,223].includes(first)) country = 'CN';
  else if ([3,4,6,7,8,12,13,23,24,32,35,40,44,45,47,50,52,54,63,64,65,66,67,68,69,70,71,72,73,74,75,76,96,97,98,99,100,104,107,108,162,165,166,167,168,169,170,173,174,184,199,204,205,206,207,208,209,216].includes(first)) country = 'US';
  else if (first >= 128 && first <= 191) country = 'OTHER';
  _ipCountryCache.set(ip, country);
  return country;
}

// Distance heuristic between two countries — purely an enum for risk score.
export function distanceBucket(a, b) {
  if (!a || !b || a === 'UNKNOWN' || b === 'UNKNOWN') return 'unknown';
  if (a === b) return 'same';
  if (a === 'CN' && b !== 'CN') return 'cross_border';
  return 'different_region';
}
