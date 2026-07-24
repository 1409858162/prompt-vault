import fs from 'node:fs';
import path from 'node:path';
import { query, closePool } from '../lib/mysql.js';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'imported-libraries', 'superdesign');
const PUBLIC_PREFIX = '/assets/imported-libraries/superdesign';
fs.mkdirSync(OUT_DIR, { recursive: true });

const THEMES = [
  { a: '#38bdf8', b: '#8b5cf6', c: '#ec4899', icon: 'grid', label: 'DESIGN SYSTEM' },
  { a: '#22c55e', b: '#14b8a6', c: '#6366f1', icon: 'flow', label: 'WORKFLOW' },
  { a: '#f59e0b', b: '#ef4444', c: '#8b5cf6', icon: 'hero', label: 'LANDING' },
  { a: '#94a3b8', b: '#0ea5e9', c: '#111827', icon: 'toggle', label: 'THEME ENGINE' },
  { a: '#a855f7', b: '#06b6d4', c: '#f97316', icon: 'canvas', label: 'CANVAS' },
];

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripPrefix(title) {
  return String(title || '').replace(/^Superdesign\s*·\s*/i, '').trim();
}

function lines(text, max = 24, limit = 3) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > max && cur) {
      out.push(cur);
      cur = w;
      if (out.length >= limit) break;
    } else {
      cur = next;
    }
  }
  if (cur && out.length < limit) out.push(cur);
  return out.length ? out : ['Design Inspiration'];
}

function iconSvg(kind, theme) {
  if (kind === 'grid') return `
    <g transform="translate(285 366)" filter="url(#glow)">
      ${[0,1,2].map(y => [0,1,2].map(x => `<rect x="${x*112}" y="${y*112}" width="82" height="82" rx="22" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.42)"/>`).join('')).join('')}
    </g>`;
  if (kind === 'flow') return `
    <g transform="translate(230 365)" filter="url(#glow)" stroke-linecap="round" stroke-linejoin="round">
      <path d="M130 80 C230 30 310 160 420 104" fill="none" stroke="${theme.a}" stroke-width="18" opacity=".9"/>
      <path d="M130 250 C240 340 315 190 430 280" fill="none" stroke="${theme.c}" stroke-width="18" opacity=".8"/>
      <rect x="0" y="24" width="150" height="116" rx="34" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.45)"/>
      <rect x="360" y="48" width="150" height="116" rx="34" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.45)"/>
      <rect x="170" y="216" width="170" height="124" rx="36" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.45)"/>
    </g>`;
  if (kind === 'hero') return `
    <g transform="translate(164 332)" filter="url(#glow)">
      <rect x="0" y="0" width="572" height="358" rx="54" fill="rgba(255,255,255,.13)" stroke="rgba(255,255,255,.45)"/>
      <rect x="64" y="82" width="250" height="26" rx="13" fill="white" opacity=".82"/>
      <rect x="64" y="132" width="386" height="20" rx="10" fill="white" opacity=".46"/>
      <rect x="64" y="184" width="132" height="52" rx="26" fill="${theme.a}" opacity=".9"/>
      <circle cx="438" cy="182" r="86" fill="${theme.c}" opacity=".55"/>
      <circle cx="488" cy="146" r="44" fill="${theme.b}" opacity=".65"/>
    </g>`;
  if (kind === 'toggle') return `
    <g transform="translate(214 372)" filter="url(#glow)">
      <rect x="0" y="0" width="472" height="284" rx="80" fill="rgba(255,255,255,.10)" stroke="rgba(255,255,255,.38)"/>
      <circle cx="150" cy="142" r="92" fill="#f8fafc" opacity=".95"/>
      <circle cx="318" cy="142" r="92" fill="#020617" stroke="rgba(255,255,255,.38)" stroke-width="3"/>
      <path d="M318 78 A64 64 0 1 0 382 142 A42 42 0 1 1 318 78" fill="${theme.a}" opacity=".88"/>
    </g>`;
  return `
    <g transform="translate(198 330)" filter="url(#glow)" stroke-linecap="round">
      <rect x="0" y="0" width="504" height="388" rx="56" fill="rgba(255,255,255,.11)" stroke="rgba(255,255,255,.42)"/>
      <path d="M70 92 C150 38 210 156 296 98 S432 42 456 130" fill="none" stroke="${theme.a}" stroke-width="18"/>
      <path d="M84 276 C184 210 228 330 340 268 S438 222 458 302" fill="none" stroke="${theme.c}" stroke-width="18" opacity=".88"/>
      <circle cx="168" cy="198" r="52" fill="${theme.b}" opacity=".72"/>
      <circle cx="330" cy="198" r="72" fill="${theme.a}" opacity=".38"/>
    </g>`;
}

function coverSvg(row, idx) {
  const theme = THEMES[idx % THEMES.length];
  const title = stripPrefix(row.title);
  const titleLines = lines(title, 27, 3);
  const subtitle = String(row.original_category || row.page_type || 'Design Inspiration').trim();
  const titleText = titleLines.map((line, i) => `<text x="86" y="${818 + i * 48}" fill="#f8fafc" font-family="Arial, 'PingFang SC', sans-serif" font-size="38" font-weight="800">${esc(line)}</text>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1125" viewBox="0 0 900 1125">
  <defs>
    <radialGradient id="bg" cx="22%" cy="12%" r="92%">
      <stop offset="0" stop-color="${theme.a}" stop-opacity=".95"/>
      <stop offset=".46" stop-color="${theme.b}" stop-opacity=".50"/>
      <stop offset="1" stop-color="#050712"/>
    </radialGradient>
    <linearGradient id="stroke" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="${theme.a}"/><stop offset=".52" stop-color="${theme.b}"/><stop offset="1" stop-color="${theme.c}"/>
    </linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="42"/></filter>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="900" height="1125" fill="url(#bg)"/>
  <circle cx="160" cy="140" r="170" fill="${theme.c}" opacity=".34" filter="url(#blur)"/>
  <circle cx="742" cy="332" r="210" fill="${theme.a}" opacity=".22" filter="url(#blur)"/>
  <circle cx="426" cy="606" r="230" fill="${theme.b}" opacity=".18" filter="url(#blur)"/>
  <g opacity=".18" stroke="#fff" stroke-width="1">
    ${Array.from({length: 11}, (_, i) => `<path d="M${90+i*72} 0 V1125"/>`).join('')}
    ${Array.from({length: 14}, (_, i) => `<path d="M0 ${80+i*74} H900"/>`).join('')}
  </g>
  <rect x="46" y="46" width="808" height="1033" rx="66" fill="rgba(3,7,18,.30)" stroke="url(#stroke)" stroke-width="3"/>
  <g transform="translate(78 84)">
    <rect width="256" height="52" rx="26" fill="rgba(2,6,23,.58)" stroke="rgba(255,255,255,.18)"/>
    <text x="30" y="35" fill="#e2e8f0" font-family="Arial, 'PingFang SC', sans-serif" font-size="20" font-weight="800">产品设计灵感</text>
  </g>
  <g transform="translate(600 84)">
    <rect width="222" height="52" rx="26" fill="rgba(2,6,23,.58)" stroke="rgba(255,255,255,.18)"/>
    <text x="111" y="34" text-anchor="middle" fill="#cbd5e1" font-family="Arial, monospace" font-size="20" font-weight="800">${esc(theme.label)}</text>
  </g>
  ${iconSvg(theme.icon, theme)}
  <rect x="70" y="760" width="760" height="278" rx="44" fill="rgba(2,6,23,.62)" stroke="rgba(255,255,255,.14)"/>
  ${titleText}
  <text x="86" y="992" fill="#c4b5fd" font-family="Arial, 'PingFang SC', sans-serif" font-size="22" font-weight="700">${esc(subtitle)}</text>
</svg>`;
}

async function main() {
  const rows = await query(
    `SELECT id, title, original_category, page_type, raw
       FROM prompt_cards
      WHERE source = 'extractions_superdesign'
      ORDER BY sort_order ASC, id ASC`,
  );
  let done = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const filename = `${row.id}-cover.svg`;
    const publicUrl = `${PUBLIC_PREFIX}/${filename}`;
    fs.writeFileSync(path.join(OUT_DIR, filename), coverSvg(row, i), 'utf8');
    let raw = {};
    try { raw = typeof row.raw === 'string' ? JSON.parse(row.raw) : (row.raw || {}); } catch {}
    raw.local_asset_image_previous = raw.local_asset_image || null;
    raw.local_asset_image = publicUrl;
    raw.local_asset_generated_cover = true;
    await query(
      `UPDATE prompt_cards
          SET preview_image_url = ?, image_preview_url = ?, demo_url = ?, raw = CAST(? AS JSON), updated_at = NOW()
        WHERE id = ?`,
      [publicUrl, publicUrl, publicUrl, JSON.stringify(raw), row.id],
    );
    done++;
    console.log(`[cover] ${done}/${rows.length} ${row.id} -> ${publicUrl}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
