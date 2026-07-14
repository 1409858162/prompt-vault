#!/usr/bin/env node
/**
 * Clean a MySQL dump (mysqldump output) into a script TiDB Cloud can run.
 *
 * Why this is needed:
 *   - mysqldump emits a header with /*!40101 ... *​/ versioned comments and
 *     CREATE DATABASE / USE statements. TiDB Cloud owns its own database, so
 *     we drop those.
 *   - LOCK TABLES / UNLOCK TABLES / DISABLE KEYS / ENABLE KEYS are MySQL-
 *     specific. TiDB rejects them.
 *   - utf8mb4_unicode_ci collation is supported but produces a warning on
 *     some columns; we replace it with utf8mb4_bin which is universally
 *     supported and behaves identically for byte-level comparisons.
 *   - The dump may reference DEFINER=`...`@`...` on views/procs (we don't
 *     ship any, but defensively strip them).
 *
 * Usage:
 *   node scripts/clean-sql-for-tidb.mjs prompt_vault.sql prompt_vault.tidb.sql
 */

import { readFile, writeFile } from 'node:fs/promises';

const src = process.argv[2];
const dst = process.argv[3];
if (!src || !dst) {
  console.error('Usage: clean-sql-for-tidb.mjs <input.sql> <output.sql>');
  process.exit(1);
}

let sql = await readFile(src, 'utf8');

// 1. Strip /*! ... */ versioned comments entirely (including their bodies).
//    These are mysqldump conditional statements; TiDB doesn't parse them.
sql = sql.replace(/\/\*![\s\S]*?\*\/\s*;?/g, '');

// 2. Strip /* ... */ plain comments (multi-line).
sql = sql.replace(/\/\*[\s\S]*?\*\//g, '');

// 3. Drop full-line -- comments and DROP DATABASE / CREATE DATABASE / USE.
sql = sql
  .split('\n')
  .filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('--')) return false;
    if (/^DROP\s+DATABASE/i.test(trimmed)) return false;
    if (/^CREATE\s+DATABASE/i.test(trimmed)) return false;
    if (/^USE\s+/i.test(trimmed)) return false;
    return true;
  })
  .join('\n');

// 4. Strip MySQL session directives that TiDB doesn't accept.
sql = sql
  .replace(/^SET\s+[^;]+;/gim, '')
  .replace(/^LOCK\s+TABLES[\s\S]*?;\s*$/gim, '')
  .replace(/^UNLOCK\s+TABLES\s*;/gim, '')
  .replace(/^ALTER\s+TABLE\s+\S+\s+(DISABLE|ENABLE)\s+KEYS\s*;/gim, '');

// 5. Replace collation with one TiDB supports universally.
sql = sql.replace(/utf8mb4_unicode_ci/g, 'utf8mb4_bin');
sql = sql.replace(/utf8mb4_general_ci/g, 'utf8mb4_bin');

// 6. Strip DEFINER clauses from CREATE statements (defensive; we don't use views).
sql = sql.replace(/\s+DEFINER=`[^`]+`@`[^`]+`/g, '');

// 7. Collapse 3+ blank lines into one.
sql = sql.replace(/\n{3,}/g, '\n\n');

// 8. Ensure file ends with a single trailing newline.
if (!sql.endsWith('\n')) sql += '\n';

await writeFile(dst, sql);
console.log(`Cleaned ${src} -> ${dst} (${sql.length} bytes)`);