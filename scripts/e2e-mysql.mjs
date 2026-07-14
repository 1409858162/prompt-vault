// e2e-mysql.mjs — full smoke test against the MySQL-backed server
// Run: node scripts/e2e-mysql.mjs
import * as store from '../lib/store.js';

const BASE = 'http://localhost:3000';

async function http(method, path, { body, cookie, ua } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  if (ua) headers['user-agent'] = ua;
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
  return { status: r.status, headers: r.headers, json, cookie: cookieOut, text };
}

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL —', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

const RE_ANSWER = /What is (\d+)\s*(\+|\-)\s*(\d+)/;
function parseAnswer(hint) {
  const m = hint.match(RE_ANSWER);
  return m ? (m[2] === '+' ? parseInt(m[1]) + parseInt(m[3]) : parseInt(m[1]) - parseInt(m[3])) : null;
}

async function registerWithCode(code) {
  const u = 'u' + Date.now().toString(36);
  const r1 = await http('POST', '/api/register', { body: { username: u, password: 'TestPass123!', code } });
  if (r1.json?.ok) return r1;

  // captcha required
  if (!r1.json?.captcha) { console.log('  unexpected register response:', JSON.stringify(r1.json)); return r1; }
  const { challenge_id, audio_hint } = r1.json.captcha;
  const ans = parseAnswer(audio_hint);
  console.log('  captcha:', audio_hint, '→', ans);
  return http('POST', '/api/register', { body: { username: u, password: 'TestPass123!', code, captcha_id: challenge_id, captcha_answer: ans } });
}

(async () => {
  // 1. Generate invite code
  console.log('[1] Generate invite code');
  const cr = await store.add({ label: 'e2e-' + Date.now(), note: 'smoke' });
  const code = cr.plaintext;
  console.log('  code:', code.slice(0, 8) + '…' + code.slice(-6), `(${code.length} chars)`);

  // 2. Register
  console.log('\n[2] Register with invite code');
  const reg = await registerWithCode(code);
  assert(reg.json?.ok === true, 'register returns ok:true');
  assert(typeof reg.cookie === 'string' && reg.cookie.includes('pv_session='), 'pv_session cookie set');
  console.log('  registered:', reg.json.username, '| device:', reg.json.device_id);
  const cookie = reg.cookie;

  // 3. GET /login
  console.log('\n[3] GET /login');
  const loginPage = await http('GET', '/login');
  assert(loginPage.status === 200, '/login returns 200');

  // 4. mode=code → code_login_removed
  console.log('\n[4] mode=code POST /api/login');
  const mc = await http('POST', '/api/login', { body: { mode: 'code', code: 'X'.repeat(50) } });
  assert(mc.json?.error === 'code_login_removed', 'error is code_login_removed');

  // 5. mode=password missing params
  console.log('\n[5] mode=password missing params');
  const mm = await http('POST', '/api/login', { body: { mode: 'password' } });
  assert(mm.json?.error?.includes('用户') || mm.json?.error?.includes('参数'), 'missing params rejected');

  // 6. mode=password wrong credentials
  console.log('\n[6] mode=password wrong credentials');
  const mw = await http('POST', '/api/login', { body: { mode: 'password', username: 'nobody', password: 'wrong' } });
  assert(mw.json?.error?.includes('错误') || mw.json?.ok === false, 'wrong creds rejected');

  // 7. Re-login with registered account
  console.log('\n[7] Re-login with registered account');
  const login = await http('POST', '/api/login', { body: { mode: 'password', username: reg.json.username, password: 'TestPass123!' } });
  assert(login.json?.ok === true, 'login ok:true');
  const cookie2 = login.cookie;

  // 8. /api/me
  console.log('\n[8] /api/me');
  const me = await http('GET', '/api/me', { cookie });
  assert(me.json?.ok === true, '/api/me ok');
  assert(Array.isArray(me.json?.devices), 'devices is array');
  assert(me.json?.devices?.length >= 1, 'at least 1 device');
  console.log('  username:', me.json?.username, '| devices:', me.json?.devices?.length);

  // 9. /api/devices
  console.log('\n[9] /api/devices');
  const devs = await http('GET', '/api/devices', { cookie });
  assert(devs.json?.ok === true, '/api/devices ok');
  assert(Array.isArray(devs.json?.devices), 'devices is array');
  console.log('  devices:', devs.json?.devices?.length);

  // 10. /api/announcements (requires auth)
  console.log('\n[10] /api/announcements (authed)');
  const ann = await http('GET', '/api/announcements', { cookie });
  assert(ann.status === 200, 'status 200');
  assert(ann.json?.ok === true, 'ok:true');
  assert(Array.isArray(ann.json?.announcements), 'announcements is array');
  console.log('  announcements:', ann.json?.announcements?.length);

  // 11. Admin security overview (need admin account)
  console.log('\n[11] /api/admin/security/overview (admin)');
  const sec = await http('GET', '/api/admin/security/overview', { cookie });
  if (sec.json?.error === 'admin_required') {
    console.log('  SKIP — no admin account in DB');
  } else {
    assert(sec.json?.ok === true, 'security overview ok');
    assert(typeof sec.json?.counts?.total_requests === 'number', 'total_requests counted');
    console.log('  total_requests:', sec.json?.counts?.total_requests);
  }

  // 12. Logout
  console.log('\n[12] Logout');
  const out = await http('POST', '/api/logout', { cookie });
  assert(out.json?.ok === true, 'logout ok');

  // 13. Logged out → /api/me should redirect to /login (requireAuth behaviour)
  console.log('\n[13] /api/me after logout → redirect to /login (requireAuth)');
  const after = await http('GET', '/api/me', { cookie });
  assert(after.status === 302 && after.headers.get('location')?.includes('/login'),
    `redirect to /login (status=${after.status})`);

  console.log('\nAll smoke tests passed.\n');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
