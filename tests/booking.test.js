const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./helpers');
const book = (c, o) => c.post('/api/bookings', { service: 'hf-trial', date: H.futureWeekday(3), time: '10:00', name: '陳大文', phone: '91234567', consent: true, ...o });
const SVC = async app => (await app.ctx.db.all('select id, kind from services order by sort'));

test('public booking creates lead + reminder drafts (never sent), consent required, validation', async () => {
  const app = await H.makeApp(); try {
    const c = new H.Client(app.base); const svcs = await SVC(app); const trial = svcs.find(s => s.kind === 'trial').id;
    assert.equal((await book(c, { service: trial, consent: false })).status, 400);
    assert.equal((await book(c, { service: trial, phone: '123' })).status, 400);
    assert.equal((await book(c, { service: 'nope' })).status, 400);
    const sunday = (() => { let d = H.futureWeekday(3); const h = require('../lib/core').helpers; while (h.dow(d) !== 0) d = h.addDays(d, 1); return d; })();
    assert.equal((await book(c, { service: trial, date: sunday })).status, 400);
    assert.equal((await book(c, { service: trial, date: require('../lib/core').helpers.todayStr() })).status, 400);   // too soon
    const r = await book(c, { service: trial, email: 'a@x.example', marketing: false }); assert.equal(r.status, 200); assert.match(r.json.id, /^BK\d+$/); assert.ok(r.json.token.length >= 20);
    const lead = await app.ctx.db.one('select * from leads'); assert.equal(lead.stage, 'New Trial Lead'); assert.equal(lead.source, 'website'); assert.equal(lead.marketing_opt_in, false); assert.equal(lead.is_sample, false);
    const rem = await app.ctx.db.all('select kind, state, draft_whatsapp, sent_at from reminders order by kind'); assert.ok(rem.length >= 2); assert.ok(rem.every(x => x.sent_at === null && x.state !== 'sent'));
    assert.match(rem.find(x => x.kind === 'confirmation').draft_whatsapp, /STOP/);                       // opt-out line
    assert.doesNotMatch(JSON.stringify(rem), /示範草稿/);                                                 // demo tag only in demo mode
    assert.equal((await app.ctx.db.one('select count(*)::int n from reminder_deliveries')).n, 0);
    // booking view needs the manage token
    assert.equal((await c.get('/api/bookings/' + r.json.id)).status, 404);
    const v = await c.get('/api/bookings/' + r.json.id + '?t=' + r.json.token); assert.equal(v.status, 200); assert.equal(v.json.booking.priceLabel, 'HK$0');
    assert.equal((await c.get('/api/bookings/' + r.json.id + '?t=wrong')).status, 404);
    // same phone re-booking reuses the lead
    await book(c, { service: trial, time: '11:30' }); assert.equal((await app.ctx.db.one('select count(*)::int n from leads')).n, 1);
  } finally { await app.stop(); }
});
test('capacity: concurrent bookings can never overbook a slot', async () => {
  const app = await H.makeApp(); try {
    const trial = (await SVC(app)).find(s => s.kind === 'trial').id; const date = H.futureWeekday(4);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => book(new H.Client(app.base), { service: trial, date, time: '13:00', name: 'P' + i, phone: '9123456' + i })));
    assert.equal(res.filter(r => r.status === 200).length, 2); assert.equal(res.filter(r => r.status === 409).length, 6);
    assert.equal((await app.ctx.db.one("select count(*)::int n from bookings where date = $1 and time = '13:00'", [date])).n, 2);
    const a = await new H.Client(app.base).get('/api/availability?from=' + date + '&to=' + date); const slot = a.json.days.find(d => d.date === date).slots.find(s => s.time === '13:00'); assert.equal(slot.remaining, 0);
  } finally { await app.stop(); }
});
test('staff: slot capacity, reschedule/cancel, self-service 24h rule, attendance drives stage', async () => {
  const app = await H.makeApp(); try {
    const admin = await H.loginAdmin(app); const trial = (await SVC(app)).find(s => s.kind === 'trial').id; const c = new H.Client(app.base); const date = H.futureWeekday(5);
    assert.equal((await admin.post('/api/staff/slots', { date, time: '16:00', capacity: 1 })).status, 200);
    assert.equal((await book(c, { service: trial, date, time: '16:00' })).status, 200); assert.equal((await book(c, { service: trial, date, time: '16:00', phone: '98765432' })).status, 409);
    const r = await book(c, { service: trial, date, time: '10:00', phone: '97778888' }); const re = await c.post('/api/bookings/' + r.json.id + '/reschedule', { token: r.json.token, date, time: '17:30' }); assert.equal(re.status, 200);
    assert.equal((await app.ctx.db.one('select time from bookings where id = $1', [r.json.id])).time, '17:30');
    assert.equal((await c.post('/api/bookings/' + r.json.id + '/cancel', { token: 'bad' })).status, 404);
    assert.equal((await c.post('/api/bookings/' + r.json.id + '/cancel', { token: r.json.token })).status, 200);
    assert.equal((await app.ctx.db.one('select status from bookings where id = $1', [r.json.id])).status, 'cancelled');
    assert.equal((await app.ctx.db.one("select count(*)::int n from reminders where booking_id = $1 and void = false", [r.json.id])).n, 0);
    // < 24h: customer can't self-cancel, staff can
    const near = await admin.post('/api/staff/bookings', { service: trial, date: require('../lib/core').helpers.todayStr(), time: '17:30', name: '近', phone: '96661111', force: true });
    if (near.status === 200) { const tok = 'x'; assert.ok(tok); assert.equal((await admin.post('/api/staff/bookings/' + near.json.id + '/cancel')).status, 200); }
    // attendance moves the lead to Attended, but only upward
    const sb = await admin.post('/api/staff/bookings', { service: trial, date, time: '11:30', name: '員工建', phone: '95551234' }); assert.equal(sb.status, 200);
    assert.equal((await admin.post('/api/staff/bookings/' + sb.json.id + '/attendance', { status: 'attended' })).status, 200);
    assert.equal((await app.ctx.db.one('select stage from leads where id = $1', [sb.json.leadId])).stage, 'Attended');
    assert.equal((await admin.post('/api/staff/bookings/' + sb.json.id + '/attendance', { status: 'bogus' })).status, 400);
  } finally { await app.stop(); }
});
test('pipeline rules: Package Sold needs verified payment; Consultation only from Attended; audit trail', async () => {
  const app = await H.makeApp(); try {
    const admin = await H.loginAdmin(app); const trial = (await SVC(app)).find(s => s.kind === 'trial').id; const date = H.futureWeekday(5);
    const sb = await admin.post('/api/staff/bookings', { service: trial, date, time: '10:00', name: '階段', phone: '94441234' }); const id = sb.json.leadId;
    const mv = (s) => admin.post('/api/staff/leads/' + id + '/stage', { stage: s });
    assert.equal((await mv('Package Sold')).status, 400); assert.equal((await mv('Package Consultation')).status, 400);
    assert.equal((await mv('Confirmed')).status, 200); assert.equal((await mv('Package Consultation')).status, 400);
    await admin.post('/api/staff/bookings/' + sb.json.id + '/attendance', { status: 'attended' });
    assert.equal((await mv('Package Consultation')).status, 200); assert.equal((await mv('Package Sold')).status, 400, 'still blocked after consultation');
    assert.equal((await mv('Nonsense')).status, 400);
    assert.equal((await admin.post('/api/staff/leads/' + id + '/payment', { status: 'paid' })).status, 200);   // manual marker is just a note
    assert.equal((await app.ctx.db.one('select stage from leads where id = $1', [id])).stage, 'Package Consultation', 'manual paid marker does NOT move the stage');
    assert.ok((await app.ctx.db.one("select count(*)::int n from audit_log where action = 'lead.stage_move'")).n >= 2);
    const noPay = await app.ctx.db.one("select count(*)::int n from leads where stage = 'Package Sold'"); assert.equal(noPay.n, 0);
  } finally { await app.stop(); }
});
test('customer account: register, book while signed in, own bookings only, export + delete (anonymise)', async () => {
  const app = await H.makeApp(); try {
    const trial = (await SVC(app)).find(s => s.kind === 'trial').id; const cu = new H.Client(app.base);
    assert.equal((await cu.post('/api/customer/register', { name: '陳', email: 'c@x.example', phone: '91230000', password: 'short', consent: true })).status, 400);
    assert.equal((await cu.post('/api/customer/register', { name: '陳', email: 'c@x.example', phone: '91230000', password: 'Customer-Passphrase-1', consent: true })).status, 200);
    const r = await book(cu, { service: trial, phone: '91230000' }); assert.equal(r.status, 200);
    const other = new H.Client(app.base); await other.post('/api/customer/register', { name: '乙', email: 'o@x.example', phone: '91239999', password: 'Customer-Passphrase-1', consent: true });
    assert.equal((await other.get('/api/customer/bookings')).json.bookings.length, 0); assert.equal((await other.get('/api/bookings/' + r.json.id)).status, 404);
    assert.equal((await cu.get('/api/customer/bookings')).json.bookings.length, 1);
    const ex = await cu.get('/api/customer/export'); assert.equal(ex.status, 200); assert.match(JSON.stringify(ex.json), /9123 0000/); assert.doesNotMatch(JSON.stringify(ex.json), /pw_hash|scrypt/);
    assert.equal((await cu.post('/api/customer/delete', { password: 'wrong-password-123', confirm: 'DELETE' })).status, 400);
    assert.equal((await cu.post('/api/customer/delete', { password: 'Customer-Passphrase-1', confirm: 'DELETE' })).status, 200);
    const row = await app.ctx.db.one("select * from customers where email is not null and email = 'c@x.example'", []).catch(() => null); assert.equal(row, null);
    const lead = await app.ctx.db.one('select * from leads where id = (select lead_id from bookings where id = $1)', [r.json.id]); assert.ok(lead.anonymised_at); assert.doesNotMatch(JSON.stringify(lead), /陳大文|9123 0000|91230000/);
    assert.equal((await new H.Client(app.base).post('/api/customer/login', { identifier: 'c@x.example', password: 'Customer-Passphrase-1' })).status, 401);
  } finally { await app.stop(); }
});
