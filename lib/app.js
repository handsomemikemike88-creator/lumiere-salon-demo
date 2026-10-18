'use strict';
const http = require('http');
const logger = require('./logger'), S = require('./security'), C = require('./constants'), E = require('./errors'), H = require('./http');
const dbMod = require('./db'), migrate = require('./migrate'); const { HttpError, bad, unauthorized, forbidden, notFound, tooMany } = E;

const ADMIN_PAGES = ['/staff/invitations.html', '/staff/audit.html', '/staff/checklist.html', '/staff/users.html', '/staff/admin-settings.html'];

async function createApp(cfg, overrides) {
  overrides = overrides || {};
  const log = overrides.log || logger.create(cfg.LOG_LEVEL);
  const ctx = { cfg, log, db: overrides.db || dbMod.create(cfg), limiter: new S.RateLimiter(cfg.RATE_LIMIT_DISABLED) };
  ctx.providers = overrides.providers || require('./providers').create(cfg);
  ctx.stripe = overrides.stripe || require('./stripe')(cfg);
  ctx.audit = require('./audit')(ctx); ctx.core = require('./core')(ctx); ctx.auth = require('./auth')(ctx); ctx.notify = require('./notify')(ctx);
  ctx.pay = require('./payments')(ctx); ctx.privacy = require('./privacy')(ctx); ctx.checklist = require('./checklist')(ctx);
  const { db, core, auth, notify, pay, privacy, checklist, audit, limiter, stripe } = ctx;
  const sec = H.secHeaders(cfg), COOK = { staff: cfg.prod ? '__Host-staff_sid' : 'staff_sid', customer: cfg.prod ? '__Host-cust_sid' : 'cust_sid' };

  // ---- boot tasks ----
  async function boot() {
    if (cfg.AUTO_MIGRATE) await migrate.run(db, log);
    for (const [i, s] of C.SERVICES.entries()) await db.q('insert into services(id, name, kind, price_hkd, sort) values ($1,$2,$3,$4,$5) on conflict (id) do update set name = excluded.name, kind = excluded.kind, price_hkd = excluded.price_hkd, sort = excluded.sort', [s.id, s.name, s.kind, s.price, i]);
    await auth.bootstrapAdmin();
    const n = await db.one("select count(*)::int n from staff where role = 'admin' and status = 'active'");
    if (!n.n) log.warn('沒有管理員帳戶：請設定 ADMIN_EMAIL + ADMIN_PASSWORD 後重啟，或執行 `npm run create-admin`。');
    if (cfg.SEED_DEMO_DATA) { const r = await require('./seed')(ctx)(); log.warn('SEED_DEMO_DATA=true: ' + (r.seeded ? 'sample data loaded (flagged is_sample)' : 'sample data skipped - ' + r.reason)); }
    cfg.warnings.forEach(w => log.warn(w));
  }

  // ---- request helpers ----
  const rl = (c, bucket, key, max, win) => { const r = limiter.hit(bucket, key, max, win); if (r.limited) throw tooMany('請求過於頻繁，請稍後再試。', r.retryAfterSec); };
  const staffToken = c => c.cookies[COOK.staff], custToken = c => c.cookies[COOK.customer];
  const setCookie = (c, kind, token, maxAge) => c.cookiesOut.push(H.cookieHeader(cfg, COOK[kind], token, maxAge));
  async function staffOf(c) { if (c._staff === undefined) { const s = await auth.getSession('staff', staffToken(c)); c._staff = s ? s.user : null; } return c._staff; }
  async function custOf(c) { if (c._cust === undefined) { const s = await auth.getSession('customer', custToken(c)); c._cust = s ? s.user : null; } return c._cust; }
  const needStaff = async c => { const u = await staffOf(c); if (!u) throw unauthorized('請先以員工身份登入'); return u; };
  const needAdmin = async c => { const u = await needStaff(c); if (u.role !== 'admin') throw forbidden('只限管理員'); return u; };
  const needCust = async c => { const u = await custOf(c); if (!u) throw unauthorized('請先登入會員'); return u; };
  const actorOf = (u, c) => ({ id: u.id, name: u.name, ipTag: c.ipTag });
  const pubStaff = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
  const pubCust = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone });
  const pw = (b, k) => typeof b[k] === 'string' ? b[k] : '';

  const routes = [];
  const R = (m, p, f) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), f });

  // ---------- public ----------
  R('GET', '/api/config', async c => {
    const cs = notify.channelStatus(); const staffUser = await staffOf(c);
    return { services: C.SERVICES.map(s => ({ id: s.id, name: s.name, kind: s.kind, price: s.price, priceLabel: C.fmt(s.price) })), stages: C.STAGES.map(s => ({ id: s, zh: C.STAGE_ZH[s] })), times: C.TIMES, defaultCapacity: C.DEFAULT_CAPACITY, demo: cfg.SITE_DEMO_MODE, today: core.todayStr(), storeName: cfg.store.name || (cfg.SITE_DEMO_MODE ? 'Lumière 雅緻美容' : '【店名待填】'),
      stripe: { mode: cfg.STRIPE_MODE, live: cfg.STRIPE_LIVE }, notify: staffUser ? { enabled: cs.enabled, dryRun: cs.dryRun, email: cs.email.enabled, whatsapp: cs.whatsapp.enabled, autoSend: await notify.autoSendEnabled() } : undefined };
  });
  R('GET', '/api/availability', async c => ({ days: await core.availability(c.q.get('from') || core.todayStr(), c.q.get('to') || core.addDays(core.todayStr(), 21)) }));
  R('POST', '/api/bookings', async c => {
    rl(c, 'booking', c.ip, 10, 3600e3);
    const { booking, token } = await core.createBooking(c.body, { customer: await custOf(c) }); return { id: booking.id, token };
  });
  R('GET', '/api/bookings/:id', async (c) => {
    const { b } = await core.bookingForAccess(c.params.id, c.q.get('t'), await staffOf(c), await custOf(c));
    const [v] = await core.bookingViews([b]);
    return { booking: { id: v.id, serviceName: v.serviceName, priceLabel: v.priceLabel, service: v.service, date: v.date, time: v.time, status: v.status, name: v.name, phone: v.phone, reminders: v.reminders, canChange: core.canSelfChange(b) } };
  });
  R('POST', '/api/bookings/:id/cancel', async c => { const { b, who } = await core.bookingForAccess(c.params.id, c.body.token || c.q.get('t'), await staffOf(c), await custOf(c)); await core.cancelBooking(b.id, who); return { ok: true }; });
  R('POST', '/api/bookings/:id/reschedule', async c => { const { b, who } = await core.bookingForAccess(c.params.id, c.body.token || c.q.get('t'), await staffOf(c), await custOf(c)); await core.rescheduleBooking(b.id, c.body.date, c.body.time, { ...who, force: false }); return { ok: true }; });
  R('POST', '/api/unsubscribe', async c => { rl(c, 'unsub', c.ip, 30, 3600e3); await notify.unsubscribe(c.body.c, c.body.a ? Buffer.from(String(c.body.a), 'base64url').toString('utf8') : '', c.body.s); return { ok: true }; });

  // ---------- auth (shared) ----------
  R('POST', '/api/auth/forgot', async c => {
    const kind = c.body.kind === 'customer' ? 'customer' : 'staff'; const id = typeof c.body.identifier === 'string' ? c.body.identifier.slice(0, 120) : '';
    rl(c, 'forgot', c.ip, 6, 3600e3); rl(c, 'forgot-id', id.toLowerCase(), 3, 3600e3);
    await auth.forgot(kind, id); return { ok: true, message: '如果此電郵已登記，我們已發出重設密碼連結（請同時檢查垃圾郵件）。' };
  });
  R('POST', '/api/auth/reset', async c => {
    rl(c, 'reset', c.ip, 10, 3600e3); const kind = c.body.kind === 'customer' ? 'customer' : 'staff';
    await auth.resetPassword(kind, c.body.token, pw(c.body, 'password')); return { ok: true };
  });

  // ---------- staff auth ----------
  R('POST', '/api/staff/login', async c => {
    const em = core.email(c.body.email, true); rl(c, 'login', c.ip, 30, 600e3); rl(c, 'login-id', c.ip + '|' + em, 8, 600e3);
    const r = await auth.login('staff', em, pw(c.body, 'password'), staffToken(c), c.ipTag); setCookie(c, 'staff', r.session.token, r.session.maxAgeSec); return { user: pubStaff(r.user) };
  });
  R('POST', '/api/staff/logout', async c => { await auth.revokeSession(staffToken(c)); setCookie(c, 'staff', '', 0); return { ok: true }; });
  R('GET', '/api/staff/me', async c => ({ user: pubStaff(await needStaff(c)) }));
  R('POST', '/api/staff/password', async c => { const u = await needStaff(c); const s = await auth.changePassword('staff', u, pw(c.body, 'current'), pw(c.body, 'next')); setCookie(c, 'staff', s.token, s.maxAgeSec); return { ok: true }; });
  R('GET', '/api/invite/:token', async c => { rl(c, 'invite-info', c.ip, 30, 3600e3); return auth.inviteInfo(c.params.token); });
  R('POST', '/api/staff/register', async c => {
    rl(c, 'register', c.ip, 10, 3600e3); const u = await auth.registerStaff(c.body.token, c.body.name, pw(c.body, 'password'), c.ipTag);
    return { ok: true, status: u.status, message: '註冊完成。管理員批准你的帳戶後，你便可以登入。' };
  });

  // ---------- admin ----------
  R('GET', '/api/admin/invitations', async c => { await needAdmin(c); return { invitations: await auth.listInvitations() }; });
  R('POST', '/api/admin/invitations', async c => {
    const a = await needAdmin(c); const inv = await auth.createInvitation(a, c.body.email); let emailed = false;
    if (ctx.providers.email && c.body.sendEmail === true) { try { await ctx.providers.email.send({ to: inv.email, subject: '員工帳戶邀請', text: `你好，\n\n你獲邀建立員工帳戶，請於 ${cfg.INVITE_TTL_HOURS} 小時內開啟（只可使用一次）：\n${inv.link}\n` }); emailed = true; } catch (e) { log.error('invite email failed', { err: e.message }); } }
    return { invitation: { id: inv.id, email: inv.email, expiresAt: inv.expiresAt }, link: inv.link, emailed };
  });
  R('POST', '/api/admin/invitations/:id/revoke', async c => { await auth.revokeInvitation(await needAdmin(c), c.params.id); return { ok: true }; });
  R('GET', '/api/admin/staff', async c => { await needAdmin(c); return { users: await auth.listStaff() }; });
  R('POST', '/api/admin/staff/:id/status', async c => { await auth.setStaffStatus(await needAdmin(c), c.params.id, c.body.status); return { ok: true }; });
  R('POST', '/api/admin/staff/:id/role', async c => { await auth.setStaffRole(await needAdmin(c), c.params.id, c.body.role); return { ok: true }; });
  R('GET', '/api/admin/audit', async c => { await needAdmin(c); const lim = Math.min(200, Math.max(1, parseInt(c.q.get('limit'), 10) || 100)), off = Math.max(0, parseInt(c.q.get('offset'), 10) || 0); return { entries: await audit.list(lim, off, c.q.get('action') || null) }; });
  R('GET', '/api/admin/checklist', async c => { await needAdmin(c); return checklist.get(); });
  R('POST', '/api/admin/checklist/:id', async c => { const a = await needAdmin(c); await checklist.set(c.params.id, c.body.done === true, a); return checklist.get(); });
  R('GET', '/api/admin/settings', async c => { await needAdmin(c); const cs = notify.channelStatus(); return { autoSendReminders: await notify.autoSendEnabled(), notify: { enabled: cs.enabled, dryRun: cs.dryRun, email: cs.email, whatsapp: cs.whatsapp }, retentionMonths: cfg.DATA_RETENTION_MONTHS, stripe: stripe.status(), emailProvider: cfg.EMAIL_PROVIDER }; });
  R('POST', '/api/admin/settings', async c => {
    const a = await needAdmin(c);
    if (typeof c.body.autoSendReminders === 'boolean') {
      if (c.body.autoSendReminders && !cfg.NOTIFY_ENABLED) throw bad('NOTIFY_ENABLED=false：請先在伺服器環境變數啟用真實發送，才可開啟自動發送。');
      await notify.setSetting('auto_send_reminders', c.body.autoSendReminders, a); await audit.log(actorOf(a, c), 'settings.auto_send', { type: 'setting', id: 'auto_send_reminders' }, { value: c.body.autoSendReminders });
    }
    return { ok: true, autoSendReminders: await notify.autoSendEnabled() };
  });
  R('GET', '/api/admin/suppression', async c => { await needAdmin(c); return { entries: await notify.listSuppression() }; });
  R('POST', '/api/admin/suppression', async c => { const a = await needAdmin(c); await notify.suppress(c.body.channel, c.body.address, c.body.reason || 'manual', a.name); await audit.log(actorOf(a, c), 'suppression.added', { type: 'suppression', id: String(c.body.channel) }); return { ok: true }; });
  R('POST', '/api/admin/suppression/remove', async c => { const a = await needAdmin(c); await notify.unsuppress(c.body.channel, c.body.ref); await audit.log(actorOf(a, c), 'suppression.removed', { type: 'suppression', id: String(c.body.channel) }); return { ok: true }; });
  R('POST', '/api/admin/leads/:id/anonymise', async c => { const a = await needAdmin(c); if (c.body.confirm !== c.params.id) throw bad('請輸入客戶編號以確認'); await privacy.anonymiseLead(c.params.id, a); return { ok: true }; });

  // ---------- customer ----------
  R('POST', '/api/customer/register', async c => { rl(c, 'creg', c.ip, 5, 3600e3); const r = await auth.registerCustomer(c.body, c.ipTag); setCookie(c, 'customer', r.session.token, r.session.maxAgeSec); return { customer: pubCust(r.customer) }; });
  R('POST', '/api/customer/login', async c => {
    const id = typeof c.body.identifier === 'string' ? c.body.identifier.trim().toLowerCase().slice(0, 120) : ''; if (!id) throw bad('請填寫電郵或電話');
    rl(c, 'clogin', c.ip, 30, 600e3); rl(c, 'clogin-id', c.ip + '|' + id, 8, 600e3);
    const r = await auth.login('customer', id, pw(c.body, 'password'), custToken(c), c.ipTag); setCookie(c, 'customer', r.session.token, r.session.maxAgeSec); return { customer: pubCust(r.user) };
  });
  R('POST', '/api/customer/logout', async c => { await auth.revokeSession(custToken(c)); setCookie(c, 'customer', '', 0); return { ok: true }; });
  R('GET', '/api/customer/me', async c => { const u = await custOf(c); return { customer: u ? pubCust(u) : null }; });
  R('POST', '/api/customer/password', async c => { const u = await needCust(c); const s = await auth.changePassword('customer', u, pw(c.body, 'current'), pw(c.body, 'next')); setCookie(c, 'customer', s.token, s.maxAgeSec); return { ok: true }; });
  R('GET', '/api/customer/bookings', async c => {
    const u = await needCust(c); await core.runScheduler();
    const rows = await db.all('select b.*, l.name lead_name, l.phone lead_phone, l.stage lead_stage, l.payment_status lead_payment from bookings b join leads l on l.id = b.lead_id where l.customer_id = $1 and l.anonymised_at is null order by b.date desc, b.time desc', [u.id]);
    const views = await core.bookingViews(rows); const stages = (await db.all('select stage from leads where customer_id = $1 and anonymised_at is null', [u.id])).map(r => r.stage);
    return { customer: pubCust(u), bookings: views.map((v, i) => ({ ...v, canChange: core.canSelfChange(rows[i]) })), packageStatus: stages.includes('Package Sold') ? 'sold' : stages.includes('Package Consultation') ? 'consultation' : 'none', demo: cfg.SITE_DEMO_MODE };
  });
  R('GET', '/api/customer/export', async c => { const u = await needCust(c); return privacy.exportCustomer(u.id); });
  R('POST', '/api/customer/delete', async c => {
    const u = await needCust(c); const row = await db.one('select pw_hash from customers where id = $1', [u.id]);
    if (c.body.confirm !== 'DELETE' || !(await S.verifyPassword(pw(c.body, 'password'), row.pw_hash))) throw bad('請輸入正確密碼並輸入 DELETE 以確認刪除。');
    await privacy.anonymiseCustomer(u.id, { kind: 'customer', id: u.id, ipTag: c.ipTag }); setCookie(c, 'customer', '', 0); return { ok: true };
  });

  // ---------- staff data ----------
  R('GET', '/api/staff/dashboard', async c => { await needStaff(c); await core.runScheduler(); return core.dashboard(); });
  R('GET', '/api/staff/leads', async c => { await needStaff(c); const q = c.q; return core.listLeads({ q: (q.get('q') || '').trim(), stage: q.get('stage'), service: q.get('service'), source: q.get('source'), marketing: q.get('marketing'), includeSample: cfg.SITE_DEMO_MODE }); });
  R('GET', '/api/staff/leads/:id', async c => { await needStaff(c); return { lead: await core.getLead(c.params.id) }; });
  R('GET', '/api/staff/leads/:id/export', async c => { const u = await needStaff(c); const d = await privacy.exportLead(c.params.id); await audit.log(actorOf(u, c), 'lead.exported', { type: 'lead', id: c.params.id }); return d; });
  R('POST', '/api/staff/leads/:id/stage', async c => { const u = await needStaff(c); await core.moveStage(c.params.id, c.body.stage, u, core.str(c.body.why, 200, '原因', false)); return { lead: await core.getLead(c.params.id) }; });
  R('POST', '/api/staff/leads/:id/notes', async c => { const u = await needStaff(c); await core.addNote(c.params.id, core.str(c.body.text, 1000, '備註', true), u); return { lead: await core.getLead(c.params.id) }; });
  R('POST', '/api/staff/leads/:id/payment', async c => { const u = await needStaff(c); await core.setPaymentMark(c.params.id, c.body.status, u); return { lead: await core.getLead(c.params.id) }; });
  R('GET', '/api/staff/bookings', async c => { await needStaff(c); await core.runScheduler(); return core.bookingsBetween(core.validDate(c.q.get('from')) ? c.q.get('from') : '2000-01-01', core.validDate(c.q.get('to')) ? c.q.get('to') : '2100-01-01'); });
  R('POST', '/api/staff/bookings', async c => { const u = await needStaff(c); const { booking, lead } = await core.createBooking(c.body, { staff: u, force: c.body.force === true }); return { id: booking.id, leadId: lead.id }; });
  R('POST', '/api/staff/bookings/:id/attendance', async c => { const u = await needStaff(c); await core.setAttendance(c.params.id, c.body.status, u); return { ok: true }; });
  R('POST', '/api/staff/bookings/:id/reschedule', async c => { const u = await needStaff(c); await core.rescheduleBooking(c.params.id, c.body.date, c.body.time, { staff: u, force: c.body.force === true }); return { ok: true }; });
  R('POST', '/api/staff/bookings/:id/cancel', async c => { const u = await needStaff(c); await core.cancelBooking(c.params.id, { staff: u }); return { ok: true }; });
  R('POST', '/api/staff/slots', async c => { const u = await needStaff(c); await core.setSlotCapacity(c.body.date, c.body.time, c.body.capacity, u); return { ok: true }; });
  R('GET', '/api/staff/reminders', async c => {
    await needStaff(c); await core.runScheduler(); const cs = notify.channelStatus();
    return { reminders: await core.listReminders(c.q.get('state') || null), notice: cs.enabled ? (cs.dryRun ? '真實發送功能處於「試運行」模式：不會真正發出訊息。' : '真實發送已啟用：每則訊息都需要員工逐一核准（或管理員開啟自動發送）。') : '系統預設只產生訊息草稿，不會自動發送任何 WhatsApp 或電郵。', notify: { enabled: cs.enabled, dryRun: cs.dryRun, email: cs.email.enabled, whatsapp: cs.whatsapp.enabled, autoSend: await notify.autoSendEnabled() } };
  });
  R('POST', '/api/staff/reminders/run', async c => { await needStaff(c); return { generated: await core.runScheduler() }; });
  R('POST', '/api/staff/reminders/:id/state', async c => { const u = await needStaff(c); await core.setReminderState(c.params.id, c.body.state, c.body.via, u); return { ok: true }; });
  R('POST', '/api/staff/reminders/:id/send', async c => { const u = await needStaff(c); if (c.body.approve !== true) throw bad('需要員工明確核准（approve: true）才會發送。'); return notify.send(c.params.id, c.body.channel, u); });

  // ---------- Stripe ----------
  const stripeErr = e => { if (e instanceof stripe.StripeError) throw new HttpError(e.code === 502 ? 502 : e.code === 503 ? 503 : 400, e.message); throw e; };
  R('GET', '/api/staff/stripe/status', async c => { await needStaff(c); return stripe.status(); });
  R('POST', '/api/staff/leads/:id/stripe-checkout', async c => { const u = await needStaff(c); try { const r = await pay.createCheckout(c.params.id, u, { renew: c.body.renew === true }); return { reused: r.reused, lead: await core.getLead(c.params.id) }; } catch (e) { stripeErr(e); } });
  R('POST', '/api/staff/leads/:id/stripe-verify', async c => { const u = await needStaff(c); try { const r = await pay.verifyPayment(c.params.id, u); return { ...r, lead: await core.getLead(c.params.id) }; } catch (e) { stripeErr(e); } });

  // ---------- HTTP server ----------
  const serveStatic = H.createStatic(cfg, { adminOnly: ADMIN_PAGES, dynamicFlags: async rel => { const d = (await notify.getSetting('checklist', {})) || {}; const k = rel === '/privacy.html' ? 'privacy_policy_review' : 'terms_review'; return { hideDraft: !!(d[k] && d[k].done) }; } });
  let draining = false;
  async function stripeWebhook(c) {
    let secret; try { secret = stripe.webhookSecret(); } catch (e) { throw new HttpError(e.code || 503, e.message); }
    const raw = await H.readBody(c.req, 512e3); let ev;
    try { ev = require('./stripe').verifyWebhook(raw, c.req.headers['stripe-signature'], secret, 300); } catch (e) { if (e instanceof stripe.StripeError) throw new HttpError(400, e.message); throw e; }
    return { received: true, ...(await pay.handleEvent(ev)) };
  }
  async function handle(req, res) {
    const t0 = Date.now(); const url = new URL(req.url, 'http://localhost'); const ip = S.clientIp(req, cfg.TRUST_PROXY);
    const c = { req, res, url, q: url.searchParams, ip, ipTag: S.ipTag(cfg.APP_SECRET, ip), cookies: H.cookiesOf(req), cookiesOut: [], params: {}, body: {} };
    const done = (code) => log.info('request', { method: req.method, path: url.pathname.replace(/\/(BK|L|R|P|S|C)\d+/g, '/:id').slice(0, 80), status: code, ms: Date.now() - t0, ip: c.ipTag });
    res.on('finish', () => { if (url.pathname !== '/healthz') done(res.statusCode); });
    try {
      if (url.pathname === '/healthz') {
        let ok = !draining; if (ok) { try { await db.ping(); } catch (e) { ok = false; } }
        return H.sendJson(req, res, sec, ok ? 200 : 503, { status: ok ? 'ok' : 'unavailable' });
      }
      if (cfg.prod && cfg.TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'http' && cfg.ORIGIN) { res.writeHead(308, { Location: cfg.ORIGIN + req.url }); return res.end(); }
      if (req.method === 'POST' && url.pathname === '/api/stripe/webhook') { const r = await stripeWebhook(c); return H.sendJson(req, res, sec, 200, r); }
      if (url.pathname.startsWith('/api/')) {
        rl(c, 'api', c.ip, 600, 60e3);
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, '需要 JSON');
          H.checkOrigin(req, cfg);
        }
        const r = routes.find(x => x.m === req.method && x.re.test(url.pathname)); if (!r) throw notFound('API 不存在');
        c.params = r.re.exec(url.pathname).groups || {};
        c.body = req.method === 'POST' ? H.parseJson(await H.readBody(req, 100e3)) : {};
        const out = await r.f(c);
        return H.sendJson(req, res, sec, 200, out, c.cookiesOut.length ? { 'Set-Cookie': c.cookiesOut } : null);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, sec); return res.end(); }
      const staffUser = url.pathname.startsWith('/staff/') ? await staffOf(c) : null;
      return await serveStatic(req, res, url, sec, staffUser);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch (x) { /* ignore */ } return; }
      if (e instanceof HttpError) { const extra = e.extra && e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : null; return H.sendJson(req, res, sec, e.code, { error: e.message }, extra); }
      if (e && e.code === '23505') return H.sendJson(req, res, sec, 409, { error: '資料已存在或剛被更新，請重新整理後再試。' });
      log.error('unhandled error', { path: url.pathname, err: e && e.message, stack: cfg.prod ? undefined : (e && e.stack) });
      return H.sendJson(req, res, sec, 500, { error: '伺服器錯誤' });
    }
  }
  const server = http.createServer((req, res) => { handle(req, res).catch(e => { log.error('fatal handler error', { err: e.message }); try { res.writeHead(500); res.end(); } catch (x) { /* ignore */ } }); });
  server.keepAliveTimeout = 65000; server.headersTimeout = 66000; server.requestTimeout = 60000;
  let timers = [];
  async function start() {
    await boot();
    await new Promise((ok, no) => { server.once('error', no); server.listen(cfg.PORT, cfg.HOST, ok); });
    timers.push(setInterval(() => { core.runScheduler().catch(e => log.error('scheduler failed', { err: e.message })); }, 60000));
    timers.push(setInterval(() => { auth.purgeSessions().catch(() => { }); }, 3600e3));
    timers.forEach(t => t.unref());
    log.info('server started', { port: server.address().port, mode: cfg.NODE_ENV, demo: cfg.SITE_DEMO_MODE, stripe: cfg.STRIPE_MODE, notify: cfg.NOTIFY_ENABLED });
    return server;
  }
  async function stop() {
    draining = true; timers.forEach(clearInterval);
    await new Promise(ok => { server.close(() => ok()); if (server.closeIdleConnections) server.closeIdleConnections(); setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); ok(); }, 8000).unref(); });
    limiter.close(); if (!overrides.db) await db.close();
  }
  return { server, ctx, start, stop, boot, url: () => 'http://127.0.0.1:' + server.address().port };
}
module.exports = { createApp, ADMIN_PAGES };
