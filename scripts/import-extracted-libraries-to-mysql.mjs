import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, closePool } from '../lib/mysql.js';

const ROOT = process.cwd();
const SOURCE_ROOT = process.env.EXTRACTED_ROOT || '/Users/xutingting/Downloads/motionsites-prompt-collection-main/extractions';
const OUT_DIR = path.join(ROOT, 'work', 'extracted-libraries-import');
fs.mkdirSync(OUT_DIR, { recursive: true });

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function sanitizePublicText(value) {
  return String(value || '')
    .replace(/chat\s*gpt/gi, 'AI 助手')
    .replace(/gpt/gi, 'AI');
}

function normalize(value) {
  return sanitizePublicText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
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

function compactSummary(text, fallback = '') {
  const s = sanitizePublicText(String(text || fallback || ''))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 220);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function remoteImage(item) {
  return item.previewImage || item.previewUrl || item.previewImages?.[0] || null;
}

function remoteVideo(item) {
  return item.previewVideo || item.previewVideos?.[0] || null;
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

function safePublicAssetUrl(kind, item, type) {
  const remote = type === 'video' ? remoteVideo(item) : remoteImage(item);
  if (kind !== '21st_dev' && !/gpt/i.test(String(remote || ''))) return remote || null;

  const local = type === 'video' ? localVideo(item) : localImage(item);
  const src = sourceLocalPath(local);
  if (!src || !fs.existsSync(src)) return null;

  const ext = path.extname(src) || (type === 'video' ? '.mp4' : '.png');
  const publicKind = kind === '21st_dev' ? 'component-library' : kind;
  const dir = path.join(ROOT, 'public', 'assets', 'imported-safe', publicKind);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${slugify(item.id || item.title || item.componentName || 'asset').replace(/^21st-/, 'component-')}-${type}${ext}`;
  const dest = path.join(dir, base);
  if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
  return `/assets/imported-safe/${publicKind}/${base}`;
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

function sanitizeRaw(value) {
  if (Array.isArray(value)) return value.map(sanitizeRaw);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[sanitizePublicText(k)] = sanitizeRaw(v);
    return out;
  }
  if (typeof value === 'string') return sanitizePublicText(value);
  return value;
}

function renderPrompt(kind, item) {
  const title = publicTitle(kind, item);
  const base = sanitizePublicText(item.promptText || item.prompt_text || item.promptAnchor || '');
  const lines = [];
  lines.push(`# ${title}`);
  if (kind === '21st_dev') lines.push(`\n来源类型：精选组件素材`);
  else if (item.website) lines.push(`\n来源类型：${sanitizePublicText(item.website)}`);
  if (item.category) lines.push(`分类：${sanitizePublicText(item.category)}`);
  if (item.type) lines.push(`类型：${sanitizePublicText(item.type)}`);
  if (item.author) lines.push(`作者/风格参考：${sanitizePublicText(item.author)}`);
  if (item.componentName) lines.push(`组件名称：${sanitizePublicText(item.componentName)}`);
  if (item.description) lines.push(`\n简介：${sanitizePublicText(item.description)}`);
  if (item.installCommand) lines.push(`\n安装命令：\n\`\`\`bash\n${sanitizePublicText(item.installCommand)}\n\`\`\``);
  if (kind !== '21st_dev' && item.url && !/gpt/i.test(String(item.url))) lines.push(`\n参考链接：${sanitizePublicText(item.url)}`);

  const image = safePublicAssetUrl(kind, item, 'image');
  const video = safePublicAssetUrl(kind, item, 'video');
  if (image) lines.push(`封面素材：${image}`);
  if (video) lines.push(`视频素材：${video}`);

  const li = localImage(item);
  const lv = localVideo(item);
  if (li || lv) {
    lines.push(`\n本地素材备份：`);
    if (li && !/gpt/i.test(li)) lines.push(`- 图片：${li}`);
    if (lv && !/gpt/i.test(lv)) lines.push(`- 视频：${lv}`);
  }

  lines.push(`\n## 可直接复制使用的提示词\n\n${base}`);
  if (kind === '21st_dev') {
    lines.push(`\n## 使用建议\n- 如果你使用 shadcn/ui，可优先尝试安装命令。\n- 如果安装失败，把上面的组件名称、作者风格、预览素材和要求一起交给 Cursor / Lovable / Bolt 复刻。\n- 保持 Tailwind、Lucide、响应式、主题变量和可复用 props。`);
  } else if (kind === 'horizonx') {
    lines.push(`\n## 使用建议\n- 适合做高端 Hero、WebGL/Canvas 动效、液态玻璃、粒子交互和作品集展示。\n- 先生成核心视觉组件，再补 navbar、CTA、响应式和性能优化。\n- 动效较重时注意移动端降级、懒加载和 prefers-reduced-motion。`);
  } else if (kind === 'superdesign') {
    lines.push(`\n## 使用建议\n- 适合做产品原型、设计系统组件、无限画布、主题切换和 AI 工作流界面。\n- 生成后优先整理成可复用组件和状态管理结构。`);
  }
  return lines.join('\n');
}

function makeRecord(kind, item, sortOrder, existingIds) {
  const rawTitle = item.title || item.name || item.componentName || item.id;
  const title = publicTitle(kind, item);
  const sourcePrefix = kind === 'horizonx' ? 'hx' : kind === '21st_dev' ? 'dev21' : 'sup';
  const idBase = slugify(item.id || `${sourcePrefix}-${rawTitle}`) || `${sourcePrefix}-${sortOrder}`;
  let id = idBase;
  let suffix = 2;
  while (existingIds.has(id)) id = `${idBase}-${suffix++}`;
  existingIds.add(id);

  const promptText = renderPrompt(kind, item);
  const image = safePublicAssetUrl(kind, item, 'image');
  const video = safePublicAssetUrl(kind, item, 'video');
  const now = new Date();
  const category = kind === 'horizonx'
    ? 'HorizonX 动效灵感'
    : kind === '21st_dev'
      ? '精选组件素材'
      : 'Superdesign 设计灵感';
  const pageType = kind === 'horizonx' ? 'horizonx' : kind === '21st_dev' ? 'component' : 'design';

  return {
    id,
    title,
    category,
    original_category: kind === '21st_dev' ? '组件素材' : sanitizePublicText(item.category || item.type || item.website || null),
    page_type: pageType,
    summary: compactSummary(promptText, item.description),
    description: sanitizePublicText(item.description || item.promptAnchor || ''),
    tags: JSON.stringify(['imported-library', kind === '21st_dev' ? 'component-library' : kind, kind === '21st_dev' ? null : item.website, item.category, item.type].filter(Boolean).map(sanitizePublicText)),
    preview_image_url: image,
    preview_thumb_url: null,
    image_preview_url: image,
    source_url: kind !== '21st_dev' && item.url && !/gpt/i.test(String(item.url)) ? sanitizePublicText(item.url) : '',
    demo_url: video || image || null,
    sort_order: sortOrder,
    source: kind === '21st_dev' ? 'extractions_component_library' : `extractions_${kind}`,
    is_free: 0,
    is_blindbox: image || video ? 0 : 1,
    member_only: image || video ? 1 : 0,
    active: 1,
    heat: 0,
    raw: JSON.stringify(sanitizeRaw({ imported_from: SOURCE_ROOT, imported_kind: kind, source_item: item })),
    prompt_text: promptText,
    prompt_text_length: promptText.length,
    prompt_hash: sha256(promptText),
    created_at: now,
    updated_at: now,
  };
}

async function getExisting() {
  const rows = await query(`SELECT c.id, c.title, c.sort_order, b.prompt_hash, b.prompt_text
                              FROM prompt_cards c
                              LEFT JOIN prompt_card_bodies b ON b.card_id = c.id`);
  const keys = new Set();
  const ids = new Set();
  const hashes = new Set();
  let maxSort = 0;
  for (const r of rows) {
    ids.add(r.id);
    maxSort = Math.max(maxSort, Number(r.sort_order) || 0);
    for (const v of [r.id, String(r.id || '').replace(/-/g, ' ')]) {
      const k = normalize(v);
      if (k) keys.add(k);
    }
    if (r.prompt_hash) hashes.add(r.prompt_hash);
    if (r.prompt_text) hashes.add(sha256(r.prompt_text));
  }
  return { ids, keys, hashes, maxSort };
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
    const data = readJson(file);
    for (const item of data) all.push({ kind, item });
  }
  return all;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { ids, keys, hashes, maxSort } = await getExisting();
  let sortOrder = maxSort + 1;
  const records = [];
  const skipped = [];

  for (const { kind, item } of loadAllItems()) {
    const title = publicTitle(kind, item);
    const keyCandidates = [item.id, item.url].map(normalize).filter(Boolean);
    const promptText = renderPrompt(kind, item);
    const hash = sha256(promptText);
    const matchedKey = keyCandidates.find((k) => keys.has(k));
    if (matchedKey || hashes.has(hash)) {
      skipped.push({ kind, id: item.id, title, reason: matchedKey ? 'duplicate_key' : 'duplicate_hash' });
      continue;
    }
    const rec = makeRecord(kind, item, sortOrder++, ids);
    for (const k of keyCandidates) keys.add(k);
    hashes.add(rec.prompt_hash);
    records.push(rec);
  }

  const publicReport = records.map(({ prompt_text, raw, ...r }) => r);
  fs.writeFileSync(path.join(OUT_DIR, 'to-import.json'), JSON.stringify(publicReport, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'skipped.json'), JSON.stringify(skipped, null, 2));
  const summary = {
    source_root: SOURCE_ROOT,
    found: records.length + skipped.length,
    import_candidates: records.length,
    skipped: skipped.length,
    by_source: records.reduce((acc, r) => { acc[r.source] = (acc[r.source] || 0) + 1; return acc; }, {}),
    dry_run: dryRun,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('[summary]', JSON.stringify(summary, null, 2));

  if (dryRun || !records.length) return;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    await query(
      `INSERT INTO prompt_cards
        (id, title, category, original_category, page_type, summary, description, tags,
         preview_image_url, preview_thumb_url, image_preview_url, source_url, demo_url,
         sort_order, source, is_free, is_blindbox, member_only, active, heat, raw, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)
       ON DUPLICATE KEY UPDATE
         title=VALUES(title), category=VALUES(category), original_category=VALUES(original_category),
         page_type=VALUES(page_type), summary=VALUES(summary), description=VALUES(description), tags=VALUES(tags),
         preview_image_url=VALUES(preview_image_url), preview_thumb_url=VALUES(preview_thumb_url),
         image_preview_url=VALUES(image_preview_url), source_url=VALUES(source_url), demo_url=VALUES(demo_url),
         source=VALUES(source), is_free=VALUES(is_free), is_blindbox=VALUES(is_blindbox),
         member_only=VALUES(member_only), active=VALUES(active), raw=VALUES(raw), updated_at=VALUES(updated_at)`,
      [
        r.id, r.title, r.category, r.original_category, r.page_type, r.summary, r.description, r.tags,
        r.preview_image_url, r.preview_thumb_url, r.image_preview_url, r.source_url, r.demo_url,
        r.sort_order, r.source, r.is_free, r.is_blindbox, r.member_only, r.active, r.heat, r.raw, r.created_at, r.updated_at,
      ],
    );
    await query(
      `INSERT INTO prompt_card_bodies (card_id, prompt_text, prompt_text_length, prompt_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         prompt_text=VALUES(prompt_text), prompt_text_length=VALUES(prompt_text_length),
         prompt_hash=VALUES(prompt_hash), updated_at=VALUES(updated_at)`,
      [r.id, r.prompt_text, r.prompt_text_length, r.prompt_hash, r.created_at, r.updated_at],
    );
    if ((i + 1) % 25 === 0) console.log(`[db] ${i + 1}/${records.length}`);
  }
  const totals = await query(`SELECT source, COUNT(*) AS n FROM prompt_cards WHERE source LIKE 'extractions_%' GROUP BY source ORDER BY source`);
  console.log('[db] imported totals', totals);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
