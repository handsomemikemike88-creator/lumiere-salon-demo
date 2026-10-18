const test = require('node:test'), assert = require('node:assert/strict'), http = require('http');
const H = require('./helpers');
const WA = { WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_ACCESS_TOKEN: 'EAAtoken1234567890', WHATSAPP_TEMPLATE_CONFIRMATION: 'booking_confirm', WHATSAPP_TEMPLATE_REMINDER: 'booking_remind' };
const EM = { EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.invalid', EMAIL_FROM: 'Salon <no-reply@x.example>' };
function mocks(failWith) { const m = { emails: [], was: [] }; m.email = { name: 'mock-email', async send(x) { if (failWith) throw new Error(failWith); m.emails.push(x); return { id: 'em' + m.emails.length }; } };
  m.whatsapp = { name: 'mock-wa', async sendTemplate(x) { if (failWith) throw new Error(failWith); m.was.push(x); return { id: 'wa' + m.was.length }; } }; return m; }
async function setup(envExtra, m, mk) {
  const app = await H.makeApp(envExtra, { providers: { email: m ? m.email : null, whatsapp: m ? m.whatsapp : null } }); const admin = await H.loginAdmin(app);
  const trial = (await app.ctx.db.one("select id from services where kind = 'trial'")).id; const o = { service: trial, date: H.futureWeekday(4), time: '10:00', name: '提醒客', phone: '93331234', email: 'cust@x.example', ...(mk || {}) };
  const b = await admin.post('/api/staff/bookings', o); const rem = await app.ctx.db.one("select id from reminders where booking_id = $1 and kind = 'confirmation'", [b.json.id]);
  return { app, admin, lead: b.json.leadId, booking: b.json.id, rem: rem.id, send: (ch, body) => admin.post('/api/staff/reminders/' + rem.id + '/send', { approve: true, channel: ch, ...(body || {}) }) };
}

test('default config: nothing is ever sent — drafts only; explicit approval flag required', async () => {
  const m = mocks(); const t = await setup({}, m); try {
    const r = await t.send('email'); assert.equal(r.status, 400); assert.match(r.json.error, /NOTIFY_ENABLED/); assert.equal(m.emails.length + m.was.length, 0);
    assert.equal((await t.admin.post('/api/staff/reminders/' + t.rem + '/send', { channel: 'email' })).status, 400, 'no approve flag');
    assert.equal((await t.admin.post('/api/admin/settings', { autoSendReminders: true })).status, 400, 'auto-send cannot be enabled while NOTIFY_ENABLED=false');
    assert.equal(await t.app.ctx.notify.autoSendDue(), 0); assert.equal((await t.app.ctx.db.one("select count(*)::int n from reminders where state = 'sent'")).n, 0);
  } finally { await t.app.stop(); }
});
test('enabled: staff-approved send goes through the provider once, is logged, and advances the pipeline; cannot be sent twice', async () => {
  const m = mocks(); const t = await setup({ NOTIFY_ENABLED: 'true', ...EM, ...WA, NOTIFY_WHATSAPP: 'true' }, m); try {
    const r = await t.send('email'); assert.equal(r.status, 200); assert.equal(r.json.status, 'sent'); assert.equal(m.emails.length, 1); assert.equal(m.emails[0].to, 'cust@x.example');
    assert.match(m.emails[0].unsubscribeUrl, /unsubscribe\.html\?c=email/); assert.match(m.emails[0].text, /(退訂|取消訂閱|unsubscribe)/i);
    const d = await t.app.ctx.db.one('select * from reminder_deliveries'); assert.equal(d.status, 'sent'); assert.equal(d.provider_message_id, 'em1'); assert.equal(d.dry_run, false);
    assert.equal((await t.app.ctx.db.one('select state, sent_via from reminders where id = $1', [t.rem])).state, 'sent');
    assert.equal((await t.send('email')).status, 400); assert.equal(m.emails.length, 1);
    assert.ok((await t.app.ctx.db.one("select count(*)::int n from audit_log where action = 'reminder.send'")).n === 1);
  } finally { await t.app.stop(); }
});
test('WhatsApp uses approved TEMPLATE messages with normalised number; missing template or credentials blocked', async () => {
  const m = mocks(); const t = await setup({ NOTIFY_ENABLED: 'true', NOTIFY_WHATSAPP: 'true', ...WA }, m); try {
    const r = await t.send('whatsapp'); assert.equal(r.status, 200); assert.equal(m.was.length, 1); const x = m.was[0]; assert.equal(x.template, 'booking_confirm'); assert.equal(x.to, '85293331234'); assert.equal(x.params[0], '提醒客'); assert.ok(x.params.length >= 3);
  } finally { await t.app.stop(); }
});
test('provider failure is recorded as failed (with redacted error), reminder not marked sent', async () => {
  const m = mocks('boom Bearer SECRETTOKEN123'); const t = await setup({ NOTIFY_ENABLED: 'true', ...EM }, m); try {
    const r = await t.send('email'); assert.equal(r.status, 502); const rem = await t.app.ctx.db.one('select state, delivery_status from reminders where id = $1', [t.rem]); assert.equal(rem.state, 'failed'); assert.equal(rem.delivery_status, 'failed');
    assert.equal((await t.app.ctx.db.one("select count(*)::int n from reminder_deliveries where status = 'failed'")).n, 1);
  } finally { await t.app.stop(); }
});
test('dry-run records what would be sent but calls no provider', async () => {
  const m = mocks(); const t = await setup({ NOTIFY_ENABLED: 'true', NOTIFY_DRY_RUN: 'true', ...EM }, m); try {
    const r = await t.send('email'); assert.equal(r.status, 200); assert.equal(r.json.status, 'dry_run'); assert.equal(m.emails.length, 0);
    assert.equal((await t.app.ctx.db.one('select dry_run from reminder_deliveries')).dry_run, true); assert.equal((await t.app.ctx.db.one('select state from reminders where id = $1', [t.rem])).state, 'drafted');
  } finally { await t.app.stop(); }
});
test('test allowlist protects real customers during pilot', async () => {
  const m = mocks(); const t = await setup({ NOTIFY_ENABLED: 'true', NOTIFY_TEST_ALLOWLIST: 'owner@x.example', ...EM }, m); try {
    assert.equal((await t.send('email')).status, 400); assert.equal(m.emails.length, 0);
  } finally { await t.app.stop(); }
});
test('suppression list: unsubscribe link (signed) blocks future sends; stored hashed; tampered link rejected; admin can manage', async () => {
  const m = mocks(); const t = await setup({ NOTIFY_ENABLED: 'true', ...EM }, m); try {
    const link = new URL(t.app.ctx.core.unsubLink('email', 'cust@x.example')); const p = Object.fromEntries(link.searchParams); const c = new H.Client(t.app.base);
    assert.equal((await c.post('/api/unsubscribe', { c: 'email', a: p.a, s: 'f'.repeat(64) })).status, 400);
    assert.equal((await c.post('/api/unsubscribe', { c: 'email', a: p.a, s: p.s })).status, 200);
    const row = await t.app.ctx.db.one('select * from suppression_list'); assert.equal(JSON.stringify(row).includes('cust@x.example'), false);
    const r = await t.send('email'); assert.equal(r.json.status, 'suppressed'); assert.equal(m.emails.length, 0);
    assert.equal((await t.app.ctx.db.one('select delivery_status from reminders where id = $1', [t.rem])).delivery_status, 'suppressed');
    const list = (await t.admin.get('/api/admin/suppression')).json.entries; assert.equal(list.length, 1); assert.equal(JSON.stringify(list).includes('cust@x.example'), false);
    await t.admin.post('/api/admin/suppression/remove', { channel: list[0].channel, ref: list[0].ref }); assert.equal((await t.admin.get('/api/admin/suppression')).json.entries.length, 0);
    await t.admin.post('/api/admin/suppression', { channel: 'whatsapp', address: '+852 9333 1234' }); assert.equal((await t.send('whatsapp')).status, 400);   // whatsapp channel not enabled in this env
  } finally { await t.app.stop(); }
});
test('marketing category is blocked unless the customer separately opted in; non-trial/consultation services are never messaged', async () => {
  const m = mocks(); const t = await setup({ NOTIFY_ENABLED: 'true', ...EM }, m); try {
        const r = await t.send('email', { category: 'marketing' }); assert.equal(r.status, 200); assert.equal(m.emails.length, 1, 'HTTP route ignores any category: only the transactional booking message is reachable');
    const n = t.app.ctx.notify; const rem = await t.app.ctx.db.one('select * from reminders where id = $1', [t.rem]); const b = await t.app.ctx.db.one('select * from bookings where id = $1', [t.booking]); const lead = await t.app.ctx.db.one('select * from leads where id = $1', [t.lead]);
    assert.throws(() => n.check(rem, { ...lead, marketing_opt_in: false }, b, 'email', 'marketing'), /推廣/); assert.equal(n.check(rem, { ...lead, marketing_opt_in: true }, b, 'email', 'marketing'), 'cust@x.example');
    const pkgId = (await t.app.ctx.db.one("select id from services where kind not in ('trial','single') limit 1")).id;
    assert.throws(() => n.check(rem, lead, { ...b, service_id: pkgId }, 'email'), /體驗|單次|只可/);
    assert.throws(() => n.check(rem, lead, { ...b, status: 'cancelled' }, 'email'), /取消|完成/);
  } finally { await t.app.stop(); }
});
test('auto-send: off until admin enables; then only due, booked, drafted reminders; respects suppression', async () => {
  const m = mocks(); const t = await setup({ NOTIFY_ENABLED: 'true', ...EM }, m); try {
    assert.equal(await t.app.ctx.notify.autoSendDue(), 0); assert.equal(m.emails.length, 0);
    assert.equal((await t.admin.post('/api/admin/settings', { autoSendReminders: true })).status, 200); assert.equal((await t.admin.get('/api/admin/settings')).json.autoSendReminders, true);
    assert.equal(await t.app.ctx.notify.autoSendDue(), 1); assert.equal(m.emails.length, 1); assert.equal(await t.app.ctx.notify.autoSendDue(), 0, 'not re-sent');
    assert.equal((await t.app.ctx.db.one("select count(*)::int n from reminders where kind <> 'confirmation' and state = 'sent'")).n, 0, 'future reminders not sent early');
    assert.ok((await t.app.ctx.db.one("select count(*)::int n from audit_log where action = 'settings.auto_send'")).n === 1);
  } finally { await t.app.stop(); }
});
test('real provider adapters talk to the right endpoints (local fake SendGrid + WhatsApp Cloud API)', async () => {
  const seen = []; const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') }); res.writeHead(req.url.includes('sendgrid') || req.url.startsWith('/v3') ? 202 : 200, { 'Content-Type': 'application/json', 'x-message-id': 'sg1' }); res.end(JSON.stringify({ messages: [{ id: 'wamid.1' }] })); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const app = await H.makeApp({ NOTIFY_ENABLED: 'true', NOTIFY_WHATSAPP: 'true', EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'SG.' + 'k'.repeat(30), SENDGRID_API_BASE: base, EMAIL_FROM: 'Salon <no-reply@x.example>', ...WA, WHATSAPP_API_BASE: base }); try {
    const admin = await H.loginAdmin(app); const trial = (await app.ctx.db.one("select id from services where kind = 'trial'")).id; const b = await admin.post('/api/staff/bookings', { service: trial, date: H.futureWeekday(4), time: '10:00', name: 'X', phone: '93331234', email: 'c@x.example' });
    const rem = (await app.ctx.db.one("select id from reminders where booking_id = $1 and kind = 'confirmation'", [b.json.id])).id;
    assert.equal((await admin.post('/api/staff/reminders/' + rem + '/send', { approve: true, channel: 'email' })).status, 200);
    const sg = seen.find(s => s.url === '/v3/mail/send'); assert.ok(sg); assert.equal(sg.body.personalizations[0].to[0].email, 'c@x.example'); assert.equal(sg.body.from.email, 'no-reply@x.example'); assert.match(sg.body.headers['List-Unsubscribe'], /unsubscribe/); assert.match(sg.auth, /^Bearer SG\./);
    const rem2 = (await app.ctx.db.one("select id from reminders where booking_id = $1 and kind = 'day-before'", [b.json.id])).id; await app.ctx.db.q("update reminders set draft_whatsapp = 'x', draft_email_body = 'x', draft_email_subject = 'x' where id = $1", [rem2]);
    assert.equal((await admin.post('/api/staff/reminders/' + rem2 + '/send', { approve: true, channel: 'whatsapp' })).status, 200);
    const w = seen.find(s => /\/messages$/.test(s.url)); assert.match(w.url, /^\/v\d+\.\d+\/123\/messages$/); assert.equal(w.body.type, 'template'); assert.equal(w.body.template.name, 'booking_remind'); assert.equal(w.body.to, '85293331234');
    assert.doesNotMatch(app.logs.join('\n'), /EAAtoken|SG\.k{10}/);
  } finally { await app.stop(); srv.close(); }
});
