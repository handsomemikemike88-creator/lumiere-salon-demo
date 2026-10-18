'use strict';
// Entry point: validate config (fail fast) -> migrate -> boot -> serve. Graceful shutdown on SIGTERM/SIGINT.
const env = require('./lib/env');
env.loadEnvFile();
let cfg;
try { cfg = env.load(process.env); } catch (e) { console.error('\n' + e.message + '\n\n伺服器不會啟動。請修正 .env 或環境變數（參考 .env.example）。'); process.exit(1); }
const { createApp } = require('./lib/app');
(async () => {
  const app = await createApp(cfg);
  try { await app.start(); } catch (e) { app.ctx.log.error('startup failed', { err: e.message }); console.error('啟動失敗：' + e.message); process.exit(1); }
  let closing = false;
  const shutdown = sig => { if (closing) return; closing = true; app.ctx.log.info('shutting down', { signal: sig }); const t = setTimeout(() => process.exit(1), 15000); t.unref(); app.stop().then(() => process.exit(0)).catch(() => process.exit(1)); };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', e => app.ctx.log.error('unhandledRejection', { err: e && e.message }));
})();
