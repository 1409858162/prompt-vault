#!/usr/bin/env node
// Build the self-contained HTML viewer next to merged-prompts.json.
// Reads from merged-prompts.json (which combines local prompts-full.json
// with live cover URLs fetched from motionsites.ai's Supabase).
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const mergedPath = path.join(dir, 'merged-prompts.json');
const data = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
const jsonText = fs.readFileSync(mergedPath, 'utf8');
const total = data.length;
const withVid = data.filter((x) => x.preview_video_url).length;
const withImg = data.filter((x) => x.preview_image_url).length;
const withPlayable = data.filter((x) => x.playable_video_url).length;
const withAny = data.filter((x) => x.preview_image_url || x.preview_video_url).length;
const free = data.filter((x) => x.is_free).length;
const withPrompt = data.filter((x) => x.prompt_text && !x.prompt_text.startsWith('(Prompt text not')).length;

// Prevent premature </script> termination: escape any </ inside JSON string values.
  // (When the JSON is embedded inside a <script> block, a literal "</script>" anywhere
  //  would close our outer tag. Several prompts legitimately contain "<script>" tags.)
  const safeJsonText = jsonText.replace(/<\//g, '<\\/');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MotionSites Prompts Browser — ${total} prompts</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #0a0a0b;
    --panel: #131316;
    --panel-2: #1a1a1f;
    --border: #2a2a31;
    --border-soft: #1f1f25;
    --text: #e7e7ea;
    --text-dim: #9aa0a6;
    --text-faint: #6b6f76;
    --accent: #ffffff;
    --free: #22c55e;
    --pro: #f59e0b;
    --link: #7dd3fc;
    --code-bg: #0e0e12;
    --shadow: 0 10px 30px rgba(0,0,0,.35);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ---------- Top bar ---------- */
  header.topbar {
    position: sticky; top: 0; z-index: 50;
    background: rgba(10,10,11,.85);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--border);
    padding: 14px 22px;
  }
  .topbar-inner {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    max-width: 1500px; margin: 0 auto;
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    font-weight: 800; letter-spacing: -0.02em; font-size: 18px;
  }
  .brand .dot { width: 10px; height: 10px; border-radius: 999px; background: linear-gradient(135deg, #fff, #888); box-shadow: 0 0 14px rgba(255,255,255,.4); }
  .brand small { color: var(--text-dim); font-weight: 500; font-size: 12px; margin-left: 6px; }
  .stat-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill { font-size: 11px; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel); color: var(--text-dim); font-weight: 500; letter-spacing: .01em; }
  .pill b { color: var(--text); }

  .controls { display: flex; gap: 10px; align-items: center; flex: 1; justify-content: flex-end; flex-wrap: wrap; min-width: 280px; }
  .search { flex: 1; max-width: 360px; min-width: 180px; position: relative; }
  .search input {
    width: 100%; padding: 9px 12px 9px 34px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    color: var(--text); font: inherit; font-size: 13px;
    outline: none; transition: border-color .15s, background .15s;
  }
  .search input:focus { border-color: #5b5b66; background: var(--panel-2); }
  .search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--text-faint); pointer-events: none; }
  select {
    padding: 9px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    color: var(--text); font: inherit; font-size: 13px; outline: none; cursor: pointer;
  }
  select:focus { border-color: #5b5b66; }
  .sort-toggle {
    display: inline-flex; border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
  }
  .sort-toggle button {
    background: var(--panel); color: var(--text-dim); border: none; padding: 8px 12px; cursor: pointer; font: inherit; font-size: 12px;
  }
  .sort-toggle button.active { background: var(--panel-2); color: var(--text); }
  .sort-toggle button + button { border-left: 1px solid var(--border); }

  /* ---------- Grid ---------- */
  main { max-width: 1500px; margin: 0 auto; padding: 18px 22px 80px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
  }
  .row-span-2 { grid-row: span 2; }

  .card {
    background: var(--panel);
    border: 1px solid var(--border-soft);
    border-radius: 14px;
    overflow: hidden;
    cursor: pointer;
    transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
    display: flex; flex-direction: column;
    min-height: 240px;
  }
  .card:hover { transform: translateY(-2px); border-color: #3a3a44; box-shadow: var(--shadow); }
  .card .preview {
    position: relative; aspect-ratio: 16 / 10; background: #0f0f12; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-faint);
  }
  .card .preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .card .preview video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .card .preview .ph {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    position: relative;
    overflow: hidden;
  }
  .card .preview .ph-content {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    text-align: center;
  }
  .card .preview .ph-emoji { font-size: 36px; line-height: 1; filter: drop-shadow(0 2px 4px rgba(0,0,0,.4)); }
  .card .preview .ph-text {
    font-size: 14px; font-weight: 700; letter-spacing: 0.02em;
    color: rgba(255,255,255,.85);
    text-shadow: 0 1px 2px rgba(0,0,0,.5);
  }
  .card .preview .badges {
    position: absolute; top: 8px; left: 8px; right: 8px;
    display: flex; justify-content: space-between; gap: 6px; pointer-events: none;
  }
  .card .preview .badges-left { display: flex; gap: 4px; flex-wrap: wrap; max-width: 80%; }
  .badge { font-size: 10px; padding: 3px 7px; border-radius: 999px; font-weight: 600; letter-spacing: .02em;
    background: rgba(0,0,0,.55); color: #fff; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    border: 1px solid rgba(255,255,255,.08);
  }
  .badge.free { color: #bbf7d0; border-color: rgba(34,197,94,.4); background: rgba(20,40,25,.7); }
  .badge.pro { color: #fde68a; border-color: rgba(245,158,11,.4); background: rgba(40,30,10,.7); }
  .badge.cat { color: #e5e7eb; }
  .badge.meta { color: #93c5fd; border-color: rgba(147,197,253,.35); background: rgba(15,30,55,.7); }

  .card .body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .card h3 {
    margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .card .meta { display: flex; gap: 8px; flex-wrap: wrap; color: var(--text-faint); font-size: 11px; }
  .card .meta .dotsep { color: var(--text-faint); }
  .card .snippet {
    color: var(--text-dim); font-size: 12px; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .card .footer { margin-top: auto; padding-top: 10px; border-top: 1px dashed var(--border-soft); display: flex; gap: 8px; justify-content: space-between; align-items: center; color: var(--text-faint); font-size: 11px; }
  .card .footer .id { font-family: 'JetBrains Mono', ui-monospace, monospace; color: var(--text-faint); }
  .card .footer .arrow { color: var(--text); }

  .row-span-2 { min-height: 480px; }
  .row-span-2 .preview { aspect-ratio: 4 / 5; }
  .row-span-2 .snippet { -webkit-line-clamp: 5; }

  .empty { text-align: center; padding: 60px 20px; color: var(--text-faint); }
  .empty h2 { color: var(--text); margin: 0 0 6px; font-weight: 700; }

  /* ---------- Modal ---------- */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.7); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    z-index: 100; display: none; align-items: flex-start; justify-content: center; padding: 40px 20px;
    overflow-y: auto;
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 18px;
    width: min(1000px, 100%);
    max-height: calc(100vh - 80px);
    overflow: hidden;
    display: flex; flex-direction: column;
    box-shadow: 0 30px 80px rgba(0,0,0,.6);
  }
  .modal header {
    padding: 18px 22px; border-bottom: 1px solid var(--border);
    display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap;
  }
  .modal header .grow { flex: 1; min-width: 0; }
  .modal header h2 { margin: 0 0 6px; font-size: 22px; font-weight: 800; letter-spacing: -0.02em; }
  .modal header .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .modal header .row .pill { font-size: 11px; }
  .modal header .close {
    background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 13px;
  }
  .modal header .close:hover { background: #25252c; }
  .modal .preview-big { background: #0a0a0d; aspect-ratio: 16 / 9; max-height: 360px; }
  .modal .preview-big video, .modal .preview-big img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .modal .preview-big .ph { width: 100%; height: 100%; }
  .modal .preview-big .ph {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,.85);
  }
  .modal .preview-big .ph-content { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .modal .preview-big .ph-emoji { font-size: 72px; line-height: 1; filter: drop-shadow(0 4px 12px rgba(0,0,0,.5)); }
  .modal .preview-big .ph-text {
    font-size: 36px; font-weight: 800; letter-spacing: -0.02em;
    color: rgba(255,255,255,.9);
  }

  .modal .content { padding: 18px 22px 24px; overflow-y: auto; }
  .modal .prompt {
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px; line-height: 1.6;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px;
    white-space: pre-wrap; word-wrap: break-word;
    color: #d4d4d8;
    max-height: 60vh;
    overflow-y: auto;
  }
  .modal .actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
  .modal .actions button {
    background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 8px 14px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 500;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .modal .actions button:hover { background: #25252c; }
  .modal .actions button.primary { background: var(--text); color: #000; border-color: var(--text); }
  .modal .actions button.primary:hover { background: #ddd; }

  .preview-link { font-size: 11px; color: var(--text-faint); margin-top: 6px; word-break: break-all; }
  .preview-link a { color: var(--text-dim); }

  .toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(20px);
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    padding: 10px 16px; border-radius: 10px; font-size: 13px; z-index: 200;
    opacity: 0; transition: opacity .2s, transform .2s; pointer-events: none;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2a2a31; border-radius: 5px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: #3a3a44; }

  @media (max-width: 600px) {
    header.topbar { padding: 12px 14px; }
    main { padding: 14px; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
    .card .preview { aspect-ratio: 4 / 3; }
    .row-span-2 { grid-row: span 1; min-height: 240px; }
    .row-span-2 .preview { aspect-ratio: 4 / 3; }
    .modal-backdrop { padding: 0; }
    .modal { border-radius: 0; max-height: 100vh; height: 100vh; }
    .modal header h2 { font-size: 18px; }
  }
</style>
</head>
<body>

<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <span class="dot"></span>
      <span>MotionSites Prompts</span>
      <small>browse all prompts</small>
    </div>
    <div class="stat-pills">
      <span class="pill"><b>${total}</b> total</span>
      <span class="pill"><b>${withAny}</b> with cover</span>
      <span class="pill"><b>${withPlayable}</b> with playable video</span>
      <span class="pill"><b>${free}</b> free</span>
      <span class="pill"><b>${withPrompt}</b> with prompt text</span>
    </div>
    <div class="controls">
      <div class="search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="searchInput" type="search" placeholder="Search title or prompt text…" autocomplete="off" />
      </div>
      <select id="categorySelect" aria-label="Filter by category">
        <option value="">All categories</option>
      </select>
      <select id="freeSelect" aria-label="Filter by free/pro">
        <option value="">All</option>
        <option value="free">Free only</option>
        <option value="pro">Pro only</option>
      </select>
      <div class="sort-toggle" role="group" aria-label="Sort order">
        <button id="sortSite" class="active" title="Site display order (low sort_order first)">Site order</button>
        <button id="sortAlpha" title="Alphabetical by title">A–Z</button>
      </div>
    </div>
  </div>
</header>

<main>
  <div id="grid" class="grid"></div>
  <div id="empty" class="empty" style="display:none">
    <h2>No prompts match.</h2>
    <p>Try a different search term or clear the filters.</p>
  </div>
</main>

<div id="modal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
  <div class="modal">
    <header>
      <div class="grow">
        <h2 id="modalTitle"></h2>
        <div class="row" id="modalMeta"></div>
      </div>
      <button class="close" id="modalClose" aria-label="Close">Close ✕</button>
    </header>
    <div id="modalPreview"></div>
    <div class="content">
      <div class="prompt" id="modalPrompt"></div>
      <div class="actions">
        <button id="copyBtn" class="primary">Copy prompt</button>
        <button id="copyJsonBtn">Copy JSON entry</button>
        <a id="openRawBtn" target="_blank" rel="noopener" style="display:none">Open raw JSON ↗</a>
      </div>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
  // Embedded JSON (loaded from prompts-full.json at build time).
  // Note: any "</" inside string values has been escaped to "<\\/" so that literal
  // "<script>" tags inside prompts (e.g. Aetheris Voyage, Learnly, ...) don't
  // prematurely close this <script> block. The JSON parser tolerates "<\\/".
  const DATA = ${safeJsonText};

  // ---- State ----
  const state = {
    search: '',
    category: '',
    free: '',
    sort: 'site', // 'site' | 'alpha'
  };

  // ---- Build category options ----
  const categories = Array.from(new Set(DATA.map(x => x.category).filter(Boolean))).sort();
  const catSel = document.getElementById('categorySelect');
  for (const c of categories) {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    catSel.appendChild(o);
  }

  // ---- Hooks ----
  document.getElementById('searchInput').addEventListener('input', e => { state.search = e.target.value.trim().toLowerCase(); render(); });
  catSel.addEventListener('change', e => { state.category = e.target.value; render(); });
  document.getElementById('freeSelect').addEventListener('change', e => { state.free = e.target.value; render(); });
  document.getElementById('sortSite').addEventListener('click', () => setSort('site'));
  document.getElementById('sortAlpha').addEventListener('click', () => setSort('alpha'));
  function setSort(s) {
    state.sort = s;
    document.getElementById('sortSite').classList.toggle('active', s === 'site');
    document.getElementById('sortAlpha').classList.toggle('active', s === 'alpha');
    render();
  }

  // ---- Filtering / sorting ----
  function getRows() {
    let rows = DATA;
    if (state.category) rows = rows.filter(x => x.category === state.category);
    if (state.free === 'free') rows = rows.filter(x => x.is_free);
    if (state.free === 'pro') rows = rows.filter(x => !x.is_free);
    if (state.search) {
      const q = state.search;
      rows = rows.filter(x =>
        (x.title || '').toLowerCase().includes(q) ||
        (x.prompt_text || '').toLowerCase().includes(q) ||
        (x.category || '').toLowerCase().includes(q) ||
        (x.id || '').toLowerCase().includes(q)
      );
    }
    if (state.sort === 'site') {
      rows = rows.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    } else {
      rows = rows.slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }
    return rows;
  }

  // ---- Rendering ----
  const grid = document.getElementById('grid');
  const emptyEl = document.getElementById('empty');

  function snippet(text, max = 220) {
    const t = (text || '').replace(/\\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
  }

  function previewHtml(item) {
    // 1) Best: a real static cover image (R2 .webp or Cloudinary png) — loads instantly, looks crisp.
    if (item.preview_image_url) {
      return \`<img src="\${item.preview_image_url}" alt="\${escapeHtml(item.title)}" loading="lazy" decoding="async" />\`;
    }
    // 2) A playable video (e.g. Mux HLS) — autoplay on hover.
    if (item.preview_video_url) {
      return \`<video src="\${item.preview_video_url}" muted loop playsinline preload="metadata" onmouseenter="this.play().catch(()=>{})" onmouseleave="this.pause();this.currentTime=0;"></video>\`;
    }
    // 3) Fallback: deterministic colored gradient + category emoji + title initials.
    const hue = hashHue(item.title || '');
    const emoji = categoryEmoji(item.category);
    const initials = (item.title || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
    return \`<div class="ph" style="background:
      radial-gradient(circle at 22% 28%, hsla(\${hue},85%,70%,.35), transparent 45%),
      radial-gradient(circle at 78% 72%, hsla(\${(hue+55)%360},80%,65%,.30), transparent 50%),
      linear-gradient(135deg, hsl(\${hue},30%,18%), hsl(\${(hue+30)%360},35%,10%));">
      <div class="ph-content">
        <div class="ph-emoji">\${emoji}</div>
        <div class="ph-text">\${escapeHtml(initials)}</div>
      </div>
    </div>\`;
  }

  // Simple, stable string hash → hue (0..359). Same title → same color, always.
  function hashHue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  // Map category → a single representative emoji, used on placeholders.
  function categoryEmoji(cat) {
    const c = (cat || '').toLowerCase();
    const map = {
      'hero': '⚡', 'hero section': '⚡',
      'landing page': '🚀', 'landing page': '🚀', 'landing page': '🚀',
      'saas': '💻', 'ai / saas': '🤖',
      'agency': '🎨',
      'portfolio': '🖼️',
      'footer': '📦', 'footer section': '📦',
      'cta': '👉', 'cta section': '👉',
      'features': '✨', 'features section': '✨',
      'pricing': '💰',
      'dashboard': '📊',
      'ecommerce': '🛒',
      'web3': '⛓️',
      'fintech': '🏦',
      'travel': '✈️',
      'automotive': '🏎️',
      'social media': '📱',
      'email marketing': '✉️',
      'blog': '📝',
      'waitlist': '⏳',
      'signup': '📝',
      '404': '🚫',
      '3d website': '🎲',
      'interactive': '🕹️',
      'presentation': '🎤', 'investor presentations': '🎤',
      'component': '🧩',
      'website': '🌐',
      'ai': '🤖',
      'animation': '🎬',
    };
    return map[c] || '✨';
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function cardHtml(item) {
    const cls = item.row_span === 2 ? 'card row-span-2' : 'card';
    const hasRealPrompt = item.prompt_text && !item.prompt_text.startsWith('(Prompt text not');
    const metaBadge = hasRealPrompt ? '' : '<span class="badge meta" title="Prompt text not in local JSON; metadata only from site">meta only</span>';
    const badges = \`
      <div class="badges">
        <div class="badges-left">
          <span class="badge cat">\${escapeHtml(item.category || '')}</span>
          \${metaBadge}
        </div>
        <span class="badge \${item.is_free ? 'free' : 'pro'}">\${item.is_free ? 'FREE' : 'PRO'}</span>
      </div>\`;
    return \`
      <article class="\${cls}" data-id="\${escapeHtml(item.id)}" tabindex="0">
        <div class="preview">
          \${badges}
          \${previewHtml(item)}
        </div>
        <div class="body">
          <h3 class="text-foreground font-bold text-lg truncate">\${escapeHtml(item.title)}</h3>
          <div class="snippet">\${escapeHtml(snippet(item.prompt_text))}</div>
          <div class="footer">
            <span class="id">#\${escapeHtml(item.id)} · order \${item.sort_order}</span>
            <span class="arrow">View →</span>
          </div>
        </div>
      </article>\`;
  }

  function render() {
    const rows = getRows();
    if (!rows.length) {
      grid.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    grid.innerHTML = rows.map(cardHtml).join('');
    for (const el of grid.querySelectorAll('.card')) {
      el.addEventListener('click', () => openModal(el.dataset.id));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(el.dataset.id); }
      });
    }
  }

  // ---- Modal ----
  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modalTitle');
  const modalMeta = document.getElementById('modalMeta');
  const modalPreview = document.getElementById('modalPreview');
  const modalPrompt = document.getElementById('modalPrompt');
  const modalClose = document.getElementById('modalClose');
  let currentItem = null;

  function openModal(id) {
    const item = DATA.find(x => x.id === id);
    if (!item) return;
    currentItem = item;
    modalTitle.textContent = item.title;
    modalMeta.innerHTML = '';
    const pills = [
      ['Category', item.category],
      ['Type', item.type],
      ['Page', item.page_type],
      ['Order', String(item.sort_order)],
      ['Free', item.is_free ? 'Yes' : 'No'],
      ['ID', item.id],
    ];
    for (const [k, v] of pills) {
      if (!v && v !== 0) continue;
      const p = document.createElement('span');
      p.className = 'pill';
      p.innerHTML = \`\${escapeHtml(k)}: <b>\${escapeHtml(String(v))}</b>\`;
      modalMeta.appendChild(p);
    }
    // Three-tier preview: static cover image → playable Mux video → placeholder
    const playUrl = item.playable_video_url || item.preview_video_url;
    if (item.preview_image_url) {
      modalPreview.innerHTML = \`<div class="preview-big"><img src="\${item.preview_image_url}" alt="\${escapeHtml(item.title)}" style="width:100%;height:100%;object-fit:cover;display:block;"/></div>\`;
    } else if (playUrl) {
      modalPreview.innerHTML = \`<div class="preview-big"><video src="\${playUrl}" controls muted playsinline></video></div>\`;
    } else {
      const initials = (item.title || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '?';
      const emoji = categoryEmoji(item.category);
      const hue = hashHue(item.title || '');
      modalPreview.innerHTML = \`<div class="preview-big"><div class="ph" style="background:
        radial-gradient(circle at 22% 28%, hsla(\${hue},85%,70%,.35), transparent 45%),
        radial-gradient(circle at 78% 72%, hsla(\${(hue+55)%360},80%,65%,.30), transparent 50%),
        linear-gradient(135deg, hsl(\${hue},30%,18%), hsl(\${(hue+30)%360},35%,10%));">
        <div class="ph-content">
          <div class="ph-emoji">\${emoji}</div>
          <div class="ph-text">\${escapeHtml(initials)}</div>
        </div>
      </div></div>\`;
    }
    // Mark cards that came from the live site but lack prompt text
    const hasRealPrompt = item.prompt_text && !item.prompt_text.startsWith('(Prompt text not');
    modalPrompt.textContent = item.prompt_text || '';
    modalPrompt.style.opacity = hasRealPrompt ? '1' : '0.55';
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    modalClose.focus();
  }

  function closeModal() {
    modal.classList.remove('open');
    document.body.style.overflow = '';
    // Stop any playing video
    const v = modalPreview.querySelector('video');
    if (v) { try { v.pause(); v.currentTime = 0; } catch(e){} }
    currentItem = null;
  }

  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(); });

  // ---- Copy actions ----
  const toastEl = document.getElementById('toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
  }
  document.getElementById('copyBtn').addEventListener('click', async () => {
    if (!currentItem) return;
    try { await navigator.clipboard.writeText(currentItem.prompt_text || ''); toast('Prompt copied'); }
    catch { toast('Copy failed — select & copy manually'); }
  });
  document.getElementById('copyJsonBtn').addEventListener('click', async () => {
    if (!currentItem) return;
    const text = JSON.stringify(currentItem, null, 2);
    try { await navigator.clipboard.writeText(text); toast('JSON entry copied'); }
    catch { toast('Copy failed'); }
  });

  // ---- Initial render ----
  render();
</script>
</body>
</html>
`;

const outPath = path.join(dir, 'prompts-viewer.html');
fs.writeFileSync(outPath, html);
const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
console.log('Wrote', outPath, '(' + sizeMB + ' MB,', total, 'prompts embedded)');