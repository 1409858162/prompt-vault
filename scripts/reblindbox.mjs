// Re-tag merged-prompts.json: any entry without a preview becomes part of the
// new "盲盒 UI 提示词" collection. Original category is preserved as original_category
// so we never lose information, and a special_collection flag is set for fast filtering.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.cwd();
const mergedPath = path.join(dir, 'merged-prompts.json');
const data = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));

const BLIND_BOX = '盲盒 UI 提示词';
let moved = 0;
for (const p of data) {
  const noPreview = !p.preview_image_url && !p.preview_video_url;
  if (noPreview && p.category !== BLIND_BOX) {
    // Preserve the original category for reference / future restoration.
    p.original_category = p.category || null;
    p.category = BLIND_BOX;
    p.special_collection = 'blind_box';
    moved++;
  } else if (noPreview && p.category === BLIND_BOX) {
    // Already in place (idempotent re-run)
    p.special_collection = 'special_collection' in p ? p.special_collection : 'blind_box';
  }
}

fs.writeFileSync(mergedPath, JSON.stringify(data, null, 2));

// Report
const inBox = data.filter(p => p.category === BLIND_BOX).length;
const flagged = data.filter(p => p.special_collection === 'blind_box').length;
console.log(`moved into "${BLIND_BOX}": ${moved}`);
console.log(`total in collection now: ${inBox}`);
console.log(`flagged special_collection=blind_box: ${flagged}`);
console.log(`merged-prompts.json: ${data.length} total entries`);