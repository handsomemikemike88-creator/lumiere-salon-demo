'use strict';
// npm run migrate  -> applies pending SQL files from /migrations (also runs automatically at server start unless AUTO_MIGRATE=false)
require('./_ctx')({ migrate: false }).then(async ctx => {
  const applied = await require('../lib/migrate').run(ctx.db, null);
  console.log(applied.length ? '已套用 migrations：\n - ' + applied.join('\n - ') : '資料庫已是最新（沒有待套用的 migration）。');
  await ctx.db.close();
}).catch(e => { console.error('Migration 失敗：' + e.message); process.exit(1); });
