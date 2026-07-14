// e2e-smoke.mjs — manual integration smoke test
// Run: node e2e-smoke.mjs
import * as store from '../lib/store.js';

const BASE = process.env.BASE || 'http://localhost:3000';

async function http(method, path, { body, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  const r = await fetch(BASE + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = r.headers.get('set-cookie');
  let cookieOut = cookie || '';
  if (setCookie) {
    const kv = setCookie.split(';')[0];
    if (kv) cookieOut = cookieOut ? `${cookieOut}; ${kv}` : kv;
  }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, json, text, cookie: cookieOut };
}

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL —', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

(async () => {
  console.log('\n[1] Generate a fresh test code');
  const r1 = await store.add({ label: 'e2e-' + Date.now(), note: 'smoke test' });
  const code = r1.plaintext;
  console.log('  plaintext:', code.slice(0, 8) + '…' + code.slice(-6), '(' + code.length + ' chars)');

  console.log('\n[2] Login with bad code → 401');
  const bad = await http('POST', '/api/login', { body: { code: 'X'.repeat(50) } });
  assert(bad.status === 401, 'bad code returns 401');
  assert(bad.json && bad.json.ok === false, 'bad code returns ok:false');

  console.log('\n[3] Login with good code → 200 + cookie');
  const ok = await http('POST', '/api/login', { body: { code, client_fp: 'abc12345' } });
  assert(ok.status === 200, 'good code returns 200');
  assert(ok.json && ok.json.ok === true, 'good code returns ok:true');
  assert(ok.cookie.includes('pv_session='), 'cookie pv_session set');
  const cookie = ok.cookie;

  console.log('\n[4] /api/me with cookie → ok, devices listed');
  const me = await http('GET', '/api/me', { cookie });
  assert(me.json && me.json.ok === true, '/api/me returns ok');
  assert(Array.isArray(me.json.devices), '/api/me.devices is array');
  assert(me.json.devices.length >= 1, 'at least 1 device registered');

  console.log('\n[5] /api/prompts MUST NOT contain prompt_text');
  const list = await http('GET', '/api/prompts?limit=5', { cookie });
  assert(list.json && list.json.ok === true, '/api/prompts returns ok');
  const sample = list.json.items[0];
  assert(sample && sample.prompt_text === undefined, 'NO prompt_text in list (anti-leak ✓)');
  assert(typeof sample.prompt_text_length === 'number', 'prompt_text_length exposed (for UI hint)');

  console.log('\n[6] Chapter access → content_token');
  const id = sample.id;
  const access = await http('GET', `/api/prompts/${id}/access`, { cookie });
  assert(access.json && access.json.ok === true, '/api/prompts/:id/access returns ok');
  assert(typeof access.json.content_token === 'string', 'content_token issued');
  const token = access.json.content_token;

  console.log('\n[7] Chapter detail WITHOUT token → 401');
  const noTok = await http('GET', `/api/prompts/${id}`, { cookie });
  assert(noTok.status === 401, 'no token → 401');
  assert(noTok.json && noTok.json.error === 'content_token_required', 'error: content_token_required');

  console.log('\n[8] Chapter detail WITH token → ok + watermark');
  const detail = await http('GET', `/api/prompts/${id}?content_token=${encodeURIComponent(token)}`, { cookie });
  assert(detail.status === 200, 'detail returns 200');
  assert(typeof detail.json.prompt_text === 'string' && detail.json.prompt_text.length > 0, 'prompt_text body delivered');
  assert(detail.json.watermark && detail.json.watermark.user_id, 'watermark included');

  console.log('\n[9] Replay same token → 401 (single-use)');
  const replay = await http('GET', `/api/prompts/${id}?content_token=${encodeURIComponent(token)}`, { cookie });
  assert(replay.status === 401, 'replay returns 401');
  assert(replay.json && replay.json.reason === 'replay', 'reason=replay');

  console.log('\n[10] File download signed URL → 5-min TTL');
  const fileAccess = await http('GET', `/api/file/access?id=test.pdf`, { cookie });
  assert(fileAccess.json && fileAccess.json.ok === true, 'file access ok');
  assert(fileAccess.json.url.includes('signature='), 'URL contains signature');
  assert(fileAccess.json.url.includes('expires='), 'URL contains expires');

  console.log('\n[11] Video key endpoint requires token');
  const vidAccess = await http('GET', '/api/video/abc/access', { cookie });
  assert(vidAccess.json && vidAccess.json.ok === true, 'video access ok');
  assert(typeof vidAccess.json.content_token === 'string', 'video content_token issued');
  const noVidKey = await http('GET', '/api/video/abc/key', { cookie });
  assert(noVidKey.status === 401, 'video key without token → 401');

  console.log('\n[12] Admin security overview');
  const sec = await http('GET', '/api/admin/security/overview', { cookie });
  assert(sec.json && sec.json.ok === true, 'overview returns ok');
  assert(typeof sec.json.counts.total_requests === 'number', 'counts.total_requests');
  assert(typeof sec.json.counts.login_ok === 'number', 'login_ok counted');

  console.log('\n[13] Rate limit (60s window): burst 100 of prompt list → some 429');
  let n429 = 0;
  for (let i = 0; i < 100; i++) {
    const r = await http('GET', '/api/prompts?limit=1', { cookie });
    if (r.status === 429) n429++;
  }
  assert(n429 > 0, `burst 100 of /api/prompts produced ${n429} 429s`);

  console.log('\n[14] Bot UA → captcha path');
  const botR = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'HeadlessChrome/120.0.0.0' },
    body: JSON.stringify({ code, client_fp: 'deadbeef' }),
  });
  const bot = { status: botR.status, json: await botR.json().catch(() => null) };
  // Either high-risk block or captcha required
  assert([401, 403].includes(bot.status) || (bot.json && (bot.json.error === 'captcha_required' || bot.json.error === 'risk_blocked')),
    `bot UA handled: status=${bot.status} error=${bot.json && bot.json.error}`);

  console.log('\n[15] Logout');
  const out = await http('POST', '/api/logout', { cookie });
  assert(out.json && out.json.ok === true, 'logout ok');

  console.log('\nAll smoke tests complete.\n');
})().catch(e => { console.error(e); process.exit(1); });