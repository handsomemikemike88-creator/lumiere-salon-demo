'use strict';
// Test runner: uses TEST_PG_ADMIN_URL (any PostgreSQL, e.g. postgres://postgres:pw@localhost:5432/postgres) if set,
// otherwise starts a throw-away real PostgreSQL via the `embedded-postgres` npm package, then runs `node --test`.
const { spawn } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
(async () => {
  let pg = null, adminUrl = process.env.TEST_PG_ADMIN_URL, dir = null;
  if (!adminUrl) {
    const EmbeddedPostgres = (await import('embedded-postgres')).default;
    dir = path.join(os.tmpdir(), 'salon-pg-' + process.pid + '-' + Date.now()); const port = 54000 + Math.floor(Math.random() * 900);
    pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: process.env.PG_DEBUG ? console.log : () => { }, onError: process.env.PG_DEBUG ? console.error : () => { } });
    await pg.initialise(); await pg.start(); adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    console.log('# test database: embedded-postgres (real PostgreSQL) on port ' + port);
  } else console.log('# test database: TEST_PG_ADMIN_URL');
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).map(f => path.join('tests', f));
  const args = ['--test', '--test-concurrency=4', ...(process.argv.slice(2).length ? process.argv.slice(2) : files)];
  const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..'), env: { ...process.env, TEST_PG_ADMIN_URL: adminUrl } });
  child.on('exit', async code => { if (pg) { try { await pg.stop(); } catch (e) { /* ignore */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } } process.exit(code); });
})().catch(e => { console.error(e); process.exit(1); });
