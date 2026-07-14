// security-client.js — front-end anti-scrape / anti-leak / anti-bot helpers.
// Loaded as a plain <script> on protected pages.
//
// Exports window.PVS with: fingerprint, botSignals, watermark, captcha,
//   pullContent, signedDownloadUrl, signedVideoKeyUrl.
(function () {
  'use strict';

  // ---- 1. Browser fingerprint ----
  // Produces a stable string that, combined with the server-side UA+IP,
  // yields a per-device id. Survives cookie clears; helps re-binding the
  // same physical device after a user re-installs.
  function fingerprint() {
    const parts = [];
    try {
      parts.push(navigator.userAgent);
      parts.push(navigator.language || '');
      parts.push((navigator.languages || []).join(','));
      parts.push(String(navigator.hardwareConcurrency || ''));
      parts.push(String(navigator.deviceMemory || ''));
      parts.push(String(navigator.platform || ''));
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 100, 30);
      ctx.fillStyle = '#069';
      ctx.fillText('PV-fp', 2, 2);
      parts.push(c.toDataURL().slice(-64));
      parts.push(String(screen.width + 'x' + screen.height + 'x' + screen.colorDepth));
      parts.push(String(new Date().getTimezoneOffset()));
      // AudioContext fingerprint (some browsers normalize away; still useful signal)
      try {
        const AudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (AudioCtx) {
          const ac = new AudioCtx(1, 44100, 44100);
          const osc = ac.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = 10000;
          const comp = ac.createDynamicsCompressor();
          osc.connect(comp);
          comp.connect(ac.destination);
          osc.start(0);
          // We can't await here; consumers can call fingerprint() once more after a tick.
          parts.push('ac-ok');
        }
      } catch {}
    } catch (e) { parts.push('err:' + e.message); }
    // FNV-1a 32-bit hash → hex
    let h = 0x811c9dc5;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ---- 2. Bot / automation signals ----
  // Returns { score, signals[] }. score >= 2 ⇒ treat as suspicious and call
  // captcha.require() before issuing content.
  function botSignals() {
    const signals = [];
    let score = 0;
    if (navigator.webdriver) { signals.push('webdriver'); score += 3; }
    if (window.__nightmare) { signals.push('nightmare'); score += 3; }
    if (window.__puppeteer || window.__puppeteer_evaluation_script__) { signals.push('puppeteer'); score += 3; }
    if (window.callPhantom || window._phantom) { signals.push('phantom'); score += 3; }
    if (navigator.userAgent && /HeadlessChrome/i.test(navigator.userAgent)) { signals.push('headless_ua'); score += 3; }
    if (navigator.plugins && navigator.plugins.length === 0 && !window.chrome) {
      signals.push('no_plugins'); score += 1;
    }
    if (navigator.languages && navigator.languages.length === 0) {
      signals.push('no_languages'); score += 1;
    }
    // Permissions API used to detect headless reliably in Chrome <100
    try {
      const perms = navigator.permissions && navigator.permissions.query;
      if (perms) {
        // Skip — async, but the platform-level headless detection above is enough.
      }
    } catch {}
    // CDP / Playwright leak
    if (window.chrome && window.chrome.runtime && window.chrome.runtime.id === undefined
        && /HeadlessChrome/.test(navigator.userAgent || '')) {
      signals.push('cdp_headless'); score += 2;
    }
    return { score, signals };
  }

  // ---- 3. Dynamic watermark ----
  // Renders a translucent canvas overlay covering the viewport with the
  // user id + device id + timestamp in tiled text that drifts slightly.
  // Hard to scrub from screenshots because every frame re-randomises position.
  function watermark({ userLabel, deviceId, container }) {
    if (!container) container = document.body;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;opacity:.10;mix-blend-mode:multiply;';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    function draw() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.clientWidth || window.innerWidth;
      const H = canvas.clientHeight || window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '13px system-ui,-apple-system,sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const baseText = `${userLabel} · ${deviceId.slice(0, 12)} · ${ts}`;
      // Drift offsets so re-screenshots aren't identical
      const dx = (Math.random() - 0.5) * 30;
      const dy = (Math.random() - 0.5) * 30;
      const rot = (Math.random() - 0.5) * 0.06; // ±2deg
      for (let y = -40; y < H; y += 130) {
        for (let x = -120; x < W; x += 360) {
          ctx.save();
          ctx.translate(x + dx, y + dy);
          ctx.rotate(rot);
          ctx.fillText(baseText, 0, 0);
          ctx.restore();
        }
      }
    }
    draw();
    let tid = null;
    function loop() {
      draw();
      tid = setTimeout(loop, 2500); // 2.5s — slow enough to be cheap, fast enough to thwart screenshot collage
    }
    loop();
    // Pause when tab hidden (battery + perf)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { clearTimeout(tid); tid = null; }
      else if (!tid) loop();
    });
    // Re-draw on resize
    window.addEventListener('resize', draw);
    return { stop() { clearTimeout(tid); canvas.remove(); } };
  }

  // ---- 4. Captcha modal ----
  // Triggered by 401/captcha_required or by a botSignals() score >= 2.
  // Resolves with { ok, reason } when user closes it.
  const captcha = {
    _open: null,
    async require(reason = 'verify') {
      if (this._open) return this._open;
      this._open = new Promise(async (resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
        const card = document.createElement('div');
        card.style.cssText = 'background:#1a1a22;color:#f3f3f7;border:1px solid #2a2a35;border-radius:14px;padding:24px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.5);';
        card.innerHTML = `
          <h3 style="margin:0 0 8px 0;font-size:18px;">安全验证</h3>
          <p id="pvCaptchaReason" style="margin:0 0 16px 0;font-size:13px;color:#9a9aa8;">请输入图中的数学答案以继续</p>
          <img id="pvCaptchaImg" alt="captcha" style="display:block;margin:0 auto 12px auto;border-radius:8px;background:#fafafa;width:160px;height:60px;" />
          <input id="pvCaptchaInput" type="text" inputmode="numeric" placeholder="答案"
                 style="width:100%;padding:10px 12px;background:#0a0a0d;color:#f3f3f7;border:1px solid #2a2a35;border-radius:8px;font-size:14px;outline:none;" />
          <div id="pvCaptchaErr" style="margin-top:10px;font-size:12px;color:#f87171;min-height:16px;"></div>
          <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            <button id="pvCaptchaCancel" style="padding:8px 14px;background:transparent;border:1px solid #2a2a35;color:#9a9aa8;border-radius:8px;cursor:pointer;">取消</button>
            <button id="pvCaptchaOk" style="padding:8px 14px;background:#6366f1;border:0;color:#fff;border-radius:8px;cursor:pointer;font-weight:600;">验证</button>
          </div>`;
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        const errEl = card.querySelector('#pvCaptchaErr');
        const reasonEl = card.querySelector('#pvCaptchaReason');
        if (reason) reasonEl.textContent = reason;

        async function refresh() {
          const r = await fetch('/api/captcha/new', { credentials: 'same-origin' });
          const j = await r.json();
          if (!j.ok) { errEl.textContent = '获取验证失败'; return null; }
          card.querySelector('#pvCaptchaImg').src = j.image + '#' + Date.now();
          return j;
        }
        let last = await refresh();
        if (!last) { overlay.remove(); this._open = null; resolve({ ok: false, reason: 'init_failed' }); return; }

        card.querySelector('#pvCaptchaCancel').onclick = () => {
          overlay.remove(); this._open = null; resolve({ ok: false, reason: 'cancelled' });
        };
        card.querySelector('#pvCaptchaOk').onclick = async () => {
          const ans = card.querySelector('#pvCaptchaInput').value;
          const v = await fetch('/api/captcha/verify', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge_id: last.challenge_id, answer: ans }),
          }).then(r => r.json());
          if (v.ok) {
            overlay.remove(); this._open = null; resolve({ ok: true });
          } else {
            errEl.textContent = '答案错误，请重试';
            last = await refresh();
            card.querySelector('#pvCaptchaInput').value = '';
          }
        };
        card.querySelector('#pvCaptchaInput').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') card.querySelector('#pvCaptchaOk').click();
        });
      });
      return this._open;
    },
  };

  // ---- 5. Content-token-protected fetch helpers ----
  // 1) /api/prompts/:id/access → { content_token }
  // 2) /api/prompts/:id?content_token=… → body
  // We retry once through captcha if the server replies 401 captcha_required.
  // We also abort and surface a friendlier error if the server denies with
  //   device_mismatch / ip_mismatch / replay (means token was stolen or used twice).
  async function pullContent(id) {
    let tokenJson;
    try {
      const r = await fetch(`/api/prompts/${encodeURIComponent(id)}/access`, { credentials: 'same-origin' });
      if (r.status === 403) {
        const j = await r.json().catch(() => ({}));
        if (j.error === 'membership_required') throw new Error('membership_required');
        throw new Error(j.error || 'access_denied');
      }
      if (r.status === 401) {
        // Try captcha once
        await captcha.require('检测到风险，请完成验证');
        const r2 = await fetch(`/api/prompts/${encodeURIComponent(id)}/access`, { credentials: 'same-origin' });
        tokenJson = await r2.json();
        if (!tokenJson.ok) throw new Error(tokenJson.error || 'access_denied');
      } else {
        tokenJson = await r.json();
      }
    } catch (e) { throw e; }
    if (!tokenJson.ok) throw new Error(tokenJson.error || 'access_denied');

    const r = await fetch(`/api/prompts/${encodeURIComponent(id)}?content_token=${encodeURIComponent(tokenJson.content_token)}`, { credentials: 'same-origin' });
    if (r.status === 401) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`token_${j.reason || 'invalid'}`);
    }
    return r.json();
  }

  // Signed file download — fetch a one-shot signed URL then window.open it.
  async function signedDownloadUrl(id) {
    const r = await fetch(`/api/file/access?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('access_denied');
    const j = await r.json();
    return j.url;
  }

  // Signed video key URL — used by HLS players.
  async function signedVideoKeyUrl(id) {
    const r = await fetch(`/api/video/${encodeURIComponent(id)}/access`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('access_denied');
    const j = await r.json();
    return j; // { content_token, key_url }
  }

  // ---- 6. Prompt-at-load detection ----
  // Run once per page; if botSignals.score >= 2, require captcha up front.
  async function ensureHuman() {
    const s = botSignals();
    if (s.score >= 2) {
      await captcha.require('检测到自动化浏览器特征，请完成验证');
      return false; // bot confirmed
    }
    return true;
  }

  // ---- 7. Session / device helpers ----
  // loadMe() MUST NOT throw on a flaky network — callers (e.g. the security
  // bootstrap) treat any non-401 response as fatal and would otherwise leak
  // `TypeError: Failed to fetch` into the global error handler. We resolve to
  // `null` for both redirects (401) and unrecoverable failures, and log to
  // console so devs still see what happened.
  async function loadMe() {
    let r;
    try {
      r = await fetch('/api/me', { credentials: 'same-origin' });
    } catch (e) {
      console.warn('[PVS] loadMe: network error:', e && e.message ? e.message : e);
      return null;
    }
    if (r.status === 401) { location.href = '/login'; return null; }
    try {
      return await r.json();
    } catch (e) {
      console.warn('[PVS] loadMe: invalid JSON in /api/me response');
      return null;
    }
  }

  window.PVS = {
    fingerprint, botSignals, watermark, captcha,
    pullContent, signedDownloadUrl, signedVideoKeyUrl,
    ensureHuman, loadMe,
  };
})();