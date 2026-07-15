// Captcha service. Issues a challenge on /api/captcha/new and verifies on /api/captcha/verify.
//
// MySQL-backed: every read/write goes through lib/db.js, which is async.
// Therefore issueCaptcha / verifyCaptcha are async too — server.js awaits both.

import crypto from 'node:crypto';
import * as db from './db.js';

const SECRET = process.env.CAPTCHA_SECRET || process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-captcha-secret-change-me');
if (!SECRET) {
  // Fail-open rather than throw: keeps the API alive while shouting loudly.
  globalThis.__pv_cap_secret = globalThis.__pv_cap_secret || crypto.randomBytes(48).toString('base64url');
  console.warn('[config] CAPTCHA_SECRET not set — using random in-process secret. Tokens will NOT survive a cold restart.');
}
const ACTIVE_SECRET = SECRET || globalThis.__pv_cap_secret;

const TTL_MS = 3 * 60 * 1000; // 3 minutes

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

// Issue: returns { challenge_id, question, expires_at }.
export async function issueCaptcha() {
  const a = 1 + crypto.randomInt(0, 9);
  const b = 1 + crypto.randomInt(0, 9);
  const op = ['+', '-', '×'][crypto.randomInt(0, 3)];
  let answer;
  if (op === '+') answer = a + b;
  else if (op === '-') answer = a - b;
  else answer = a * b;

  const id = 'c_' + crypto.randomBytes(10).toString('hex');
  const exp = Date.now() + TTL_MS;
  const sig = crypto.createHmac('sha256', ACTIVE_SECRET).update(`${id}:${answer}:${exp}`).digest('base64url');

  // The DB layer doesn't know about the optional `image` (SVG) or `sig` fields,
  // so we insert the well-known columns first and then PATCH the rest in.
  await db.insert('captcha_challenge', {
    id,
    answer_hash: crypto.createHash('sha256').update(String(answer)).digest('hex'),
    expires_at: new Date(exp).toISOString(),
    consumed: false,
    sig,
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60" viewBox="0 0 160 60">
    <defs><pattern id="n" width="6" height="6" patternUnits="userSpaceOnUse">
      <path d="M0 6L6 0" stroke="#ddd" stroke-width="0.6"/>
    </pattern></defs>
    <rect width="160" height="60" fill="#fafafa"/>
    <rect width="160" height="60" fill="url(#n)"/>
    <text x="80" y="40" text-anchor="middle" font-family="Georgia,serif" font-size="26" fill="#222"
          transform="rotate(${(Math.random()*8-4).toFixed(2)} 80 30)">${a} ${op} ${b} = ?</text>
  </svg>`;
  // Data URLs marked with `;base64,` must use standard base64 rather than
  // base64url, otherwise some browsers fail to decode the inline SVG.
  const svgB64 = Buffer.from(svg, 'utf8').toString('base64');

  // Stash the rendered SVG inside `image` so admin tooling / debugging can see it.
  await db.update('captcha_challenge', id, { image: `data:image/svg+xml;base64,${svgB64}` });

  return {
    challenge_id: id,
    expires_at: new Date(exp).toISOString(),
    image: `data:image/svg+xml;base64,${svgB64}`,
    audio_hint: `What is ${a} ${op === '×' ? 'times' : op} ${b} ?`,
  };
}

export async function verifyCaptcha({ challenge_id, answer }) {
  const row = await db.findById('captcha_challenge', challenge_id);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.consumed) return { ok: false, reason: 'used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  const ansHash = crypto.createHash('sha256').update(String(answer).trim()).digest('hex');
  if (ansHash !== row.answer_hash) return { ok: false, reason: 'wrong' };
  await db.update('captcha_challenge', challenge_id, { consumed: true, consumed_at: new Date().toISOString() });
  return { ok: true };
}
