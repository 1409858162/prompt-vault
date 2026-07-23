#!/usr/bin/env node
import 'dotenv/config';
import { scanLinkHealth, listLinkHealth } from '../lib/linkHealth.js';
import { closePool } from '../lib/mysql.js';

function arg(name, fallback = undefined) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1] ?? fallback;
  return fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}

const scope = arg('scope', 'all'); // all/cards/ideas/tutorials
const q = arg('q', '');
const limit = Number(arg('limit', 100));
const timeoutMs = Number(arg('timeout-ms', 7000));
const concurrency = Number(arg('concurrency', 6));

try {
  if (has('list')) {
    const data = await listLinkHealth({
      status: arg('status', 'bad'),
      contentType: arg('type', 'all'),
      q,
      page: Number(arg('page', 1)),
      limit: Number(arg('limit', 50)),
    });
    console.log(`\n素材外链检测结果：${data.total} 条`);
    console.log('─'.repeat(120));
    for (const item of data.items) {
      const code = item.http_status ? `HTTP ${item.http_status}` : '-';
      console.log(`[${item.status}] ${code} ${item.content_type}/${item.content_id} ${item.title || ''}`);
      console.log(`  ${item.field_name}: ${item.url}`);
      if (item.error_message) console.log(`  错误: ${item.error_message}`);
    }
    console.log('');
  } else {
    console.log(`[link-health] 开始扫描 scope=${scope} limit=${limit} q=${q || '-'} concurrency=${concurrency}`);
    const data = await scanLinkHealth({ scope, q, limit, timeoutMs, concurrency });
    console.log('\n[link-health] 扫描完成');
    console.log(JSON.stringify(data, null, 2));
    console.log('\n查看异常：node scripts/check-link-health.mjs --list --status bad\n');
  }
} catch (err) {
  console.error('[link-health] failed:', err);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
