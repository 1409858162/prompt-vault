// Admin CLI: generate, list, and revoke invite codes; manage username/password accounts.
// Usage:
//   node admin.js generate [--label "买家昵称"] [--note "taobao order #123"]
//   node admin.js batch-generate <count> [--label "买家昵称"] [--note "taobao order #123"] [--years <n>]
//   node admin.js list
//   node admin.js revoke <code-id>
//   node admin.js verify <plaintext-code>     // debugging
//   node admin.js lookup-account <username>   // look up account by username
//   node admin.js accounts                    // list all accounts
//   node admin.js revoke-account <account-id> // revoke an account (locks it out)
import * as store from './lib/store.js';
import * as accountsLib from './lib/accounts.js';
import { formatCode } from './lib/codes.js';
import { closePool } from './lib/mysql.js';

const [, , cmd, ...rest] = process.argv;

function parseFlags(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--label') out.label = rest[++i];
    else if (rest[i] === '--note') out.note = rest[++i];
    else if (rest[i] === '--years') out.membership_years = Number(rest[++i]);
  }
  return out;
}

async function main() {
  if (cmd === 'generate' || cmd === 'gen' || cmd === 'new') {
    const flags = parseFlags(rest);
    const { plaintext, ...entry } = await store.add(flags);
    console.log('\n  ✓ 已生成新邀请码\n');
    console.log('  ID:           ' + entry.id);
    console.log('  标签:         ' + (entry.label || '(无)'));
    if (entry.note) console.log('  备注:         ' + entry.note);
    console.log('  会员时长:     ' + (entry.membership_years || 10) + ' 年（自首次登录起算）');
    console.log('  明文 (请立即复制, 仅显示一次):');
    console.log('  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │ ' + formatCode(plaintext) + ' │');
    console.log('  └──────────────────────────────────────────────────────────┘');
    console.log('  Or with no separators:\n  ' + plaintext + '\n');
  } else if (cmd === 'batch-generate' || cmd === 'batch' || cmd === 'bg') {
    const count = parseInt(rest[0] || '10', 10);
    if (!Number.isFinite(count) || count < 1 || count > 200) {
      console.error('  ✗ 数量必须为 1..200'); process.exit(1);
    }
    // Pull out the count, then parse remaining flags.
    const flagRest = rest.slice(1);
    const flags = parseFlags(flagRest);
    const codes = [];
    for (let i = 0; i < count; i++) {
      const { plaintext, ...entry } = await store.add({
        label: flags.label || '',
        note: (flags.note || '') + (count > 1 ? ` [batch ${i + 1}/${count}]` : ''),
        membership_years: flags.membership_years,
      });
      codes.push({ plaintext, entry });
    }
    console.log(`\n  ✓ 已批量生成 ${count} 个邀请码\n`);
    if (flags.label) console.log('  标签:         ' + flags.label);
    if (flags.note) console.log('  备注前缀:     ' + flags.note);
    console.log('\n  #     邀请码                                                  ID');
    console.log('  ' + '─'.repeat(95));
    codes.forEach(({ plaintext, entry }, i) => {
      const n = String(i + 1).padStart(3, ' ');
      console.log(`  ${n}   ${formatCode(plaintext).padEnd(60)} ${entry.id}`);
    });
    console.log('\n  ⚠  明文只显示这一次，请立即复制保存。');
    console.log('  提示: 同时写入 JSON 文件方便程序化处理。');
    const fs = await import('node:fs');
    const outFile = `batch-codes-${Date.now()}.json`;
    fs.writeFileSync(outFile, JSON.stringify(codes.map(({ plaintext, entry }) => ({
      id: entry.id, plaintext, label: entry.label, note: entry.note, membership_years: entry.membership_years,
    })), null, 2));
    console.log(`  ✓ 已写入 ${outFile}\n`);
  } else if (cmd === 'list' || cmd === 'ls') {
    const codes = await store.readAll();
    if (!codes.length) { console.log('\n  (无邀请码 — 用 `node admin.js generate` 创建)\n'); return; }
    console.log('\n  ID                标签              会员        到期时间            使用次数  状态');
    console.log('  ' + '─'.repeat(98));
    for (const c of codes) {
      const status = c.revoked ? '已吊销' : '有效';
      const t = new Date(c.created_at).toLocaleString('zh-CN', { hour12: false });
      const member = c.membership_years != null ? `${c.membership_years}年` : '永久(旧码)';
      const exp = c.expires_at
        ? new Date(c.expires_at).toLocaleDateString('zh-CN')
        : (c.membership_years != null ? '未激活' : '—');
      console.log(
        '  ' + c.id.padEnd(18) +
        ' ' + (c.label || '-').padEnd(16).slice(0, 16) +
        ' ' + member.padEnd(10) +
        ' ' + String(exp).padEnd(18) +
        ' ' + String(c.use_count || 0).padStart(8) + '  ' + status
      );
    }
    console.log();
  } else if (cmd === 'revoke' || cmd === 'del') {
    const id = rest[0];
    if (!id) { console.error('请提供邀请码 ID'); process.exit(1); }
    const ok = await store.revoke(id);
    console.log(ok ? `  ✓ 已吊销 ${id}` : `  ✗ 没找到 ${id}`);
  } else if (cmd === 'verify') {
    const code = rest[0];
    if (!code) { console.error('请提供明文邀请码'); process.exit(1); }
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    const entry = await store.findByPlaintext(normalized);
    console.log(entry ? `  ✓ 有效 — ${entry.id} (${entry.label || '无标签'})` : '  ✗ 无效');
  } else if (cmd === 'accounts') {
    const accounts = await accountsLib.listAll();
    if (!accounts.length) { console.log('\n  (无账号)\n'); return; }
    console.log('\n  ID                用户名              类型        创建时间             登录次数  状态');
    console.log('  ' + '─'.repeat(94));
    for (const a of accounts) {
      const status = a.revoked ? '已吊销' : '有效';
      const t = new Date(a.created_at).toLocaleString('zh-CN', { hour12: false });
      console.log(
        '  ' + a.id.padEnd(18) +
        ' ' + (a.username || '-').padEnd(20).slice(0,20) +
        ' ' + (a.kind || '-').padEnd(12) +
        ' ' + t.padEnd(20) +
        ' ' + String(a.login_count || 0).padStart(8) + '  ' + status
      );
    }
    console.log();
  } else if (cmd === 'lookup-account') {
    const username = rest[0];
    if (!username) { console.error('请提供用户名'); process.exit(1); }
    const a = await accountsLib.findByUsername(username);
    if (!a) { console.log(`  ✗ 没找到用户 "${username}"`); process.exit(2); }
    const created = new Date(a.created_at).toLocaleString('zh-CN', { hour12: false });
    const last = a.last_login_at ? new Date(a.last_login_at).toLocaleString('zh-CN', { hour12: false }) : '(从未登录)';
    console.log('\n  ✓ 找到账号\n');
    console.log('  ID:           ' + a.id);
    console.log('  用户名:       ' + a.username);
    console.log('  类型:         ' + (a.kind || 'registered'));
    console.log('  创建时间:     ' + created);
    console.log('  最近登录:     ' + last);
    console.log('  登录次数:     ' + (a.login_count || 0));
    console.log('  来源邀请码:   ' + (a.promoted_from_code || '(无)'));
    console.log('  状态:         ' + (a.revoked ? '已吊销' : '有效'));
    console.log();
  } else if (cmd === 'revoke-account') {
    const id = rest[0];
    if (!id) { console.error('请提供账号 ID'); process.exit(1); }
    const ok = await accountsLib.revoke(id);
    console.log(ok ? `  ✓ 已吊销账号 ${id}` : `  ✗ 没找到 ${id}`);
  } else if (cmd === 'help' || !cmd) {
    console.log(`
  Prompt Vault 管理工具

  命令:
    generate [--label <name>] [--note <text>] [--years <n>]
        生成新邀请码。明文只显示一次，请立即复制。
        --years 默认 10，自买家首次登录起算会员时长。

    batch-generate <count> [--label <name>] [--note <text>] [--years <n>]
        批量生成 1..200 个邀请码。明文一次性显示并写入 batch-codes-<timestamp>.json。
        适用于批量打包卖给闲鱼/淘宝买家。

    list
        列出所有邀请码及使用情况。

    revoke <id>
        吊销某个邀请码（让其无法再登录）。

    verify <plaintext>
        检查某个明文码是否还有效（用于客服验证买家发来的码）。

    accounts
        列出所有用户名密码账号。

    lookup-account <username>
        按用户名查找账号。

    revoke-account <account-id>
        吊销某个账号（让其无法用密码登录）。

  示例:
    node admin.js generate --label "闲鱼用户A" --note "订单 #20260707-A1" --years 10
    node admin.js batch-generate 50 --label "闲鱼批量" --note "7月活动" --years 10
    node admin.js list
    node admin.js revoke c_lpc1whg2d2_ab12
    node admin.js verify ABCDE-FGHIJ-...
    node admin.js lookup-account alice
    node admin.js revoke-account u_abc123
`);
  } else {
    console.error('  ✗ 未知命令: ' + cmd + ' — 用 `node admin.js help` 查看帮助');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); })
  .finally(() => closePool().catch(() => {}));
