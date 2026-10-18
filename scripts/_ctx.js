'use strict';
// Shared bootstrap for CLI scripts: loads .env, validates config, connects to the DB (no HTTP server).
const env = require('../lib/env');
module.exports = async function bootstrap(opts) {
  opts = opts || {}; env.loadEnvFile();
  let cfg; try { cfg = env.load(process.env); } catch (e) { console.error(e.message); process.exit(1); }
  const logger = require('../lib/logger'); const log = logger.create(cfg.LOG_LEVEL);
  const ctx = { cfg, log, db: require('../lib/db').create(cfg), limiter: { close() { } } };
  ctx.providers = { email: null, whatsapp: null }; ctx.stripe = require('../lib/stripe')(cfg);
  ctx.audit = require('../lib/audit')(ctx); ctx.core = require('../lib/core')(ctx); ctx.auth = require('../lib/auth')(ctx); ctx.notify = require('../lib/notify')(ctx);
  ctx.privacy = require('../lib/privacy')(ctx);
  if (opts.migrate !== false) await require('../lib/migrate').run(ctx.db, log);
  return ctx;
};
