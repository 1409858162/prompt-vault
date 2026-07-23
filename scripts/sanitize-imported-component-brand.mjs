import fs from 'node:fs';
import path from 'node:path';
import { query, closePool } from '../lib/mysql.js';

const ROOT = process.cwd();
const OLD_PUBLIC_PREFIX = '/assets/imported-libraries/21st_dev/';
const NEW_PUBLIC_PREFIX = '/assets/imported-libraries/component-library/';
const OLD_DIR = path.join(ROOT, 'public', 'assets', 'imported-libraries', '21st_dev');
const NEW_DIR = path.join(ROOT, 'public', 'assets', 'imported-libraries', 'component-library');

function sanitizeText(value) {
  return String(value || '')
    .replace(/https?:\/\/cdn\.21st\.dev\/[^\s)\]"'<>，。；、]+/gi, '本地素材')
    .replace(/https?:\/\/21st\.dev\/[^\s)\]"'<>，。；、]+/gi, '')
    .replace(/https?:\/\/cdn\.21st\.[^\s)\]"'<>，。；、]*/gi, '本地素材')
    .replace(/cdn\.21st\.[^\s)\]"'<>，。；、]*/gi, '本地素材')
    .replace(/21st\.[^\s)\]"'<>，。；、]*/gi, '精选组件素材库')
    .replace(/21st\.dev/gi, '精选组件素材库')
    .replace(/21st_dev/gi, 'component-library')
    .replace(/来源类型：精选组件素材库\s*/g, '来源类型：精选组件素材\n')
    .replace(/参考链接：\s*\n?/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[sanitizeText(k)] = sanitizeJson(v);
    return out;
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function newAssetUrl(value) {
  const text = String(value || '');
  if (!text.startsWith(OLD_PUBLIC_PREFIX)) return value;
  const oldBase = path.basename(text);
  const newBase = oldBase.replace(/^21st-/, 'component-');
  return NEW_PUBLIC_PREFIX + newBase;
}

function copyAssets() {
  if (!fs.existsSync(OLD_DIR)) return { copied: 0, missingOldDir: true };
  fs.mkdirSync(NEW_DIR, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(OLD_DIR)) {
    const src = path.join(OLD_DIR, name);
    if (!fs.statSync(src).isFile()) continue;
    const destName = name.replace(/^21st-/, 'component-');
    const dest = path.join(NEW_DIR, destName);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      copied += 1;
    }
  }
  return { copied, missingOldDir: false };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const assetResult = dryRun ? { copied: 0, dryRun: true } : copyAssets();

  const rows = await query(
    `SELECT c.id, c.title, c.summary, c.description, c.tags, c.preview_image_url,
            c.preview_thumb_url, c.image_preview_url, c.source_url, c.demo_url, c.raw,
            b.prompt_text
       FROM prompt_cards c
       LEFT JOIN prompt_card_bodies b ON b.card_id = c.id
      WHERE c.source IN ('extractions_21st_dev', 'extractions_component_library')`,
  );

  let updated = 0;
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    const nextTags = [...new Set(tags
      .map((tag) => sanitizeText(tag))
      .filter((tag) => tag && tag !== '精选组件素材库'))];
    if (!nextTags.includes('component-library')) nextTags.push('component-library');

    const nextRaw = sanitizeJson(row.raw || {});
    if (nextRaw && typeof nextRaw === 'object') {
      nextRaw.public_source_label = '精选组件素材库';
      nextRaw.source_url_hidden = true;
    }

    const nextPrompt = sanitizeText(row.prompt_text || '');
    const nextValues = {
      category: '精选组件素材',
      original_category: '组件素材',
      summary: sanitizeText(row.summary || ''),
      description: sanitizeText(row.description || ''),
      tags: JSON.stringify(nextTags),
      preview_image_url: newAssetUrl(row.preview_image_url),
      preview_thumb_url: newAssetUrl(row.preview_thumb_url),
      image_preview_url: newAssetUrl(row.image_preview_url),
      source_url: '',
      demo_url: newAssetUrl(row.demo_url),
      raw: JSON.stringify(nextRaw),
      prompt_text: nextPrompt,
      prompt_text_length: nextPrompt.length,
    };

    if (!dryRun) {
      await query(
        `UPDATE prompt_cards
            SET category=?, original_category=?, summary=?, description=?, tags=?,
                preview_image_url=?, preview_thumb_url=?, image_preview_url=?, source_url=?, demo_url=?,
                source='extractions_component_library', raw=CAST(? AS JSON), updated_at=NOW()
          WHERE id=?`,
        [
          nextValues.category,
          nextValues.original_category,
          nextValues.summary,
          nextValues.description,
          nextValues.tags,
          nextValues.preview_image_url,
          nextValues.preview_thumb_url,
          nextValues.image_preview_url,
          nextValues.source_url,
          nextValues.demo_url,
          nextValues.raw,
          row.id,
        ],
      );
      await query(
        `UPDATE prompt_card_bodies
            SET prompt_text=?, prompt_text_length=?, prompt_hash=SHA2(?, 256), updated_at=NOW()
          WHERE card_id=?`,
        [nextValues.prompt_text, nextValues.prompt_text_length, nextValues.prompt_text, row.id],
      );
    }
    updated += 1;
  }

  console.log('[sanitize-component-brand]', { dryRun, assetResult, rows: rows.length, updated });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
