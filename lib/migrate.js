'use strict';
// Plain-SQL migrations in /migrations (NNN_name.sql), applied in order, each in a transaction,
// recorded in schema_migrations. An advisory lock prevents two instances migrating at once.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DIR = path.join(__dirname, '..', 'migrations');
async function run(db, log, dir) {
  dir = dir || DIR;
  const files = fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const c = await db.pool.connect(); const applied = [];
  try {
    await c.query('select pg_advisory_lock(727001)');
    await c.query('create table if not exists schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())');
    const done = new Map((await c.query('select name, checksum from schema_migrations')).rows.map(r => [r.name, r.checksum]));
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8'), sum = crypto.createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) { if (done.get(f) !== sum) throw new Error('Migration ' + f + ' was modified after being applied. Add a new migration instead.'); continue; }
      try { await c.query('BEGIN'); await c.query(sql); await c.query('insert into schema_migrations(name, checksum) values ($1,$2)', [f, sum]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK'); throw new Error('Migration ' + f + ' failed: ' + e.message); }
      applied.push(f); if (log) log.info('migration applied', { file: f });
    }
  } finally { try { await c.query('select pg_advisory_unlock(727001)'); } catch (e) { /* ignore */ } c.release(); }
  return applied;
}
module.exports = { run, DIR };
