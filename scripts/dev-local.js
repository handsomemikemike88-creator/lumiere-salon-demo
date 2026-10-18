'use strict';
// LOCAL TRYOUT ONLY (Windows/Mac/Linux, no Postgres install needed): starts a throw-away-able PostgreSQL via the
// `embedded-postgres` dev dependency (data in ./.devdb) and runs the app in DEMO mode with sample data.
//   npm install      (once, with dev dependencies)      then      npm run dev
// Open http://localhost:3000 . A random local admin password is generated on first run and printed (stored in .devdb/admin-password).
const path = require('path'), fs = require('fs');
(async () => {
  const EmbeddedPostgres = (await import('embedded-postgres')).default;
  const dir = path.join(__dirname, '..', '.devdb'), port = 54329, first = !fs.existsSync(path.join(dir, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true, onLog: () => { }, onError: () => { } });
  if (first) await pg.initialise(); await pg.start(); if (first) await pg.createDatabase('salon');
  const pwFile = path.join(dir, 'admin-password'); if (!fs.existsSync(pwFile)) fs.writeFileSync(pwFile, require('crypto').randomBytes(12).toString('base64url') + '-Aa1', { mode: 0o600 }); const adminPw = fs.readFileSync(pwFile, 'utf8').trim();
  Object.assign(process.env, { NODE_ENV: 'development', PORT: process.env.PORT || '3000', DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/salon`, APP_SECRET: 'local-dev-only-secret-local-dev-only-secret',
    ADMIN_EMAIL: 'admin@local.test', ADMIN_PASSWORD: adminPw, SITE_DEMO_MODE: 'true', SEED_DEMO_DATA: 'true', HOST: '127.0.0.1', LOG_LEVEL: 'info' });
  const env = require('../lib/env'), { createApp } = require('../lib/app'); const app = await createApp(env.load(process.env)); await app.start();
  console.log('\n本機試用已啟動： http://localhost:' + process.env.PORT + '  \n員工登入 http://localhost:' + process.env.PORT + '/staff/login.html\n  電郵：admin@local.test\n  密碼：' + adminPw + '\n（只限本機試用）\n按 Ctrl+C 停止。');
  const stop = async () => { await app.stop(); await pg.stop(); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
})().catch(e => { console.error(e); process.exit(1); });
