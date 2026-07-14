// Mirror the blind-box tagging into prompts-full.json so the source-of-truth
// file is consistent with merged-prompts.json.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.cwd();
const mergedPath = path.join(dir, 'merged-prompts.json');
const fullPath = path.join(dir, 'prompts-full.json');

const merged = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
const full = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

const blindById = new Map();
for (const p of merged) {
  if (p.special_collection === 'blind_box') blindById.set(p.id, p);
}

let updated = 0;
for (const p of full) {
  const ref = blindById.get(p.id);
  if (ref) {
    if (!p.original_category) p.original_category = p.category || null;
    p.category = '盲盒 UI 提示词';
    p.special_collection = 'blind_box';
    updated++;
  }
}

fs.writeFileSync(fullPath, JSON.stringify(full, null, 2));
console.log(`updated ${updated} entries in prompts-full.json`);
console.log(`prompts-full.json: ${full.length} total entries`);