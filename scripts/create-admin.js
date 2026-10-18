'use strict';
// npm run create-admin -- --email you@example.com [--name "Your Name"]   (password is prompted; or env ADMIN_PASSWORD)
const readline = require('readline');
const arg = k => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : undefined; };
function askHidden(q) {
  return new Promise(ok => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true }); const out = rl.output; rl._writeToOutput = s => { if (s.includes(q)) out.write(s); else if (/[\r\n]/.test(s)) out.write(s); };
    rl.question(q, a => { rl.close(); ok(a); });
  });
}
(async () => {
  const ctx = await require('./_ctx')();
  const email = arg('email') || process.env.ADMIN_EMAIL; if (!email) { console.error('用法：npm run create-admin -- --email you@example.com [--name 姓名]'); process.exit(1); }
  let pw = process.env.ADMIN_PASSWORD; if (!pw) { pw = await askHidden('密碼（最少 12 個字元）：'); }
  const r = await ctx.auth.createAdmin(email, pw, arg('name') || process.env.ADMIN_NAME || '管理員');
  console.log(r.created ? '已建立管理員帳戶：' + email : '此電郵已存在，沒有更改任何東西。'); await ctx.db.close();
})().catch(e => { console.error('失敗：' + e.message); process.exit(1); });
