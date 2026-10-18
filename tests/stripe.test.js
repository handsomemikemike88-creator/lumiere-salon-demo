const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./helpers'), stripeLib = require('../lib/stripe'), env = require('../lib/env');
const WH = 'whsec_' + 'k'.repeat(24);

async function setup(extra, live) {
  const fs = await H.fakeStripe(); fs.state.live = !!live;
  const app = await H.makeApp({ STRIPE_SECRET_KEY: (live ? 'sk_live_' : 'sk_test_') + 'a'.repeat(24), STRIPE_WEBHOOK_SECRET: WH, STRIPE_API_BASE: fs.url, ...(extra || {}) });
  const admin = await H.loginAdmin(app); const trial = (await app.ctx.db.one("select id from services where kind = 'trial'")).id;
  const sb = await admin.post('/api/staff/bookings', { service: trial, date: H.futureWeekday(4), time: '10:00', name: '付款客', phone: '93331234' });
  const stage = async (leadId, s) => (await admin.post('/api/staff/leads/' + leadId + '/stage', { stage: s })).status;
  const ready = async () => { await admin.post('/api/staff/bookings/' + sb.json.id + '/attendance', { status: 'attended' }); await stage(sb.json.leadId, 'Package Consultation'); };
  const stop = async () => { await app.stop(); await fs.close(); };
  return { app, fs, admin, lead: sb.json.leadId, booking: sb.json.id, ready, stop };
}
const ev = (id, type, obj, live) => ({ id, type, livemode: !!live, data: { object: obj } });
const post = async (app, e, secret, mutate) => { const w = H.signedWebhook(e, secret || WH); const c = new H.Client(app.base); return c.req('POST', '/api/stripe/webhook', mutate ? mutate(w.raw) : w.raw, { raw: true, noOrigin: true, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': w.sig } }); };
const paidSession = (s, over) => ({ ...s, payment_status: 'paid', status: 'complete', payment_intent: 'pi_test_1', ...(over || {}) });

test('checkout requires Package Consultation stage; creates a hkd 8,800 session and stores it pending; reuses open link', async () => {
  const t = await setup(); try {
    assert.equal((await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout')).status, 400);
    await t.ready(); const r = await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout'); assert.equal(r.status, 200); assert.equal(r.json.reused, false);
    const call = t.fs.state.calls.find(c => c.url === '/v1/checkout/sessions' && c.method === 'POST'); assert.equal(call.auth, 'Bearer sk_test_' + 'a'.repeat(24)); const p = new URLSearchParams(call.body);
    assert.equal(p.get('line_items[0][price_data][unit_amount]'), '880000'); assert.equal(p.get('line_items[0][price_data][currency]'), 'hkd'); assert.equal(p.get('mode'), 'payment'); assert.equal(p.get('client_reference_id'), t.lead);
    const row = await t.app.ctx.db.one('select * from payments'); assert.equal(row.status, 'pending'); assert.equal(row.amount_minor, 880000); assert.equal(row.livemode, false);
    assert.equal((await t.app.ctx.db.one('select stage from leads where id = $1', [t.lead])).stage, 'Package Consultation', 'creating a link never moves the lead');
    assert.equal((await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout')).json.reused, true); assert.equal((await t.app.ctx.db.one('select count(*)::int n from payments')).n, 1);
    const renew = await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout', { renew: true }); assert.equal(renew.status, 200); assert.equal((await t.app.ctx.db.one("select count(*)::int n from payments where status = 'pending'")).n, 1);
  } finally { await t.stop(); }
});
test('webhook: bad / missing / stale signature and wrong secret rejected; nothing changes', async () => {
  const t = await setup(); try {
    await t.ready(); await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout'); const s = Object.values(t.fs.state.sessions)[0]; s.payment_status = 'paid';
    const e = ev('evt_1', 'checkout.session.completed', paidSession(s));
    assert.equal((await post(t.app, e, 'whsec_' + 'z'.repeat(24))).status, 400);
    assert.equal((await post(t.app, e, WH, raw => raw.replace('"evt_1"', '"evt_2"'))).status, 400, 'tampered body');
    const nosig = await new H.Client(t.app.base).req('POST', '/api/stripe/webhook', JSON.stringify(e), { raw: true, noOrigin: true, headers: { 'Content-Type': 'application/json' } }); assert.equal(nosig.status, 400);
    const raw = JSON.stringify(e); const old = stripeLib.signPayload(raw, WH, Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await new H.Client(t.app.base).req('POST', '/api/stripe/webhook', raw, { raw: true, noOrigin: true, headers: { 'Stripe-Signature': old } })).status, 400, 'replay outside tolerance');
    assert.equal((await t.app.ctx.db.one('select stage from leads where id = $1', [t.lead])).stage, 'Package Consultation'); assert.equal((await t.app.ctx.db.one('select count(*)::int n from processed_events')).n, 0);
  } finally { await t.stop(); }
});
test('webhook with valid signature: server re-retrieves session, moves to Package Sold once; duplicates + concurrent replays are idempotent', async () => {
  const t = await setup(); try {
    await t.ready(); await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout'); const s = Object.values(t.fs.state.sessions)[0];
    // webhook claims "paid" but Stripe (retrieved server side) says unpaid => must NOT apply
    const forged = ev('evt_forged', 'checkout.session.completed', paidSession(s)); const f = await post(t.app, forged); assert.equal(f.status, 200); assert.ok(f.json.rejected, JSON.stringify(f.json));
    assert.equal((await t.app.ctx.db.one('select stage from leads where id = $1', [t.lead])).stage, 'Package Consultation');
    s.payment_status = 'paid'; s.status = 'complete'; s.payment_intent = 'pi_test_1';
    const good = ev('evt_good', 'checkout.session.completed', paidSession(s));
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => post(t.app, good))); assert.ok(rs.every(r => r.status === 200)); assert.equal(rs.filter(r => r.json.applied).length, 1); assert.equal(rs.filter(r => r.json.duplicate).length, 4);
    assert.equal((await t.app.ctx.db.one('select stage from leads where id = $1', [t.lead])).stage, 'Package Sold');
    assert.equal((await t.app.ctx.db.one("select count(*)::int n from payments where status = 'paid'")).n, 1); assert.equal((await t.app.ctx.db.one("select count(*)::int n from lead_history where to_stage = 'Package Sold'")).n, 1);
    assert.equal((await post(t.app, good)).json.duplicate, true);
    assert.equal((await post(t.app, ev('evt_again', 'checkout.session.completed', paidSession(s)))).json.already, true, 'different event id, same payment => no double-apply');
    assert.equal((await t.app.ctx.db.one("select count(*)::int n from lead_history where to_stage = 'Package Sold'")).n, 1);
    const d = (await t.admin.get('/api/staff/dashboard')).json; assert.equal(d.stripe.count, 1); assert.match(d.stripe.modeLabel, /Test Mode/); assert.match(d.stripe.modeLabel, /not real/i);
    assert.equal((await t.admin.post('/api/staff/leads/' + t.lead + '/stage', { stage: 'Lost' })).status, 400, 'paid lead cannot be moved out of Package Sold');
    // later events
    assert.ok((await post(t.app, ev('evt_x', 'unknown.type', {}))).json.ignored);
    assert.equal((await post(t.app, ev('evt_ref', 'charge.refunded', { payment_intent: 'pi_test_1', refunded: true }))).json.updated, true);
    assert.equal((await t.app.ctx.db.one('select status from payments')).status, 'refunded'); assert.equal((await t.app.ctx.db.one('select stage from leads where id = $1', [t.lead])).stage, 'Package Sold');
  } finally { await t.stop(); }
});
test('payment validation: wrong amount / currency / metadata / session / livemode are all rejected', async () => {
  const cases = [['amount', s => { s.amount_total = 100; }], ['currency', s => { s.currency = 'usd'; }], ['metadata', s => { s.metadata.lead_id = 'L9999'; }], ['client_reference', s => { s.client_reference_id = 'L9999'; }], ['livemode', s => { s.livemode = true; }]];
  for (const [name, mut] of cases) {
    const t = await setup(); try {
      await t.ready(); await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout'); const s = Object.values(t.fs.state.sessions)[0]; s.payment_status = 'paid'; s.payment_intent = 'pi_1'; mut(s);
      const r = await post(t.app, ev('evt_' + name, 'checkout.session.completed', { ...s })); assert.equal(r.status, 200, name);
      assert.equal((await t.app.ctx.db.one('select stage from leads where id = $1', [t.lead])).stage, 'Package Consultation', name + ' must not move the lead'); assert.equal((await t.app.ctx.db.one("select count(*)::int n from payments where status = 'paid'")).n, 0, name);
      const v = await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-verify'); assert.equal(v.status, 409, name + ' staff verify also rejects');
      assert.equal((await t.app.ctx.db.one('select stage from leads where id = $1', [t.lead])).stage, 'Package Consultation');
    } finally { await t.stop(); }
  }
});
test('a live-mode event delivered to a test-mode system is ignored', async () => {
  const t = await setup(); try {
    await t.ready(); await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout'); const s = Object.values(t.fs.state.sessions)[0]; s.payment_status = 'paid';
    const r = await post(t.app, ev('evt_live', 'checkout.session.completed', paidSession(s, { livemode: true }), true)); assert.equal(r.json.ignored, 'livemode_mismatch');
    assert.equal((await t.app.ctx.db.one('select stage from leads where id = $1', [t.lead])).stage, 'Package Consultation');
  } finally { await t.stop(); }
});
test('staff "verify payment" re-reads session from Stripe: pending -> no change; paid -> Package Sold; expired handled', async () => {
  const t = await setup(); try {
    await t.ready(); await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout'); const s = Object.values(t.fs.state.sessions)[0];
    assert.equal((await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-verify')).json.result, 'pending');
    s.payment_status = 'paid'; s.status = 'complete'; s.payment_intent = 'pi_9'; const v = await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-verify'); assert.equal(v.json.result, 'paid'); assert.equal(v.json.lead.stage, 'Package Sold');
    assert.equal((await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-verify')).json.result, 'already_paid');
    assert.ok([400, 409].includes((await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout')).status), 'no second checkout for a paid lead');
  } finally { await t.stop(); }
});
test('webhook endpoint refuses (503) when no webhook secret; Stripe key missing => clear error and nothing stored', async () => {
  const app = await H.makeApp(); try {
    const w = H.signedWebhook({ id: 'evt_a', type: 'x', data: { object: {} } }, WH); assert.equal((await new H.Client(app.base).req('POST', '/api/stripe/webhook', w.raw, { raw: true, noOrigin: true, headers: { 'Stripe-Signature': w.sig } })).status, 503);
    const admin = await H.loginAdmin(app); const trial = (await app.ctx.db.one("select id from services where kind = 'trial'")).id; const sb = await admin.post('/api/staff/bookings', { service: trial, date: H.futureWeekday(4), time: '10:00', name: 'x', phone: '93331234' });
    await admin.post('/api/staff/bookings/' + sb.json.id + '/attendance', { status: 'attended' }); await admin.post('/api/staff/leads/' + sb.json.leadId + '/stage', { stage: 'Package Consultation' });
    const r = await admin.post('/api/staff/leads/' + sb.json.leadId + '/stripe-checkout'); assert.ok([400, 503].includes(r.status)); assert.equal((await app.ctx.db.one('select count(*)::int n from payments')).n, 0);
    assert.equal((await admin.get('/api/staff/stripe/status')).status, 200);
  } finally { await app.stop(); }
});
test('LIVE mode (explicit opt-in, fake API): live labels, cs_live_ prefix enforced, test-mode artefacts rejected', async () => {
  const live = { STRIPE_MODE: 'live', STRIPE_ALLOW_LIVE: 'yes' };
  const t = await setup(live, true); try {
    const cfg = (await new H.Client(t.app.base).get('/api/config')).json; assert.equal(cfg.stripe.live, true); assert.doesNotMatch(JSON.stringify(cfg), /sk_live|whsec/);
    await t.ready(); const r = await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout'); assert.equal(r.status, 200); const row = await t.app.ctx.db.one('select * from payments'); assert.match(row.session_id, /^cs_live_/); assert.equal(row.livemode, true);
    const p = new URLSearchParams(t.fs.state.calls.find(c => c.url === '/v1/checkout/sessions' && c.method === 'POST').body); assert.equal(p.get('metadata[sample_test_data]'), null);
    const s = Object.values(t.fs.state.sessions)[0]; s.payment_status = 'paid'; s.payment_intent = 'pi_live_1';
    assert.equal((await post(t.app, ev('evt_t', 'checkout.session.completed', paidSession(s, { livemode: false }), false))).json.ignored, 'livemode_mismatch');
    assert.equal((await post(t.app, ev('evt_l', 'checkout.session.completed', paidSession(s), true))).json.applied, true);
    const d = (await t.admin.get('/api/staff/dashboard')).json; assert.equal(d.stripe.live, true); assert.doesNotMatch(d.stripe.modeLabel, /Test Mode/); assert.equal(d.stripe.count, 1);
    assert.doesNotMatch(JSON.stringify((await t.admin.get('/api/staff/leads/' + t.lead)).json), /Test Mode|樣本資料/);
  } finally { await t.stop(); }
  // fake returns a TEST session while system is live => refused
  const fs = await H.fakeStripe(); fs.state.live = false; const app = await H.makeApp({ ...live, STRIPE_SECRET_KEY: 'sk_live_' + 'a'.repeat(24), STRIPE_WEBHOOK_SECRET: WH, STRIPE_API_BASE: fs.url }); try {
    const admin = await H.loginAdmin(app); const trial = (await app.ctx.db.one("select id from services where kind = 'trial'")).id; const sb = await admin.post('/api/staff/bookings', { service: trial, date: H.futureWeekday(4), time: '10:00', name: 'x', phone: '93331234' });
    await admin.post('/api/staff/bookings/' + sb.json.id + '/attendance', { status: 'attended' }); await admin.post('/api/staff/leads/' + sb.json.leadId + '/stage', { stage: 'Package Consultation' });
    assert.equal((await admin.post('/api/staff/leads/' + sb.json.leadId + '/stripe-checkout')).status, 502); assert.equal((await app.ctx.db.one('select count(*)::int n from payments')).n, 0);
  } finally { await app.stop(); await fs.close(); }
});
test('Stripe secrets never leak into logs or API responses', async () => {
  const t = await setup(); try {
    await t.ready(); const r = await t.admin.post('/api/staff/leads/' + t.lead + '/stripe-checkout'); const all = JSON.stringify(r.json) + JSON.stringify((await t.admin.get('/api/staff/stripe/status')).json) + t.app.logs.join('\n');
    assert.doesNotMatch(all, /sk_test_a{10}|whsec_k{10}/);
  } finally { await t.stop(); }
});
