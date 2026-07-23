import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { query, closePool } from '../lib/mysql.js';

const ROOT = process.cwd();
const SOURCE_ROOT = process.env.EXTRACTED_ROOT || '/Users/xutingting/Downloads/motionsites-prompt-collection-main/extractions';
const PUBLIC_DIR = path.join(ROOT, 'public', 'assets', 'imported-libraries');

function sanitizePublicText(value) {
  return String(value || '')
    .replace(/chat\s*gpt/gi, 'AI 助手')
    .replace(/gpt/gi, 'AI');
}

function slugify(value) {
  return sanitizePublicText(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

function publicTitle(kind, item) {
  const title = sanitizePublicText(item.title || item.name || item.componentName || item.id);
  if (kind === '21st_dev') {
    const author = sanitizePublicText(item.author || 'community');
    return `${title} · ${author}`;
  }
  if (kind === 'superdesign') return `Superdesign · ${title}`;
  return title;
}

function currentDbId(kind, item) {
  const rawTitle = item.title || item.name || item.componentName || item.id;
  return slugify(item.id || `${kind === 'horizonx' ? 'hx' : kind === '21st_dev' ? 'dev21' : 'sup'}-${rawTitle}`);
}

function publicAssetKind(kind) {
  return kind === '21st_dev' ? 'component-library' : kind;
}

function publicAssetBase(kind, item, type, ext) {
  const base = `${currentDbId(kind, item)}-${type}${ext}`;
  return kind === '21st_dev' ? base.replace(/^21st-/, 'component-') : base;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function localImage(item) {
  return item.localImage || item.localPreview || item.localImages?.[0] || null;
}

function localVideo(item) {
  return item.localVideo || item.localVideos?.[0] || null;
}

function sourceLocalPath(relativePath) {
  if (!relativePath) return null;
  return path.join(path.dirname(SOURCE_ROOT), relativePath);
}

function copyAsset(kind, item, relativePath, type) {
  const src = sourceLocalPath(relativePath);
  if (!src || !fs.existsSync(src)) return null;
  const ext = path.extname(src) || (type === 'video' ? '.mp4' : '.png');
  const assetKind = publicAssetKind(kind);
  const dir = path.join(PUBLIC_DIR, assetKind);
  fs.mkdirSync(dir, { recursive: true });
  const filename = publicAssetBase(kind, item, type, ext);
  const dest = path.join(dir, filename);
  if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
  return `/assets/imported-libraries/${assetKind}/${filename}`;
}

function publicUrlToPath(publicUrl) {
  if (!publicUrl || !String(publicUrl).startsWith('/assets/imported-libraries/')) return null;
  return path.join(ROOT, 'public', publicUrl.replace(/^\//, ''));
}

function generatePosterFromVideo(kind, item, publicVideoUrl) {
  const src = publicUrlToPath(publicVideoUrl);
  if (!src || !fs.existsSync(src)) return null;
  const assetKind = publicAssetKind(kind);
  const dir = path.join(PUBLIC_DIR, assetKind);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, publicAssetBase(kind, item, 'image', '.jpg'));
  if (!fs.existsSync(dest)) {
    try {
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        '0.35',
        '-i',
        src,
        '-frames:v',
        '1',
        '-vf',
        'scale=900:-1:force_original_aspect_ratio=decrease',
        '-q:v',
        '3',
        dest,
      ], { stdio: 'pipe' });
    } catch (err) {
      console.warn('[assets] poster failed', currentDbId(kind, item), err.message);
      return null;
    }
  }
  return `/assets/imported-libraries/${assetKind}/${path.basename(dest)}`;
}

function writeFallbackCover(kind, item) {
  const assetKind = publicAssetKind(kind);
  const dir = path.join(PUBLIC_DIR, assetKind);
  fs.mkdirSync(dir, { recursive: true });
  const id = currentDbId(kind, item);
  const title = publicTitle(kind, item);
  const dest = path.join(dir, kind === '21st_dev' ? `${id.replace(/^21st-/, 'component-')}-image.svg` : `${id}-image.svg`);
  if (!fs.existsSync(dest)) {
    const safeTitle = title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .slice(0, 90);
    fs.writeFileSync(dest, `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1125" viewBox="0 0 900 1125">
  <defs>
    <radialGradient id="a" cx="28%" cy="16%" r="80%">
      <stop offset="0" stop-color="#7dd3fc" stop-opacity=".9"/>
      <stop offset=".45" stop-color="#8b5cf6" stop-opacity=".45"/>
      <stop offset="1" stop-color="#050712"/>
    </radialGradient>
    <linearGradient id="b" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="#22d3ee"/>
      <stop offset=".55" stop-color="#a78bfa"/>
      <stop offset="1" stop-color="#f472b6"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="16" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="900" height="1125" fill="url(#a)"/>
  <g opacity=".22" stroke="#fff" stroke-width="1">
    <path d="M90 230 C210 160 300 320 430 250 S680 180 820 290"/>
    <path d="M80 710 C260 580 330 820 500 690 S720 590 835 760"/>
    <path d="M135 420 L760 925"/>
    <path d="M760 420 L135 925"/>
  </g>
  <circle cx="450" cy="520" r="210" fill="none" stroke="url(#b)" stroke-width="28" filter="url(#glow)" opacity=".9"/>
  <circle cx="450" cy="520" r="86" fill="#020617" stroke="#ffffff" stroke-opacity=".22" stroke-width="2"/>
  <path d="M410 520h80M450 480v80" stroke="#fff" stroke-width="20" stroke-linecap="round" opacity=".88"/>
  <rect x="86" y="832" width="728" height="178" rx="36" fill="#020617" fill-opacity=".62" stroke="#fff" stroke-opacity=".12"/>
  <text x="450" y="904" text-anchor="middle" fill="#f8fafc" font-family="Arial, PingFang SC, sans-serif" font-size="34" font-weight="700">本地封面</text>
  <text x="450" y="956" text-anchor="middle" fill="#cbd5e1" font-family="Arial, PingFang SC, sans-serif" font-size="24">${safeTitle}</text>
</svg>`, 'utf8');
  }
  return `/assets/imported-libraries/${assetKind}/${path.basename(dest)}`;
}

function loadAllItems() {
  const root = path.resolve(SOURCE_ROOT);
  const files = [
    ['horizonx', path.join(root, 'horizonx/data/horizonx_prompts.json')],
    ['21st_dev', path.join(root, '21st_dev/data/21st_dev_prompts.json')],
    ['superdesign', path.join(root, 'superdesign/data/superdesign_prompts.json')],
  ];
  const all = [];
  for (const [kind, file] of files) {
    if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
    for (const item of readJson(file)) all.push({ kind, item });
  }
  return all;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const updates = [];
  const missing = [];

  for (const { kind, item } of loadAllItems()) {
    const id = currentDbId(kind, item);
    const title = publicTitle(kind, item);
    let image = copyAsset(kind, item, localImage(item), 'image');
    const video = copyAsset(kind, item, localVideo(item), 'video');
    if (!image && video) image = generatePosterFromVideo(kind, item, video);
    if (!image && !video) image = writeFallbackCover(kind, item);
    if (!image && !video) {
      missing.push({ id, title, kind, localImage: localImage(item), localVideo: localVideo(item) });
      continue;
    }
    updates.push({
      id,
      title,
      kind,
      image,
      video,
      demo: video || image,
    });
  }

  console.log('[assets]', JSON.stringify({ found: updates.length + missing.length, updates: updates.length, missing: missing.length, dryRun }, null, 2));
  if (missing.length) console.log('[assets] missing sample', missing.slice(0, 10));
  if (dryRun) return;

  let done = 0;
  for (const u of updates) {
    const rows = await query('SELECT raw FROM prompt_cards WHERE id=? LIMIT 1', [u.id]);
    if (!rows.length) {
      missing.push({ id: u.id, title: u.title, kind: u.kind, reason: 'db_not_found' });
      continue;
    }
    const raw = rows[0]?.raw && typeof rows[0].raw === 'object' ? rows[0].raw : {};
    raw.local_asset_localized = true;
    raw.local_asset_kind = u.kind;
    raw.local_asset_image = u.image;
    raw.local_asset_video = u.video;
    await query(
      `UPDATE prompt_cards
          SET preview_image_url=?, image_preview_url=?, demo_url=?, raw=CAST(? AS JSON), updated_at=NOW()
        WHERE id=?`,
      [u.image, u.image, u.demo, JSON.stringify(raw), u.id],
    );
    done += 1;
    if (done % 25 === 0) console.log(`[db] localized ${done}/${updates.length}`);
  }

  console.log('[db] localized done', { done, notFoundOrMissing: missing.length });
  const totals = await query(`SELECT source, COUNT(*) AS n,
       SUM(preview_image_url LIKE '/assets/imported-libraries/%') AS local_images,
       SUM(demo_url LIKE '/assets/imported-libraries/%') AS local_demos
     FROM prompt_cards
     WHERE source LIKE 'extractions_%'
     GROUP BY source ORDER BY source`);
  console.log('[db] totals', totals);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
