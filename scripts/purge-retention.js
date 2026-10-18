'use strict';
// npm run purge-retention  -> anonymises leads with no booking activity for DATA_RETENTION_MONTHS (default 24). Run monthly via cron.
(async () => { const ctx = await require('./_ctx')(); const n = await ctx.privacy.purgeExpired(); console.log('已匿名化 ' + n + ' 位逾期客戶（保留期 ' + ctx.cfg.DATA_RETENTION_MONTHS + ' 個月；Package Sold／有付款紀錄者不受影響）。'); await ctx.db.close(); })().catch(e => { console.error('失敗：' + e.message); process.exit(1); });
