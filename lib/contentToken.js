// Content protection primitives:
//   - One-time content access tokens (5 min, bound to user+device+ip)
//   - Signed download URLs (HMAC, expires)
//   - HLS video key issuance (AES key per session for video segments)
//
// These are the ONLY ways to read course/prompt bodies after the new
// /api/prompts endpoint stops returning prompt_text in bulk.

import crypto from 'node:crypto';
import * as db from './db.js';

const SECRET = process.env.CONTENT_TOKEN_SECRET || process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-content-token-secret-change-me');
if (!SECRET) {
  // Fail-open rather than throw: keeps the API alive while shouting loudly.
  globalThis.__pv_ct_secret = globalThis.__pv_ct_secret || crypto.randomBytes(48).toString('base64url');
  console.warn('[config] CONTENT_TOKEN_SECRET not set — using random in-process secret. Tokens will NOT survive a cold restart.');
}
const ACTIVE_SECRET = SECRET || globalThis.__pv_ct_secret;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function fromB64url(s) {
  return Buffer.from(s, 'base64url');
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', ACTIVE_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', ACTIVE_SECRET).update(body).digest('base64url');
  // timing-safe compare
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try { return JSON.parse(fromB64url(body).toString('utf8')); }
  catch { return null; }
}

// -------- One-time content token --------
export async function issueContentToken({ userId, deviceId, ip, resource, ttlMs = DEFAULT_TTL_MS }) {
  const jti = 't_' + crypto.randomBytes(12).toString('hex');
  const payload = {
    jti,
    sub: userId,
    dev: deviceId,
    ip,
    res: resource,        // e.g. "prompt:layered-depth" or "course:42:ch:3"
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  };
  const token = sign(payload);
  // Persist so we can enforce single-use + revocation. AWAIT so the row is
  // on disk before any consumer tries to consume it.
  await db.insert('content_token', {
    id: jti,
    user_id: userId,
    device_id: deviceId,
    ip,
    resource,
    token,
    expires_at: new Date(payload.exp).toISOString(),
    used: false,
  });
  return token;
}

// Verify + mark as used. Returns { ok, payload? , reason? }.
export async function consumeContentToken({ token, expectedResource, userId, deviceId, ip }) {
  const payload = verify(token);
  if (!payload) return { ok: false, reason: 'bad_signature' };
  if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };
  if (expectedResource && payload.res !== expectedResource) return { ok: false, reason: 'resource_mismatch' };
  if (payload.sub !== userId) return { ok: false, reason: 'user_mismatch' };
  if (payload.dev !== deviceId) return { ok: false, reason: 'device_mismatch' };
  if (payload.ip !== ip) return { ok: false, reason: 'ip_mismatch' };

  const record = await db.findById('content_token', payload.jti);
  if (!record) return { ok: false, reason: 'unknown_token' };
  if (record.used) return { ok: false, reason: 'replay' };
  await db.update('content_token', payload.jti, { used: true, used_at: new Date().toISOString() });
  return { ok: true, payload };
}

// -------- Signed download URLs (PDF / file proxy) --------
// Usage:
//   const url = signDownloadUrl({ id, userId, deviceId, ttlMs: 60_000, base: 'https://cdn...' })
//   -> base/<id>?expires=...&signature=...&u=...&d=...
export function signDownloadUrl({ id, userId, deviceId, ttlMs = 5 * 60 * 1000, base }) {
  const expires = Date.now() + ttlMs;
  const payload = { id, u: userId, d: deviceId, exp: expires };
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', ACTIVE_SECRET).update(body).digest('base64url');
  const qs = new URLSearchParams({ expires: String(expires), signature: mac, payload: body });
  return `${base}/${encodeURIComponent(id)}?${qs.toString()}`;
}

export function verifyDownloadSignature({ id, expires, signature, payload, userId, deviceId, ip }) {
  if (!expires || !signature || !payload) return { ok: false, reason: 'missing_params' };
  if (Number(expires) < Date.now()) return { ok: false, reason: 'expired' };
  const expected = crypto.createHmac('sha256', ACTIVE_SECRET).update(payload).digest('base64url');
  if (expected.length !== signature.length) return { ok: false, reason: 'bad_signature' };
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return { ok: false, reason: 'bad_signature' };
  let parsed;
  try { parsed = JSON.parse(fromB64url(payload).toString('utf8')); }
  catch { return { ok: false, reason: 'bad_payload' }; }
  if (parsed.id !== id) return { ok: false, reason: 'id_mismatch' };
  if (parsed.u !== userId) return { ok: false, reason: 'user_mismatch' };
  if (parsed.d !== deviceId) return { ok: false, reason: 'device_mismatch' };
  // We also record usage for behavior analysis (fire-and-forget; log trim
  // shouldn't block the download response).
  db.appendLog('user_behavior_log', {
    user_id: userId, device_id: deviceId, ip,
    api: 'file_download', resource: id,
  }).catch(err => console.error('[contentToken] behavior log failed:', err.message));
  return { ok: true, payload: parsed };
}

// -------- HLS video AES key issuance --------
// Real flow (in production):
//   1) Front-end fetches /api/video/<id>/key?content_token=...
//   2) Server verifies token, returns 16-byte AES key for that session
//   3) HLS .m3u8 references #EXT-X-KEY with that key URI
//   4) Player re-fetches key per session; token expires -> playback stops
//
// Here we issue a per-session key; the actual m3u8 rewriting would happen
// in a CDN edge worker in production. For local dev we just emit a stable
// key derived from SECRET + resource id + user id.
export function issueVideoKey({ userId, deviceId, resource }) {
  const seed = `${userId}|${deviceId}|${resource}`;
  const key = crypto.createHmac('sha256', ACTIVE_SECRET).update(seed).digest(); // 32 bytes
  // HLS AES-128 wants 16 bytes; truncate. (AES-128 is sufficient for this use.)
  return key.subarray(0, 16);
}

export function issueVideoKeyToken({ userId, deviceId, resource }) {
  return issueContentToken({
    userId, deviceId, ip: '*', resource: `video_key:${resource}`, ttlMs: 60 * 60 * 1000,
  });
}

export function verifyVideoKeyToken({ token, resource, userId, deviceId, ip }) {
  return consumeContentToken({
    token,
    expectedResource: `video_key:${resource}`,
    userId, deviceId, ip,
  });
}
