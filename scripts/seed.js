'use strict';
// npm run seed  -> loads SAMPLE data (all flagged is_sample). Refuses unless SEED_DEMO_DATA=true.
(async () => {
  const ctx = await require('./_ctx')();
  if (!ctx.cfg.SEED_DEMO_DATA) { console.error('已拒絕：請先設定 SEED_DEMO_DATA=true（樣本資料預設關閉，正式營運不應載入）。'); process.exit(1); }
  const r = await require('../lib/seed')(ctx)(); console.log(r.seeded ? '已載入 ' + r.rows + ' 筆樣本客戶（SAMPLE DATA，is_sample=true）。' : '略過：' + r.reason); await ctx.db.close();
})().catch(e => { console.error('失敗：' + e.message); process.exit(1); });
