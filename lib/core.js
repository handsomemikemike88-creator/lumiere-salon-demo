'use strict';
const crypto = require('crypto');
const C = require('./constants'), S = require('./security'), E = require('./errors');
const { bad, notFound, conflict, HttpError } = E;

// ---- pure helpers (Hong Kong time, UTC+8, no DST) ----
const HK = 8 * 3600e3;
const hkNow = () => new Date(Date.now() + HK);
const todayStr = () => hkNow().toISOString().slice(0, 10);
const tsOf = (date, time) => Date.parse(date + 'T' + time + ':00+08:00');
function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const str = (v, max, name, req) => { v = typeof v === 'string' ? v.trim() : ''; if (req && !v) throw bad('請填寫' + name); if (v.length > max) throw bad(name + '過長'); return v.replace(/[\u0000-\u001f]/g, ' '); };
function phone(v, req) {
  v = typeof v === 'string' ? v.replace(/[\s-]/g, '') : '';
  if (!v) { if (req) throw bad('請填寫電話號碼'); return ''; }
  const m = /^(?:\+?852)?([2-9]\d{7})$/.exec(v); if (!m) throw bad('請填寫有效的香港電話號碼（8 位數字）');
  return '+852 ' + m[1].slice(0, 4) + ' ' + m[1].slice(4);
}
function email(v, req) {
  v = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!v) { if (req) throw bad('請填寫電郵'); return ''; }
  if (v.length > 120 || !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v)) throw bad('電郵格式不正確'); return v;
}
const dayLabel = date => { const [, m, d] = date.split('-'); return `${Number(m)}月${Number(d)}日（星期${WD[dow(date)]}）`; };
const iso = d => d instanceof Date ? d.toISOString() : d;

module.exports = ctx => {
  const { db, cfg } = ctx; const audit = ctx.audit;
  const q = db.q, one = db.one, all = db.all;
  const storeName = () => cfg.store.name || '【店名待填】';
  const demoTag = cfg.SITE_DEMO_MODE ? '\n（示範草稿，並非真實商戶）' : '';

  // ================= slots =================
  async function availability(from, to) {
    if (!validDate(from) || !validDate(to)) throw bad('日期格式不正確');
    const rows = await all("select date, time, count(*)::int n from bookings where date between $1 and $2 and status <> 'cancelled' group by 1,2", [from, to]);
    const caps = await all('select date, time, capacity from slot_caps where date between $1 and $2', [from, to]);
    const used = {}; rows.forEach(r => used[r.date + ' ' + r.time] = r.n); const cap = {}; caps.forEach(r => cap[r.date + ' ' + r.time] = r.capacity);
    const out = []; let d = from, n = 0;
    while (d <= to && n++ < 62) {
      if (dow(d) !== 0) out.push({ date: d, slots: C.TIMES.map(t => { const k = d + ' ' + t, c = cap[k] === undefined ? C.DEFAULT_CAPACITY : cap[k], u = used[k] || 0; return { time: t, capacity: c, used: u, remaining: Math.max(0, c - u) }; }) });
      d = addDays(d, 1);
    }
    return out;
  }
  // must run inside a transaction: takes a per-slot advisory lock so two requests cannot overbook
  async function checkSlot(client, date, time, exceptId, opts) {
    if (!validDate(date)) throw bad('日期格式不正確');
    if (!C.TIMES.includes(time)) throw bad('時段不正確');
    if (dow(date) === 0) throw bad('星期日休息，請選擇其他日期');
    if (!opts.staff) {
      if (tsOf(date, time) < Date.now() + 2 * 3600e3) throw bad('請選擇現時起 2 小時後的時段');
      if (date > addDays(todayStr(), 60)) throw bad('只接受 60 日內的預約');
    }
    await q('select pg_advisory_xact_lock(hashtext($1))', ['slot:' + date + ' ' + time], client);
    const cap = await one('select capacity from slot_caps where date = $1 and time = $2', [date, time], client);
    const used = await one("select count(*)::int n from bookings where date = $1 and time = $2 and status <> 'cancelled' and ($3::text is null or id <> $3)", [date, time, exceptId || null], client);
    if (used.n >= (cap ? cap.capacity : C.DEFAULT_CAPACITY) && !opts.force) throw conflict('此時段已滿，請選擇其他時段');
  }

  // ================= reminders (drafts) =================
  function unsubLink(channel, address) {
    const a = Buffer.from(address).toString('base64url');
    return (cfg.PUBLIC_BASE_URL || 'http://localhost:' + cfg.PORT) + '/unsubscribe.html?c=' + channel + '&a=' + a + '&s=' + S.hmac(cfg.APP_SECRET, 'unsub|' + channel + '|' + address);
  }
  const verifyUnsub = (channel, address, sig) => ['email', 'whatsapp'].includes(channel) && typeof address === 'string' && typeof sig === 'string' && S.safeEq(sig, S.hmac(cfg.APP_SECRET, 'unsub|' + channel + '|' + address));
  function draftsFor(kind, b, lead, updated) {
    const s = C.svc(b.service_id), when = `${dayLabel(b.date)} ${b.time}`, sv = `${s.name}（${C.fmt(b.price_hkd)}）`;
    const intro = { confirmation: updated ? '已為你更新預約：' : '已收到你的預約：', 'day-before': '溫馨提示，你明日有預約：', 'same-day': '溫馨提示，你今日有預約：' }[kind];
    const tail = { confirmation: '如需改期或取消，請於預約前 24 小時以上回覆通知，我們會安排。', 'day-before': '如需改期，請盡早回覆通知。', 'same-day': '如未能出席，請盡早回覆通知我們。' }[kind];
    const addr = cfg.store.address || '【地址待填】';
    const core = `${lead.name} 你好，\n${intro}\n服務：${sv}\n時間：${when}\n地點：${storeName()}，${addr}\n預約編號：${b.id}\n${tail}\n本訊息只作預約通知，並非推廣訊息。`;
    const subj = { confirmation: updated ? '預約更新確認' : '預約確認', 'day-before': '明日預約提示', 'same-day': '今日預約提示' }[kind] + '｜' + storeName();
    const wa = core + '\n如不欲再收到預約提示，請回覆 STOP。' + demoTag;
    const em = core + '\n如不欲再收到預約提示，請按此退訂：' + (lead.email ? unsubLink('email', lead.email) : '（客人未提供電郵）') + demoTag;
    return { whatsapp: wa, subject: subj, email: em };
  }
  function scheduleFor(kind, b) {
    if (kind === 'confirmation') return new Date().toISOString();
    if (kind === 'day-before') return new Date(tsOf(addDays(b.date, -1), '10:00')).toISOString();
    return new Date(tsOf(b.date, '08:30')).toISOString();
  }
  async function genDraft(client, r, updated) {
    const b = await one('select * from bookings where id = $1', [r.booking_id], client), lead = await one('select * from leads where id = $1', [b.lead_id], client);
    const d = draftsFor(r.kind, b, lead, updated);
    await q("update reminders set draft_whatsapp = $2, draft_email_subject = $3, draft_email_body = $4, state = 'drafted', updated_at = now() where id = $1", [r.id, d.whatsapp, d.subject, d.email], client);
  }
  async function makeReminders(client, b) {
    for (const k of C.REMINDER_KINDS) await q("insert into reminders(booking_id, kind, scheduled_for) values ($1,$2,$3) on conflict (booking_id, kind) do nothing", [b.id, k, scheduleFor(k, b)], client);
  }
  // Scheduler: creates drafts that are due. Real sending happens ONLY if auto-send is enabled by an admin (see notify.js).
  async function runScheduler() {
    const due = await all("select r.* from reminders r join bookings b on b.id = r.booking_id where r.void = false and r.state = 'pending' and r.scheduled_for <= now() and b.status = 'booked' and (b.date::text || ' ' || b.time)::timestamp at time zone 'Asia/Hong_Kong' + interval '1 hour' >= now() order by r.scheduled_for limit 200");
    let n = 0;
    for (const r of due) { await db.tx(async c => { const cur = await one("select * from reminders where id = $1 and state = 'pending' for update", [r.id], c); if (cur) { await genDraft(c, cur); n++; } }); }
    if (ctx.notify) { try { await ctx.notify.autoSendDue(); } catch (e) { ctx.log.error('auto-send failed', { err: e.message }); } }
    return n;
  }
  const hasMsgAddr = (lead, ch) => ch === 'email' ? !!lead.email : !!lead.phone;
  function reminderView(r, lead, b) {
    const o = { id: r.id, bookingId: r.booking_id, kind: r.kind, state: r.state, scheduledFor: iso(r.scheduled_for), sentVia: r.sent_via, updated: iso(r.updated_at), leadName: lead.name, phone: lead.phone, email: lead.email, date: b.date, time: b.time, service: b.service_id, bookingStatus: b.status, approvedBy: r.approved_by, delivery: r.delivery_status ? { channel: r.delivery_channel, status: r.delivery_status, provider: r.delivery_provider, error: r.delivery_error, at: iso(r.delivery_updated_at) } : null, drafts: null };
    if (r.draft_whatsapp) {
      const digits = (lead.phone || '').replace(/\D/g, '');
      o.drafts = { whatsapp: { body: r.draft_whatsapp, url: digits ? 'https://wa.me/' + digits + '?text=' + encodeURIComponent(r.draft_whatsapp) : '' }, email: { subject: r.draft_email_subject, body: r.draft_email_body, url: lead.email ? 'mailto:' + lead.email + '?subject=' + encodeURIComponent(r.draft_email_subject) + '&body=' + encodeURIComponent(r.draft_email_body) : '' } };
    }
    return o;
  }
  async function listReminders(state) {
    const rows = await all(`select r.*, to_jsonb(l.*) lead, to_jsonb(b.*) booking from reminders r join bookings b on b.id = r.booking_id join leads l on l.id = b.lead_id
      where l.anonymised_at is null and r.void = false and (b.status = 'booked' or r.state = 'sent') ${state === 'open' ? "and r.state in ('drafted','failed')" : state ? 'and r.state = $1' : ''} order by r.scheduled_for limit 300`, state && state !== 'open' ? [state] : []);
    return rows.map(r => reminderView(r, r.lead, r.booking));
  }
  async function setReminderState(id, state, via, actor) {
    if (!['drafted', 'sent', 'failed', 'pending'].includes(state)) throw bad('狀態不正確');
    await db.tx(async c => {
      const r = await one('select * from reminders where id = $1 for update', [id], c); if (!r) throw notFound();
      if (state === 'drafted' && !r.draft_whatsapp) await genDraft(c, r);
      else await q('update reminders set state = $2, updated_at = now() where id = $1', [id, state], c);
      if (state === 'sent') {
        const v = ['whatsapp', 'email', 'other'].includes(via) ? via : 'other';
        await q('update reminders set sent_via = $2, sent_by = $3, sent_at = now() where id = $1', [id, v, actor.name], c);
        const b = await one('select lead_id from bookings where id = $1', [r.booking_id], c);
        await advanceAfterReminder(c, b.lead_id, actor.name, '已標記提醒為已發出');
      }
      await audit.log({ kind: 'staff', id: actor.id, name: actor.name }, 'reminder.state', { type: 'reminder', id }, { state, via: via || null }, c);
    });
  }
  async function advanceAfterReminder(c, leadId, by, why) {
    const lead = await one('select id, stage from leads where id = $1 for update', [leadId], c);
    if (lead && lead.stage === 'New Trial Lead') await moveStageTx(c, lead, 'Reminder Sent', by, why);
  }

  // ================= pipeline =================
  // opts.verifiedPayment: set ONLY by lib/payments.js after a verified Stripe payment. opts.sample: seed only.
  async function moveStageTx(c, lead, stage, by, why, opts) {
    opts = opts || {};
    if (!C.STAGES.includes(stage)) throw bad('階段不正確');
    if (lead.stage === stage) return;
    if (stage === 'Package Sold' && !opts.verifiedPayment && !opts.sample) throw bad('不能手動移到 Package Sold：必須先有已驗證的 Stripe 付款。請在「套餐諮詢」面板建立 Stripe 付款，付款經 webhook 或「驗證付款」確認後，系統會自動移動。');
    const paid = await one("select 1 from payments where lead_id = $1 and status = 'paid'", [lead.id], c);
    if (lead.stage === 'Package Sold' && paid) throw bad('此客戶已有已驗證的 Stripe 付款，不能移出 Package Sold。');
    if (stage === 'Package Consultation' && lead.stage !== 'Attended' && !opts.sample) throw bad('只有「已出席（Attended）」的客戶才可移到 Package Consultation。');
    await q('update leads set stage = $2 where id = $1', [lead.id, stage], c);
    await q("insert into lead_history(lead_id, from_stage, to_stage, by_name, why) values ($1,$2,$3,$4,$5)", [lead.id, lead.stage, stage, by || '系統', why || ''], c);
    lead.stage = stage;
  }
  async function moveStage(leadId, stage, actor, why) {
    await db.tx(async c => {
      const lead = await one('select id, stage from leads where id = $1 and anonymised_at is null for update', [leadId], c); if (!lead) throw notFound('找不到客戶');
      const from = lead.stage; await moveStageTx(c, lead, stage, actor.name, why);
      if (from !== stage) await audit.log({ kind: 'staff', id: actor.id, name: actor.name }, 'lead.stage_move', { type: 'lead', id: leadId }, { from, to: stage }, c);
    });
  }
  const addNoteTx = (c, leadId, text, by) => q('insert into lead_notes(lead_id, by_name, text) values ($1,$2,$3)', [leadId, by, text], c);
  async function addNote(leadId, text, actor) {
    await db.tx(async c => { if (!(await one('select 1 from leads where id = $1 and anonymised_at is null', [leadId], c))) throw notFound('找不到客戶'); await addNoteTx(c, leadId, text, actor.name); await audit.log({ kind: 'staff', id: actor.id, name: actor.name }, 'lead.note_added', { type: 'lead', id: leadId }, null, c); });
  }
  async function setPaymentMark(leadId, status, actor) {
    if (!C.PAYMENT.includes(status)) throw bad('付款狀態不正確');
    await db.tx(async c => {
      const l = await one('select id, payment_status from leads where id = $1 and anonymised_at is null for update', [leadId], c); if (!l) throw notFound('找不到客戶');
      if (l.payment_status === status) return;
      await q('update leads set payment_status = $2 where id = $1', [leadId, status], c);
      await addNoteTx(c, leadId, `付款狀態由 ${l.payment_status} 改為 ${status}（人手標記，只作記錄；並不代表 Stripe 收款）。`, actor.name);
      await audit.log({ kind: 'staff', id: actor.id, name: actor.name }, 'lead.payment_mark', { type: 'lead', id: leadId }, { from: l.payment_status, to: status }, c);
    });
  }

  // ================= views =================
  function primaryBooking(bs) {
    if (!bs.length) return null;
    const act = bs.filter(b => b.status !== 'cancelled').sort((a, b) => tsOf(b.date, b.time) - tsOf(a.date, a.time));
    const pool = act.length ? act : bs.slice().sort((a, b) => tsOf(b.date, b.time) - tsOf(a.date, a.time));
    const now = Date.now(), fut = act.filter(b => tsOf(b.date, b.time) >= now).sort((a, b) => tsOf(a.date, a.time) - tsOf(b.date, b.time));
    return fut[0] || pool[0];
  }
  const payLabel = () => cfg.STRIPE_LIVE ? '正式收款（Stripe live）' : 'Test Mode - not real revenue（Stripe 測試模式，不是真實收入）';
  const pkgLabel = () => cfg.STRIPE_LIVE ? '' : 'Sample / Test Data - Stripe Test Mode, not a real transaction';
  const pkgProduct = () => cfg.STRIPE_LIVE ? '10-Session Package' : '10-Session Package (Sample/Test)';
  function payView(p) {
    if (!p) return null;
    return { id: p.id, status: p.status, sessionId: p.session_id, paymentIntentId: p.payment_intent_id || null, bookingId: p.booking_id, amountMinor: p.amount_minor, amountLabel: C.fmt(p.amount_minor / 100), currency: p.currency, livemode: p.livemode, checkoutUrl: p.status === 'pending' ? p.checkout_url : null, expiresAt: iso(p.expires_at), createdAt: iso(p.created_at), updatedAt: iso(p.updated_at), paidAt: iso(p.paid_at), failedAt: iso(p.failed_at), expiredAt: iso(p.expired_at), refundedAt: iso(p.refunded_at), verifiedVia: p.verified_via, lastError: p.last_error, lastRejection: p.last_rejection, testMode: !p.livemode, label: p.livemode ? '' : pkgLabel() };
  }
  const pkgPaymentOf = ps => ps.length ? (ps.find(p => p.status === 'paid') || ps.find(p => p.status === 'refunded') || ps[ps.length - 1]) : null;
  function leadView(l, bs, ps, noteCount, full) {
    const pb = primaryBooking(bs), s = C.svc(l.service_id), pp = pkgPaymentOf(ps), paid = ps.some(p => p.status === 'paid');
    const o = { id: l.id, name: l.name, phone: l.phone, email: l.email, source: l.source, service: l.service_id, serviceName: s.name, price: l.price_hkd, priceLabel: C.fmt(l.price_hkd), stage: l.stage, consentPics: l.consent_pics, marketingOptIn: l.marketing_opt_in, paymentStatus: l.payment_status, created: iso(l.created_at), customerId: l.customer_id, bookingDate: pb ? pb.date : null, bookingTime: pb ? pb.time : null, attendance: pb ? pb.status : null, bookingId: pb ? pb.id : null, noteCount, sampleSale: !!l.sample_sale, isSample: !!l.is_sample, anonymised: !!l.anonymised_at, packagePaymentStatus: pp ? pp.status : 'not_started', packagePayment: payView(pp) };
    if (l.stage === 'Package Consultation' || l.stage === 'Package Sold' || pp) o.consultation = { productName: pkgProduct(), serviceName: C.PKG.name, priceLabel: C.fmt(C.PKG.price), unitAmount: C.PKG_UNIT_AMOUNT, currency: C.PKG_CURRENCY, label: pkgLabel(), testMode: !cfg.STRIPE_LIVE, canCreateCheckout: l.stage === 'Package Consultation' && !paid };
    return o;
  }
  async function bookingViews(rows) {
    if (!rows.length) return [];
    const rems = await all('select booking_id, kind, state from reminders where booking_id = any($1) and void = false', [rows.map(b => b.id)]);
    const by = {}; rems.forEach(r => (by[r.booking_id] = by[r.booking_id] || {})[r.kind] = r.state);
    return rows.map(b => ({ id: b.id, leadId: b.lead_id, name: b.lead_name, phone: b.lead_phone, service: b.service_id, serviceName: C.svc(b.service_id).name, priceLabel: C.fmt(b.price_hkd), date: b.date, time: b.time, status: b.status, reminders: by[b.id] || {}, created: iso(b.created_at), stage: b.lead_stage, paymentStatus: b.lead_payment }));
  }
  const BK_SELECT = 'select b.*, l.name lead_name, l.phone lead_phone, l.stage lead_stage, l.payment_status lead_payment from bookings b join leads l on l.id = b.lead_id';
  async function listLeads(f) {
    const w = ['l.anonymised_at is null'], p = [];
    const add = (sql, v) => { p.push(v); w.push(sql.replace(/\?/g, '$' + p.length)); };
    if (f.q) add("(lower(l.name) like ? or l.phone like ? or lower(coalesce(l.email,'')) like ? or lower(l.id) like ?)", '%' + f.q.toLowerCase().replace(/[%_\\]/g, '') + '%');
    if (f.stage) add('l.stage = ?', f.stage); if (f.service) add('l.service_id = ?', f.service); if (f.source) add('l.source = ?', f.source);
    if (f.marketing === 'true' || f.marketing === 'false') add('l.marketing_opt_in = ?', f.marketing === 'true');
    if (!f.includeSample) w.push('l.is_sample = false');
    const ls = await all(`select l.* from leads l where ${w.join(' and ')} order by l.created_at desc, l.id desc limit 1000`, p);
    const ids = ls.map(l => l.id);
    const bks = ids.length ? await all('select * from bookings where lead_id = any($1)', [ids]) : [], pays = ids.length ? await all('select * from payments where lead_id = any($1) order by created_at', [ids]) : [];
    const nc = ids.length ? await all('select lead_id, count(*)::int n from lead_notes where lead_id = any($1) group by 1', [ids]) : [];
    const total = (await one('select count(*)::int n from leads where anonymised_at is null' + (f.includeSample ? '' : ' and is_sample = false'))).n;
    return { leads: ls.map(l => leadView(l, bks.filter(b => b.lead_id === l.id), pays.filter(x => x.lead_id === l.id), (nc.find(x => x.lead_id === l.id) || { n: 0 }).n)), total };
  }
  async function getLead(id, client) {
    const l = await one('select * from leads where id = $1', [id], client); if (!l) throw notFound('找不到客戶');
    const bks = await all('select * from bookings where lead_id = $1 order by date, time', [id], client), ps = await all('select * from payments where lead_id = $1 order by created_at', [id], client);
    const notes = await all('select at, by_name, text from lead_notes where lead_id = $1 order by id', [id], client), hist = await all('select * from lead_history where lead_id = $1 order by id', [id], client);
    const o = leadView(l, bks, ps, notes.length, true);
    o.payments = ps.map(payView); o.notes = notes.map(n => ({ at: iso(n.at), by: n.by_name, text: n.text }));
    o.history = hist.map(h => h.kind === 'payment' ? { kind: 'payment', ...(h.payload || {}), at: iso(h.at), by: h.by_name, why: h.why } : { from: h.from_stage, to: h.to_stage, at: iso(h.at), by: h.by_name, why: h.why });
    o.bookings = await bookingViews(bks.map(b => ({ ...b, lead_name: l.name, lead_phone: l.phone, lead_stage: l.stage, lead_payment: l.payment_status })));
    return o;
  }
  async function bookingsBetween(from, to) {
    const rows = await all(BK_SELECT + " where b.date between $1 and $2 and l.anonymised_at is null order by b.date, b.time", [from, to]);
    const caps = await all('select date, time, capacity from slot_caps where date between $1 and $2', [from, to]); const cm = {}; caps.forEach(c => cm[c.date + ' ' + c.time] = c.capacity);
    return { bookings: await bookingViews(rows), capacity: cm, defaultCapacity: C.DEFAULT_CAPACITY };
  }

  // ================= bookings =================
  async function createBooking(inp, who) {
    // who: {staff?:user, customer?:user, force?:bool}
    const s = C.svc(inp.service); if (!s) throw bad('請選擇服務');
    const date = inp.date, time = inp.time, staff = !!who.staff;
    let name, ph, em;
    if (!inp.leadId) {
      name = str(inp.name, 60, '稱呼', true); ph = phone(inp.phone, true); em = email(inp.email, false);
      if (!staff && inp.consent !== true) throw bad('請剔選同意《收集個人資料聲明》');
    }
    const note = str(inp.note, 300, '備註', false);
    const token = crypto.randomBytes(18).toString('base64url');
    const res = await db.tx(async c => {
      await checkSlot(c, date, time, null, { staff, force: !!(staff && who.force) });
      let lead;
      if (inp.leadId) { lead = await one('select * from leads where id = $1 and anonymised_at is null for update', [inp.leadId], c); if (!lead) throw notFound('找不到客戶'); }
      else {
        lead = await one("select * from leads where phone = $1 and stage <> 'Lost' and anonymised_at is null and ($2::text is null or customer_id is null or customer_id = $2) and not (customer_id is not null and $2::text is null) order by created_at desc limit 1 for update", [ph, who.customer ? who.customer.id : null], c);
        const source = staff ? (C.SOURCES.includes(inp.source) && inp.source !== 'sample' ? inp.source : 'walk-in') : 'website';
        if (!lead) {
          lead = await one('insert into leads(name, phone, email, source, service_id, price_hkd, consent_pics, consent_at, customer_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *', [name, ph, em || null, source, s.id, s.price, inp.consent === true, inp.consent === true ? new Date() : null, who.customer ? who.customer.id : null], c);
          await q('insert into lead_history(lead_id, from_stage, to_stage, by_name, why) values ($1,null,$2,$3,$4)', [lead.id, 'New Trial Lead', staff ? who.staff.name : '系統', '建立體驗預約'], c);
        } else {
          await q('update leads set service_id = $2, price_hkd = $3, email = coalesce(email, $4), customer_id = coalesce(customer_id, $5) where id = $1', [lead.id, s.id, s.price, em || null, who.customer ? who.customer.id : null], c);
        }
        if (!staff) await q('update leads set consent_pics = true, consent_at = coalesce(consent_at, now()), marketing_opt_in = $2, marketing_at = now() where id = $1', [lead.id, inp.marketing === true], c);
        else if (typeof inp.marketing === 'boolean') await q('update leads set marketing_opt_in = $2, marketing_at = now() where id = $1', [lead.id, inp.marketing], c);
        if (note) await addNoteTx(c, lead.id, '客人備註：' + note, staff ? who.staff.name : '客人');
      }
      await q('update leads set service_id = $2, price_hkd = $3 where id = $1', [lead.id, s.id, s.price], c);
      const b = await one('insert into bookings(lead_id, service_id, price_hkd, date, time, manage_token_hash) values ($1,$2,$3,$4,$5,$6) returning *', [lead.id, s.id, s.price, date, time, S.sha256(token)], c);
      await makeReminders(c, b);
      const conf = await one("select * from reminders where booking_id = $1 and kind = 'confirmation'", [b.id], c); await genDraft(c, conf);
      await addNoteTx(c, lead.id, `系統：已建立預約 ${b.id}（${date} ${time}），並產生確認訊息草稿（未發送）。`, '系統');
      if (staff) await audit.log({ kind: 'staff', id: who.staff.id, name: who.staff.name }, 'booking.created', { type: 'booking', id: b.id }, { lead: lead.id }, c);
      return { booking: b, lead };
    });
    return { ...res, token };
  }
  const canChange = (b, staff) => { if (!staff && tsOf(b.date, b.time) - Date.now() < 24 * 3600e3) throw bad('預約前 24 小時內不能自助改期或取消，請聯絡本店。'); };
  async function cancelBooking(id, who) {
    return db.tx(async c => {
      const b = await one('select * from bookings where id = $1 for update', [id], c); if (!b) throw notFound('找不到預約');
      if (b.status === 'cancelled') return b; if (b.status !== 'booked') throw bad('此預約已完成，不能取消');
      canChange(b, !!who.staff);
      await q("update bookings set status = 'cancelled' where id = $1", [id], c);
      await q("update reminders set void = true where booking_id = $1 and state <> 'sent'", [id], c);
      await addNoteTx(c, b.lead_id, `系統：預約 ${b.id} 已取消（${who.staff ? who.staff.name : '客人'}）。`, '系統');
      if (who.staff) await audit.log({ kind: 'staff', id: who.staff.id, name: who.staff.name }, 'booking.cancelled', { type: 'booking', id }, null, c);
      return b;
    });
  }
  async function rescheduleBooking(id, date, time, who) {
    return db.tx(async c => {
      const b = await one('select * from bookings where id = $1 for update', [id], c); if (!b) throw notFound('找不到預約');
      if (b.status !== 'booked') throw bad('只有「已預約」的預約可以改期'); canChange(b, !!who.staff);
      await checkSlot(c, date, time, id, { staff: !!who.staff, force: !!(who.staff && who.force) });
      const old = `${b.date} ${b.time}`; await q('update bookings set date = $2, time = $3 where id = $1', [id, date, time], c);
      const nb = { ...b, date, time }, rs = await all('select * from reminders where booking_id = $1 for update', [id], c);
      for (const r of rs) {
        if (r.kind === 'confirmation') { await q('update reminders set void = false, sent_via = null, sent_at = null, delivery_status = null where id = $1', [r.id], c); await genDraft(c, r, true); }
        else if (r.state !== 'sent') await q("update reminders set void = false, state = 'pending', draft_whatsapp = null, draft_email_subject = null, draft_email_body = null, scheduled_for = $2 where id = $1", [r.id, scheduleFor(r.kind, nb)], c);
      }
      await addNoteTx(c, b.lead_id, `系統：預約 ${b.id} 由 ${old} 改期至 ${date} ${time}（${who.staff ? who.staff.name : '客人'}）。`, '系統');
      if (who.staff) await audit.log({ kind: 'staff', id: who.staff.id, name: who.staff.name }, 'booking.rescheduled', { type: 'booking', id }, null, c);
      return nb;
    });
  }
  async function setAttendance(id, status, actor) {
    if (!C.ATTENDANCE.includes(status)) throw bad('出席狀態不正確');
    await db.tx(async c => {
      const b = await one('select * from bookings where id = $1 for update', [id], c); if (!b) throw notFound('找不到預約');
      await q('update bookings set status = $2 where id = $1', [id, status], c);
      if (status === 'cancelled') await q("update reminders set void = true where booking_id = $1 and state <> 'sent'", [id], c);
      else await q("update reminders set void = $2 where booking_id = $1 and state <> 'sent'", [id, status !== 'booked'], c);
      await addNoteTx(c, b.lead_id, `系統：預約 ${b.id} 出席狀態設為 ${status}。`, actor.name);
      if (status === 'attended') { const lead = await one('select id, stage from leads where id = $1 for update', [b.lead_id], c); if (C.STAGES.indexOf(lead.stage) < C.STAGES.indexOf('Attended')) await moveStageTx(c, lead, 'Attended', actor.name, '標記為已出席'); }
      await audit.log({ kind: 'staff', id: actor.id, name: actor.name }, 'booking.attendance', { type: 'booking', id }, { status }, c);
    });
  }
  async function setSlotCapacity(date, time, n, actor) {
    if (!validDate(date) || !C.TIMES.includes(time)) throw bad('日期或時段不正確'); n = Number(n); if (!Number.isInteger(n) || n < 0 || n > 20) throw bad('名額須為 0–20 的整數');
    await q('insert into slot_caps(date, time, capacity) values ($1,$2,$3) on conflict (date, time) do update set capacity = excluded.capacity', [date, time, n]);
    await audit.log({ kind: 'staff', id: actor.id, name: actor.name }, 'slot.capacity', { type: 'slot', id: date + ' ' + time }, { capacity: n });
  }
  // customer / token access to one booking
  async function bookingForAccess(id, token, staffUser, cust) {
    const b = await one('select b.*, l.customer_id, l.name lead_name, l.phone lead_phone, l.stage lead_stage, l.payment_status lead_payment from bookings b join leads l on l.id = b.lead_id where b.id = $1 and l.anonymised_at is null', [id]);
    if (!b) throw notFound('找不到預約記錄');
    if (staffUser) return { b, who: { staff: staffUser } };
    if (cust && b.customer_id === cust.id) return { b, who: { customer: cust } };
    if (token && b.manage_token_hash && S.safeEq(S.sha256(token), b.manage_token_hash)) return { b, who: {} };
    throw notFound('找不到預約記錄');
  }
  const canSelfChange = b => b.status === 'booked' && tsOf(b.date, b.time) - Date.now() >= 24 * 3600e3;

  // ================= dashboard =================
  async function dashboard() {
    const inc = cfg.SITE_DEMO_MODE, lf = inc ? '' : ' and l.is_sample = false', today = todayStr(), wkEnd = addDays(today, 6);
    const base = "from bookings b join leads l on l.id = b.lead_id join services s on s.id = b.service_id where l.anonymised_at is null" + lf;
    const trials = (await one("select count(*)::int n " + base + " and s.kind = 'trial' and b.status <> 'cancelled'")).n;
    const att = await one("select count(*) filter (where b.status = 'attended')::int a, count(*) filter (where b.status = 'no-show')::int ns " + base);
    const consult = (await one("select count(distinct h.lead_id)::int n from lead_history h join leads l on l.id = h.lead_id where h.to_stage = 'Package Consultation' and l.anonymised_at is null" + lf)).n;
    const pays = await all('select p.status, p.livemode, count(*)::int n from payments p join leads l on l.id = p.lead_id where true' + lf + ' group by 1,2');
    const cnt = (st, live) => pays.filter(x => x.status === st && x.livemode === live).reduce((a, x) => a + x.n, 0);
    const paidTest = cnt('paid', false), paidLive = cnt('paid', true), pkg = C.PKG.price;
    const inPkg = await all("select l.id, (select p.status from payments p where p.lead_id = l.id order by (p.status = 'paid') desc, (p.status = 'refunded') desc, p.created_at desc limit 1) ps from leads l where l.anonymised_at is null" + lf + " and (l.id in (select lead_id from lead_history where to_stage = 'Package Consultation') or l.id in (select lead_id from payments))");
    const breakdown = {}; C.PKG_PAY_STATUS.forEach(k => breakdown[k] = 0); inPkg.forEach(r => breakdown[r.ps || 'not_started']++);
    const sampleSold = (await one("select count(*)::int n from leads l where l.stage = 'Package Sold' and l.sample_sale = true and not exists (select 1 from payments p where p.lead_id = l.id and p.status = 'paid')" + lf)).n;
    const stg = await all('select stage, count(*)::int n from leads l where anonymised_at is null' + lf + ' group by 1'); const stm = {}; stg.forEach(r => stm[r.stage] = r.n);
    const funnel = C.STAGES.map(s => ({ stage: s, zh: C.STAGE_ZH[s], count: stm[s] || 0 }));
    const up = await bookingViews(await all(BK_SELECT + " where b.status = 'booked' and b.date between $1 and $2 and l.anonymised_at is null" + lf + ' order by b.date, b.time', [today, wkEnd]));
    const rem = await one(`select count(*) filter (where r.state = 'pending' and b.status = 'booked')::int pending, count(*) filter (where r.state = 'drafted' and b.status = 'booked')::int drafted, count(*) filter (where r.state = 'sent')::int sent, count(*) filter (where r.state = 'failed')::int failed from reminders r join bookings b on b.id = r.booking_id join leads l on l.id = b.lead_id where r.void = false and l.anonymised_at is null${lf}`);
    const total = (await one('select count(*)::int n from leads l where anonymised_at is null' + lf)).n;
    const live = cfg.STRIPE_LIVE;
    return {
      today, trialBookings: trials, attended: att.a, noShow: att.ns, attendanceRate: att.a + att.ns ? att.a / (att.a + att.ns) : null, packageConsultations: consult,
      stripe: { mode: cfg.STRIPE_MODE, live, modeLabel: live ? 'Stripe 正式模式（live）：只計算已驗證的真實付款' : 'Test Mode - sample data, not real revenue', count: live ? paidLive : paidTest, value: (live ? paidLive : paidTest) * pkg, valueLabel: C.fmt((live ? paidLive : paidTest) * pkg), unitLabel: C.fmt(pkg), statusBreakdown: breakdown, otherModeCount: live ? paidTest : paidLive },
      sampleSales: { label: 'Sample data (seeded), not Stripe payments', count: sampleSold, valueLabel: C.fmt(sampleSold * pkg) },
      totalLeads: total, includesSample: inc, funnel, upcomingToday: up.filter(b => b.date === today), upcomingWeek: up, reminders: rem
    };
  }

  return { todayStr, addDays, dow, tsOf, validDate, str, phone, email, availability, checkSlot, runScheduler, reminderView, listReminders, setReminderState, genDraft, makeReminders, moveStage, moveStageTx, addNote, addNoteTx, setPaymentMark, leadView, listLeads, getLead, bookingViews, bookingsBetween, createBooking, cancelBooking, rescheduleBooking, setAttendance, setSlotCapacity, bookingForAccess, canSelfChange, dashboard, payView, pkgLabel, pkgProduct, payLabel, unsubLink, verifyUnsub, draftsFor, hasMsgAddr, advanceAfterReminder, primaryBooking };
};
module.exports.helpers = { todayStr, addDays, dow, tsOf, validDate, str, phone, email, iso };
