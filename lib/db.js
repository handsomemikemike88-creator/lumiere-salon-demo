'use strict';
// PostgreSQL access (pg driver). All queries are parameterised. `tx(fn)` runs fn(client) in one transaction.
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v);                 // DATE -> 'YYYY-MM-DD' string (no timezone shifting)
types.setTypeParser(20, v => parseInt(v, 10));     // bigint (count) -> number
types.setTypeParser(1700, v => parseFloat(v));     // numeric -> number

function create(cfg) {
  const ssl = cfg.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : cfg.DATABASE_SSL === 'no-verify' ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: cfg.DB_POOL_MAX || 10, ssl, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  pool.on('error', () => { /* idle client errors are surfaced on next query */ });
  const q = (sql, params, client) => (client || pool).query(sql, params);
  const one = async (sql, params, client) => (await q(sql, params, client)).rows[0] || null;
  const all = async (sql, params, client) => (await q(sql, params, client)).rows;
  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (x) { /* ignore */ } throw e; }
    finally { c.release(); }
  }
  return { pool, q, one, all, tx, close: () => pool.end(), ping: () => pool.query('select 1 as ok') };
}
module.exports = { create };
