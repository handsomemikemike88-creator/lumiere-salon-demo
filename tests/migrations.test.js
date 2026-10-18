const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const H = require('./helpers'), migrate = require('../lib/migrate'), dbMod = require('../lib/db'), env = require('../lib/env');

test('migrations create schema, indexes, constraints; are idempotent', async () => {
  const url = await H.createDatabase(); const cfg = env.load(H.baseEnv(url)); const db = dbMod.create(cfg);
  try {
    const a = await migrate.run(db, null); assert.deepEqual(a, ['001_init.sql']);
    assert.deepEqual(await migrate.run(db, null), []);
    const tables = (await db.all("select tablename from pg_tables where schemaname = 'public'")).map(r => r.tablename);
    for (const t of ['staff', 'customers', 'sessions', 'invitations', 'password_resets', 'leads', 'lead_notes', 'lead_history', 'bookings', 'slot_caps', 'reminders', 'reminder_deliveries', 'suppression_list', 'payments', 'processed_events', 'audit_log', 'settings', 'services', 'schema_migrations']) assert.ok(tables.includes(t), 'missing table ' + t);
    const idx = (await db.all("select indexname from pg_indexes where schemaname = 'public'")).map(r => r.indexname);
    for (const i of ['bookings_slot_idx', 'leads_stage_idx', 'payments_one_paid', 'payments_one_pending', 'sessions_user_idx', 'audit_at_idx', 'reminders_state_idx']) assert.ok(idx.includes(i), 'missing index ' + i);
    // price constraint: only the four allowed prices
    await assert.rejects(db.q("insert into services(id,name,kind,price_hkd) values ('x','x','trial',999)"), /check/);
    // processed_events is unique per event id
    await db.q("insert into processed_events(event_id,type) values ('evt_1','t')"); await assert.rejects(db.q("insert into processed_events(event_id,type) values ('evt_1','t')"), /duplicate key/);
  } finally { await db.close(); }
});
test('modified applied migration is detected; failed migration rolls back', async () => {
  const url = await H.createDatabase(); const cfg = env.load(H.baseEnv(url)); const db = dbMod.create(cfg); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  try {
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'create table a1(id int);'); await migrate.run(db, null, dir);
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'create table a1(id int, x int);'); await assert.rejects(migrate.run(db, null, dir), /modified after being applied/);
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'create table a1(id int);'); fs.writeFileSync(path.join(dir, '002_bad.sql'), 'create table b1(id int); select * from nope;');
    await assert.rejects(migrate.run(db, null, dir), /002_bad.sql failed/);
    assert.equal((await db.one("select to_regclass('b1') as r")).r, null);
  } finally { await db.close(); }
});
test('app boot runs migrations automatically and syncs the service menu (single source of prices)', async () => {
  const app = await H.makeApp(); try {
    const s = await app.ctx.db.all('select id, price_hkd from services order by sort'); assert.deepEqual(s.map(x => x.price_hkd), [0, 688, 288, 8800]);
    const cfg = await new H.Client(app.base).get('/api/config'); assert.deepEqual(cfg.json.services.map(x => x.priceLabel), ['HK$0', 'HK$688', 'HK$288', 'HK$8,800']);
  } finally { await app.stop(); }
});
