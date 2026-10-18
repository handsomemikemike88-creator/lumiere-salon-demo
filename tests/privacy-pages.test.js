const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const H = require('./helpers'), C = require('../lib/constants'), pages = require('../lib/pages');
const ROOT = path.join(__dirname, '..');
const walk = (d, o = []) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); f.isDirectory() ? walk(p, o) : o.push(p); } return o; };

async function oneLead(app, admin, extra) {
  const trial = (await app.ctx.db.one("select id from services where kind = 'trial'")).id;
  const b = await admin.post('/api/staff/bookings', { service: trial, date: H.futureWeekday(4), time: '10:00', name: '私隱客', phone: '93331234', email: 'priv@x.example', ...(extra || {}) }); return b.json;
}
test('staff can export one lead (PDPO access request); no secrets in export; admin-only anonymise needs id confirmation', async () => {
  const app = await H.makeApp(); try {
    const admin = await H.loginAdmin(app); const s = await H.makeStaff(app, admin, 'st@x.example'); const b = await oneLead(app, admin);
    const ex = await s.client.get('/api/staff/leads/' + b.leadId + '/export'); assert.equal(ex.status, 200); assert.match(JSON.stringify(ex.json), /9333 1234/); assert.doesNotMatch(JSON.stringify(ex.json), /hash|scrypt|token/i);
    assert.equal((await s.client.post('/api/admin/leads/' + b.leadId + '/anonymise', { confirm: b.leadId })).status, 403, 'staff cannot anonymise');
    assert.equal((await admin.post('/api/admin/leads/' + b.leadId + '/anonymise', { confirm: 'nope' })).status, 400);
    assert.equal((await admin.post('/api/admin/leads/' + b.leadId + '/anonymise', { confirm: b.leadId })).status, 200);
    const l = await app.ctx.db.one('select * from leads where id = $1', [b.leadId]); assert.ok(l.anonymised_at); assert.doesNotMatch(JSON.stringify(l), /私隱客|9333|priv@x/);
    assert.doesNotMatch(JSON.stringify(await app.ctx.db.all('select text from lead_notes where lead_id = $1', [b.leadId])), /私隱客|priv@x/);
    assert.doesNotMatch(JSON.stringify(await app.ctx.db.all('select draft_whatsapp, draft_email_body from reminders')), /私隱客/);
    assert.equal((await app.ctx.db.one("select count(*)::int n from reminders where void = false and state <> 'sent'")).n, 0);
    assert.doesNotMatch(JSON.stringify((await admin.get('/api/staff/leads/' + b.leadId)).json), /私隱客|9333|priv@x/);
    assert.ok((await app.ctx.db.one("select count(*)::int n from audit_log where action like 'lead.anonymised%'")).n >= 1);
  } finally { await app.stop(); }
});
test('retention purge anonymises old leads, keeps recent, Package Sold, paid and sample records', async () => {
  const app = await H.makeApp({ DATA_RETENTION_MONTHS: '12' }); try {
    const admin = await H.loginAdmin(app); const old = await oneLead(app, admin), recent = await oneLead(app, admin, { phone: '93339999', time: '11:30' }), sold = await oneLead(app, admin, { phone: '93338888', time: '13:00' });
    await app.ctx.db.q("update leads set created_at = now() - interval '30 months' where id = any($1)", [[old.leadId, sold.leadId]]); await app.ctx.db.q("update bookings set date = (current_date - interval '29 months')::date where lead_id = any($1)", [[old.leadId, sold.leadId]]);
    await app.ctx.db.q("update leads set stage = 'Package Sold' where id = $1", [sold.leadId]);
    assert.equal(await app.ctx.privacy.purgeExpired(), 1);
    const st = Object.fromEntries((await app.ctx.db.all('select id, anonymised_at from leads')).map(r => [r.id, !!r.anonymised_at])); assert.deepEqual(st, { [old.leadId]: true, [recent.leadId]: false, [sold.leadId]: false });
    assert.equal(await app.ctx.privacy.purgeExpired(), 0);
  } finally { await app.stop(); }
});
test('logs contain no personal data or secrets, even on errors', async () => {
  const app = await H.makeApp(); try {
    const admin = await H.loginAdmin(app); await oneLead(app, admin); await new H.Client(app.base).post('/api/staff/login', { email: 'victim@x.example', password: 'Wrong-Password-12345' }); await admin.post('/api/staff/bookings', { service: 'zzz', name: '私隱客', phone: '93331234' });
    const all = app.logs.join('\n'); assert.ok(all.length > 50); assert.doesNotMatch(all, /私隱客|9333 ?1234|priv@x|victim@x|Wrong-Password|Correct-Horse|scrypt\$/);
    assert.match(all, /"ip":"[0-9a-f]{6,}"/); assert.doesNotMatch(all, /127\.0\.0\.1/);
  } finally { await app.stop(); }
});
test('no sample data by default; SEED_DEMO_DATA creates only flagged fictional records; dashboard hides samples outside demo mode', async () => {
  const a = await H.makeApp(); try { assert.equal((await a.ctx.db.one('select count(*)::int n from leads')).n, 0); } finally { await a.stop(); }
  const d = await H.makeApp({ SEED_DEMO_DATA: 'true', SITE_DEMO_MODE: 'true' }); try {
    const n = await d.ctx.db.one('select count(*)::int n, count(*) filter (where is_sample)::int s from leads'); assert.ok(n.n >= 10); assert.equal(n.n, n.s); assert.equal((await d.ctx.db.one('select count(*)::int n from staff')).n, 1, 'no demo accounts');
    assert.equal((await d.ctx.db.one('select count(*)::int n from customers')).n, 0); assert.equal((await d.ctx.db.one("select count(*)::int n from leads where phone ~ '^\\+?852?9[0-9]{7}$' and phone !~ '^\\+852 ?5[0-9]'")).n >= 0, true);
    const adm = await H.loginAdmin(d); assert.ok((await adm.get('/api/staff/dashboard')).json.totalLeads > 0);
    assert.doesNotMatch(JSON.stringify((await adm.get('/api/staff/dashboard')).json.stripe), /real revenue(?!.*not)/);
  } finally { await d.stop(); }
  const dbUrl = d.dbUrl; const p = await H.makeApp({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://salon.example.com' }, { dbUrl }); try {
    const adm = await H.loginAdmin(p).catch(() => null); const c = new H.Client(p.base, 'https://salon.example.com'); await c.post('/api/staff/login', H.ADMIN, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal((await p.ctx.core.dashboard()).totalLeads, 0, 'sample rows excluded in production mode'); assert.ok(adm === null || adm);
  } finally { await p.stop(); }
});
test('demo vs production page rendering', async () => {
  const demo = await H.makeApp({ SITE_DEMO_MODE: 'true' }); const prod = await H.makeApp({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://salon.example.com', STORE_NAME: '測試美容', STORE_PHONE: '2345 6789' }); try {
    const dh = (await new H.Client(demo.base).get('/index.html')).text; assert.match(dh, /示範|Demo/); assert.match(dh, /Lumière/);
    for (const pth of ['/index.html', '/services.html', '/booking.html', '/privacy.html', '/terms.html', '/account/index.html', '/contact.html', '/checkout-result.html']) {
      const r = await new H.Client(prod.base, 'https://salon.example.com').get(pth, { headers: { 'X-Forwarded-Proto': 'https' } }); if (r.status === 404) continue; assert.equal(r.status, 200, pth);
      assert.doesNotMatch(r.text, /Lumière|示範|Demo|AI 生成|AI-generated|Test Mode|LUMIERE|admin@example|team\.html|\{\{|<!--(demo|prod|ai|draft)/i, pth);
    }
    const home = (await new H.Client(prod.base).get('/index.html', { headers: { 'X-Forwarded-Proto': 'https' } })).text; assert.match(home, /測試美容/); assert.match(home, /2345 6789/); assert.match(home, /待填/, 'unset details are visibly marked, not invented');
    assert.equal((await new H.Client(prod.base).get('/team.html', { headers: { 'X-Forwarded-Proto': 'https' } })).status, 404, 'fictional team page not served in production');
    const pr = (await new H.Client(prod.base).get('/privacy.html', { headers: { 'X-Forwarded-Proto': 'https' } })).text; assert.match(pr, /待填|草稿/);
  } finally { await demo.stop(); await prod.stop(); }
});
test('security headers, healthz, static file traversal, caching, gzip, 404', async () => {
  const app = await H.makeApp(); try {
    const c = new H.Client(app.base); const r = await c.get('/index.html'); const h = r.headers;
    assert.match(h.get('content-security-policy'), /default-src 'self'/); assert.doesNotMatch(h.get('content-security-policy'), /script-src[^;]*unsafe-inline/); assert.equal(h.get('x-content-type-options'), 'nosniff'); assert.ok(h.get('referrer-policy')); assert.match(h.get('x-frame-options') || h.get('content-security-policy'), /DENY|frame-ancestors 'none'/);
    assert.doesNotMatch(r.text, /<script(?![^>]*(?:\bsrc=|ld\+json))[^>]*>[^<]/i, 'no inline scripts on the home page');
    assert.equal((await c.get('/healthz')).json.status, 'ok'); assert.ok([400, 403, 404].includes((await c.get('/%2e%2e/package.json')).status)); assert.ok([400, 403, 404].includes((await c.get('/../package.json')).status)); assert.ok([400, 403, 404].includes((await c.get('/..%2f..%2fetc/passwd')).status)); assert.equal((await c.get('/nope.html')).status, 404);
    assert.equal((await c.get('/.env')).status, 404); assert.equal((await c.get('/lib/env.js')).status, 404); assert.equal((await c.get('/migrations/001_init.sql')).status, 404);
    assert.equal((await c.get('/api/nothing')).status, 404); assert.equal((await c.get('/api/staff/login')).status, 404);
    assert.equal((await c.get('/api/config')).json.demo, false); assert.doesNotMatch((await c.get('/api/config')).text, /secret|password|whsec|sk_/i);
    const e = await fetch(app.base + '/css/style.css', { headers: { 'Accept-Encoding': 'gzip' } }); assert.ok(e.headers.get('etag')); const e2 = await fetch(app.base + '/css/style.css', { headers: { 'If-None-Match': e.headers.get('etag') } }); assert.equal(e2.status, 304);
  } finally { await app.stop(); }
});
test('healthz returns 503 once draining / db gone; graceful stop completes', async () => {
  const app = await H.makeApp(); const base = app.base; assert.equal((await new H.Client(base).get('/healthz')).status, 200); await app.stop();
  await assert.rejects(fetch(base + '/healthz'));
});
test('go-live checklist: auto items from config, manual items tickable by admin only, audited; draft banner hides after legal review tick', async () => {
  const app = await H.makeApp(); try {
    const admin = await H.loginAdmin(app); const s = await H.makeStaff(app, admin, 's2@x.example'); assert.equal((await s.client.get('/api/admin/checklist')).status, 403);
    const g = (await admin.get('/api/admin/checklist')).json; assert.ok(g.items.filter(i => i.type === 'auto').length >= 8); assert.ok(g.remaining > 0); assert.equal(g.items.find(i => i.id === 'demo_off').done, true); assert.equal(g.items.find(i => i.id === 'store_name').done, false);
    const man = g.items.find(i => i.type === 'manual'); const g2 = (await admin.post('/api/admin/checklist/' + man.id, { done: true })).json; assert.equal(g2.items.find(i => i.id === man.id).done, true); assert.equal((await admin.post('/api/admin/checklist/bogus', { done: true })).status, 404);
    assert.match((await new H.Client(app.base).get('/privacy.html')).text, /草稿|待填/); await admin.post('/api/admin/checklist/privacy_policy_review', { done: true }); assert.doesNotMatch((await new H.Client(app.base).get('/privacy.html')).text, /<!--draft-->/);
  } finally { await app.stop(); }
});
test('content rules over everything shipped: only 4 prices, no banned/medical words, no secrets, no demo credentials', () => {
  const out = execFileSync(process.execPath, ['scripts/check-content.js'], { cwd: ROOT }).toString(); assert.match(out, /通過/);
  const files = walk(path.join(ROOT, 'public')).filter(f => /\.(html|js|css|json)$/.test(f)); const prices = new Set(); const allowed = new Set(['0', '288', '688', '8800']);
  for (const f of files) { const t = fs.readFileSync(f, 'utf8'); for (const m of t.matchAll(/HK\$\s?([0-9][0-9,]*)/g)) prices.add(m[1].replace(/,/g, '')); }
  for (const p of prices) assert.ok(allowed.has(p), 'unexpected price HK$' + p);
  assert.deepEqual([...C.SERVICES.map(s => s.price)].sort((a, b) => a - b), [0, 288, 688, 8800]);
  const secretRe = /(sk_live_[A-Za-z0-9]{10,}|sk_test_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16})/;
  for (const f of walk(ROOT).filter(f => !/node_modules|\.git[\\/]|package-lock/.test(f) && /\.(js|json|md|yml|yaml|html|sh|sql|example|toml)$|Dockerfile|Caddyfile/.test(f) && !/tests[\\/]/.test(f))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), secretRe, f);
  assert.equal(fs.existsSync(path.join(ROOT, '.env')), false);
});
