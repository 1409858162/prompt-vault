import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, closePool, toMysqlDt } from '../lib/mysql.js';

const ROOT = process.cwd();
const SOURCE_FILE = process.env.COMPONENT_SEARCH_RESULTS || '/Users/xutingting/Desktop/vibecoding projects/21st-main/search_results.json';
const ASSET_DIR = path.join(ROOT, 'public', 'assets', 'imported-libraries', 'component-library');
const PUBLIC_ASSET_PREFIX = '/assets/imported-libraries/component-library';
const OUT_DIR = path.join(ROOT, 'work', 'component-search-import');
const SOURCE = 'component_inspiration_search';
const CATEGORY = '组件灵感';
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_DOWNLOAD = process.argv.includes('--skip-download') || DRY_RUN;

fs.mkdirSync(ASSET_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function sanitizePublicText(value) {
  return String(value || '')
    .replace(/chat\s*gpt/gi, 'AI 助手')
    .replace(/gpt/gi, 'AI')
    .replace(/21st\.dev/gi, '组件灵感库')
    .replace(/cdn\.21st\.dev/gi, '组件素材源');
}

function slugify(value) {
  return sanitizePublicText(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalize(value) {
  return sanitizePublicText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactSummary(text, fallback = '') {
  const s = sanitizePublicText(text || fallback || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 220);
}

function readSourceItems() {
  if (!fs.existsSync(SOURCE_FILE)) throw new Error(`找不到文件：${SOURCE_FILE}`);
  const parsed = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  const arr = Array.isArray(parsed) ? parsed : parsed.results;
  if (!Array.isArray(arr)) throw new Error('search_results.json 格式不对：需要数组或 { results: [] }');
  return arr;
}

function inferPageType(item) {
  const title = `${item.component_data?.name || item.name || ''} ${item.component_data?.description || ''}`.toLowerCase();
  if (/testimonial|review|quote/.test(title)) return 'testimonials';
  if (/feature|bento/.test(title)) return 'feature';
  if (/card|expand/.test(title)) return 'card';
  if (/badge|pill/.test(title)) return 'badge';
  if (/video|dialog|modal/.test(title)) return 'media';
  if (/parallax|scroll|animation|animated|motion/.test(title)) return 'animation';
  if (/hero|landing/.test(title)) return 'hero';
  return 'component';
}

function fileExtFromUrl(url, fallback = '.png') {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v)$/i.test(ext)) return ext;
  } catch {}
  return fallback;
}

async function downloadAsset(url, basename, fallbackExt = '.png') {
  if (!url || SKIP_DOWNLOAD) return null;
  const ext = fileExtFromUrl(url, fallbackExt);
  const filename = `${basename}${ext}`;
  const dest = path.join(ASSET_DIR, filename);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return `${PUBLIC_ASSET_PREFIX}/${filename}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 PromptVault asset mirror',
        'Accept': fallbackExt === '.mp4' ? 'video/*,*/*;q=0.8' : 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('empty body');
    fs.writeFileSync(dest, buf);
    return `${PUBLIC_ASSET_PREFIX}/${filename}`;
  } catch (err) {
    console.warn(`[asset] 下载失败 ${url}: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function publicTitle(item) {
  const name = sanitizePublicText(item.component_data?.name || item.name || 'Component Inspiration');
  const author = sanitizePublicText(item.component_user_data?.username || item.component_user_data?.name || 'community');
  return `${name} · ${author}`;
}

function componentKey(item) {
  const command = String(item.component_data?.install_command || '');
  const match = command.match(/\/r\/([^/\s"']+)\/([^/\s"']+)/i);
  if (match) return `${slugify(match[1])}/${slugify(match[2])}`;
  const user = slugify(item.component_user_data?.username || item.component_user_data?.name || 'community');
  const name = slugify(item.component_data?.name || item.name || 'component');
  return `${user}/${name}`;
}

function makePromptText(item, imageUrl, videoUrl) {
  const title = publicTitle(item);
  const name = sanitizePublicText(item.component_data?.name || item.name || 'Component');
  const desc = sanitizePublicText(item.component_data?.description || '高质量前端组件灵感');
  const type = inferPageType(item);
  const usage = Number(item.usage_count || 0);
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('来源类型：高热组件灵感');
  lines.push(`组件类型：${type}`);
  if (usage) lines.push(`热度参考：${usage}`);
  lines.push(`组件名称：${name}`);
  lines.push(`简介：${desc}`);
  if (imageUrl) lines.push(`封面素材：${imageUrl}`);
  if (videoUrl) lines.push(`视频参考：${videoUrl}`);
  lines.push('');
  lines.push('## 可直接复制使用的生成提示词');
  lines.push('');
  lines.push(`请你作为资深前端视觉设计师和工程实现专家，生成一个「${name}」组件。`);
  lines.push('');
  lines.push('目标效果：');
  lines.push(`- 核心描述：${desc}`);
  lines.push('- 视觉风格：高端、现代、细节丰富，适合 SaaS / 产品官网 / 作品集 / 工具站。');
  lines.push('- 技术要求：React + TypeScript + Tailwind CSS，组件结构清晰，样式可维护，移动端自适应。');
  lines.push('- 交互要求：按钮、悬停、进入动效、层次阴影和响应式布局要完整；重动效需要考虑性能降级。');
  lines.push('- 交付要求：直接输出可复制到项目中的完整组件代码，并说明需要的依赖、图片占位和可替换文案位置。');
  lines.push('');
  lines.push('细节强化：');
  lines.push('- 保留明确的信息层级：主标题、副标题、行动按钮、辅助说明、展示区。');
  lines.push('- 使用设计 token 或 CSS 变量组织颜色、圆角、阴影和间距。');
  lines.push('- 封面/视频仅作为视觉参考，不要硬编码外链；生产环境请替换为自己的素材。');
  return lines.join('\n');
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

async function getExisting() {
  const rows = await query(
    `SELECT c.id, c.title, c.source, c.raw, b.prompt_hash, b.prompt_text
       FROM prompt_cards c
       LEFT JOIN prompt_card_bodies b ON b.card_id = c.id`,
    [],
  );
  const ids = new Set();
  const keys = new Set();
  const hashes = new Set();
  const componentNames = new Set();
  for (const r of rows) {
    ids.add(r.id);
    for (const v of [r.id, r.title]) {
      const n = normalize(v);
      if (n) keys.add(n);
    }
    try {
      const raw = typeof r.raw === 'string' ? JSON.parse(r.raw) : r.raw;
      const candidates = [
        raw?.component_key,
        raw?.source_item?.component_data?.install_command,
        raw?.source_item?.component_data?.code,
        raw?.source_item?.preview_url,
        raw?.source_item?.id,
        raw?.source_item?.componentName,
        raw?.source_item?.component_data?.name,
        raw?.source_item?.author && raw?.source_item?.componentName ? `${raw.source_item.author}/${raw.source_item.componentName}` : '',
      ];
      for (const c of candidates) {
        const n = normalize(c);
        if (n) keys.add(n);
      }
      const compName = slugify(raw?.source_item?.componentName || raw?.source_item?.component_data?.name || '');
      if (compName) componentNames.add(compName);
    } catch {}
    if (r.prompt_hash) hashes.add(r.prompt_hash);
    if (r.prompt_text) hashes.add(sha256(r.prompt_text));
  }
  const maxRows = await query(`SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM prompt_cards`, []);
  return { ids, keys, hashes, componentNames, maxSort: Number(maxRows?.[0]?.max_sort || 0) };
}

function uniqueId(base, ids) {
  const idBase = base || 'component-inspiration';
  let id = idBase;
  let suffix = 2;
  while (ids.has(id)) id = `${idBase}-${suffix++}`;
  ids.add(id);
  return id;
}

async function makeRecord(item, sortOrder, ids) {
  const key = componentKey(item);
  const [authorKey, nameKey] = key.split('/');
  const id = uniqueId(`cmp-${authorKey || 'community'}-${nameKey || slugify(item.component_data?.name || item.name)}`, ids);
  const assetBase = `component-${authorKey || 'community'}-${nameKey || id}`;
  const image = await downloadAsset(item.preview_url, `${assetBase}-image`, '.png');
  // 视频只作为懒加载参考；为了避免仓库体积暴涨，默认不主动下载视频。
  const video = null;
  const promptText = makePromptText(item, image, video);
  const type = inferPageType(item);
  const now = toMysqlDt(new Date());
  return {
    id,
    title: publicTitle(item),
    category: CATEGORY,
    original_category: '高热组件',
    page_type: type,
    summary: compactSummary(promptText, item.component_data?.description),
    description: sanitizePublicText(item.component_data?.description || ''),
    tags: JSON.stringify(['component-inspiration', type, item.component_user_data?.username].filter(Boolean).map(sanitizePublicText)),
    preview_image_url: image,
    preview_thumb_url: null,
    image_preview_url: image,
    source_url: '',
    demo_url: image,
    sort_order: sortOrder,
    source: SOURCE,
    is_free: 0,
    is_blindbox: image ? 0 : 1,
    member_only: image ? 1 : 0,
    active: 1,
    heat: Number(item.usage_count || 0),
    raw: JSON.stringify(sanitizeRaw({ imported_from: SOURCE_FILE, component_key: key, source_item: item })),
    prompt_text: promptText,
    prompt_text_length: promptText.length,
    prompt_hash: sha256(promptText),
    created_at: now,
    updated_at: now,
  };
}

async function main() {
  const items = readSourceItems();
  const { ids, keys, hashes, componentNames, maxSort } = await getExisting();
  const records = [];
  const skipped = [];
  let sortOrder = maxSort + 1;

  for (const item of items) {
    const key = componentKey(item);
    const keyCandidates = [
      key,
      item.component_data?.install_command,
      item.component_data?.code,
      item.preview_url,
    ].map(normalize).filter(Boolean);
    const matchedKey = keyCandidates.find(k => keys.has(k));
    const nameKey = slugify(item.component_data?.name || item.name || '');
    const genericNames = new Set(['hero', 'default']);
    if (matchedKey || (nameKey && !genericNames.has(nameKey) && componentNames.has(nameKey))) {
      skipped.push({ title: publicTitle(item), key, reason: matchedKey ? 'duplicate_key' : 'duplicate_component_name' });
      continue;
    }
    const rec = await makeRecord(item, sortOrder++, ids);
    if (hashes.has(rec.prompt_hash)) {
      skipped.push({ title: rec.title, key, reason: 'duplicate_hash' });
      continue;
    }
    records.push(rec);
    hashes.add(rec.prompt_hash);
    for (const k of keyCandidates) keys.add(k);
    keys.add(normalize(rec.title));
  }

  const report = records.map(({ prompt_text, raw, ...rest }) => rest);
  const summary = {
    source_file: SOURCE_FILE,
    found: items.length,
    import_candidates: records.length,
    skipped: skipped.length,
    dry_run: DRY_RUN,
    skip_download: SKIP_DOWNLOAD,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'to-import.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'skipped.json'), JSON.stringify(skipped, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('[summary]', JSON.stringify(summary, null, 2));

  if (DRY_RUN || !records.length) return;
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
         member_only=VALUES(member_only), active=VALUES(active), heat=VALUES(heat), raw=VALUES(raw), updated_at=VALUES(updated_at)`,
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
    console.log(`[db] ${i + 1}/${records.length} ${r.id}`);
  }
  const totals = await query(
    `SELECT source, category, COUNT(*) AS n FROM prompt_cards WHERE source IN (?, 'extractions_component_library', 'extractions_horizonx', 'extractions_superdesign') GROUP BY source, category ORDER BY source, category`,
    [SOURCE],
  );
  console.table(totals);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
