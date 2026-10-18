'use strict';
// Stripe Checkout for the 10-Session Package.
// RULE: a lead moves to Package Sold ONLY inside applyPaid(), after a verified successful payment
// (signed webhook + server-side retrieval, or staff "Verify payment" which re-reads the session from Stripe).
const crypto = require('crypto');
const C = require('./constants'), E = require('./errors'); const { bad, notFound, HttpError } = E;

module.exports = ctx => {
  const { db, cfg } = ctx, core = ctx.core, stripe = ctx.stripe, audit = ctx.audit; const q = db.q, one = db.one, all = db.all;
  const LIVE = cfg.STRIPE_LIVE, PFX = LIVE ? 'cs_live_' : 'cs_test_';
  const baseUrl = () => cfg.ORIGIN || `http://localhost:${cfg.PORT}`;
  const payTag = LIVE ? '' : '（Test Mode，樣本資料，非真實交易）';
  const histPay = (c, leadId, p, text, by) => q("insert into lead_history(lead_id, kind, by_name, why, payload) values ($1,'payment',$2,$3,$4)", [leadId, by || '系統', text, JSON.stringify({ payStatus: p.status, sessionId: p.session_id, paymentIntentId: p.payment_intent_id || null, amountMinor: p.amount_minor, currency: p.currency, livemode: p.livemode })], c);

  async function createCheckout(leadId, staff, opts) {
    opts = opts || {}; stripe.secretKey();            // throws (missing / wrong-mode key) BEFORE anything is stored
    const lead = await one('select * from leads where id = $1 and anonymised_at is null', [leadId]); if (!lead) throw notFound('找不到客戶');
    if (lead.stage !== 'Package Consultation') throw bad('只有在「套餐諮詢（Package Consultation）」階段的客戶才能建立 Stripe 付款。');
    if (await one("select 1 from payments where lead_id = $1 and status = 'paid'", [leadId])) throw new HttpError(409, '此客戶已有已驗證的 Stripe 付款。');
    const booking = await one("select * from bookings where lead_id = $1 order by (status = 'attended') desc, date desc, time desc limit 1", [leadId]); if (!booking) throw bad('此客戶沒有預約記錄，無法建立付款。');
    const open = await all("select * from payments where lead_id = $1 and status = 'pending'", [leadId]);
    const liveOne = open.find(p => !p.expires_at || new Date(p.expires_at) > new Date());
    if (liveOne && !opts.renew) return { payment: liveOne, reused: true };
    for (const p of open) {
      if (opts.renew) { try { await stripe.expireCheckoutSession(p.session_id); } catch (e) { /* best effort */ } }
      await db.tx(async c => {
        const r = await q("update payments set status = 'expired', expired_at = now(), updated_at = now(), last_error = $2 where id = $1 and status = 'pending' returning *", [p.id, opts.renew ? '已由員工重新建立連結' : '連結已逾時'], c);
        if (r.rows[0]) await histPay(c, leadId, r.rows[0], r.rows[0].last_error, staff.name);
      });
    }
    const meta = { lead_id: lead.id, booking_id: booking.id }; if (!LIVE) meta.sample_test_data = 'true';
    const params = { mode: 'payment', client_reference_id: lead.id,
      line_items: [{ quantity: 1, price_data: { currency: C.PKG_CURRENCY, unit_amount: C.PKG_UNIT_AMOUNT, product_data: Object.assign({ name: core.pkgProduct() }, LIVE ? {} : { description: core.pkgLabel() }) } }],
      metadata: meta, payment_intent_data: { metadata: meta },
      success_url: baseUrl() + '/checkout-result.html?result=success&session_id={CHECKOUT_SESSION_ID}', cancel_url: baseUrl() + '/checkout-result.html?result=cancel' };
    const s = await stripe.createCheckoutSession(params, crypto.randomBytes(16).toString('hex'));
    if (!s || typeof s.id !== 'string' || !s.id.startsWith(PFX) || s.livemode !== LIVE || typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) {
      if (s && typeof s.id === 'string') { try { await stripe.expireCheckoutSession(s.id); } catch (e) { /* ignore */ } }
      throw new HttpError(502, `Stripe 回傳的不是有效的${LIVE ? '正式' : '測試'}模式 Checkout Session（需 ${PFX} 及 livemode=${LIVE}），已拒絕。`);
    }
    try {
      const p = await db.tx(async c => {
        const row = await one("insert into payments(lead_id, booking_id, session_id, status, amount_minor, currency, livemode, checkout_url, expires_at, created_by) values ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9) returning *",
          [lead.id, booking.id, s.id, C.PKG_UNIT_AMOUNT, C.PKG_CURRENCY, LIVE, s.url, s.expires_at ? new Date(s.expires_at * 1000) : null, staff.name], c);
        await histPay(c, lead.id, row, '已建立 Stripe Checkout（待付款）。' + payTag, staff.name);
        await core.addNoteTx(c, lead.id, `系統：已建立 Stripe 付款連結（${s.id}），狀態 pending。連結只供員工複製／開啟，系統不會自動發送。${payTag}`, staff.name);
        await audit.log({ kind: 'staff', id: staff.id, name: staff.name }, 'payment.checkout_created', { type: 'payment', id: row.id }, { lead: lead.id, livemode: LIVE }, c);
        return row;
      });
      return { payment: p, reused: false };
    } catch (e) {
      if (e.code === '23505') { try { await stripe.expireCheckoutSession(s.id); } catch (x) { /* ignore */ } throw new HttpError(409, '另一位員工剛剛已建立付款連結，請重新整理。'); }
      throw e;
    }
  }

  function validateSession(s, p, lead) {
    if (!s || typeof s !== 'object') return '沒有 session 資料';
    if (s.id !== p.session_id) return 'session id 與紀錄不符';
    if (s.object && s.object !== 'checkout.session') return '物件類型不正確';
    if (s.mode && s.mode !== 'payment') return 'mode 不是 payment';
    if (s.payment_status !== 'paid') return 'payment_status 不是 paid（' + s.payment_status + '）';
    if (s.amount_total !== C.PKG_UNIT_AMOUNT) return '金額不符（需為 ' + C.PKG_UNIT_AMOUNT + '）';
    if (s.currency !== C.PKG_CURRENCY) return '貨幣不符（需為 hkd）';
    if (s.livemode !== LIVE) return `livemode 與系統模式不符（系統為 ${LIVE ? 'live' : 'test'}）`;
    const m = s.metadata || {};
    if (m.lead_id !== lead.id || m.booking_id !== p.booking_id) return 'metadata 與客戶／預約不符';
    if (s.client_reference_id !== lead.id) return 'client_reference_id 與客戶不符';
    if (p.amount_minor !== C.PKG_UNIT_AMOUNT || p.currency !== C.PKG_CURRENCY || p.livemode !== LIVE) return '本地付款紀錄不一致';
    return null;
  }
  // must be called inside a transaction (client c); locks the payment row. Idempotent.
  async function applyPaid(c, paymentId, s, via) {
    const p = await one('select * from payments where id = $1 for update', [paymentId], c); if (!p) return { changed: false, rejected: '找不到付款紀錄' };
    if (p.status === 'paid' || p.status === 'refunded') return { changed: false, already: true };
    const lead = await one('select * from leads where id = $1 for update', [p.lead_id], c); if (!lead || lead.anonymised_at) return { changed: false, rejected: '找不到客戶' };
    const why = validateSession(s, p, lead);
    if (why) {
      await q('update payments set last_rejection = $2, updated_at = now() where id = $1', [p.id, JSON.stringify({ reason: why, at: new Date().toISOString(), via })], c);
      await core.addNoteTx(c, lead.id, `系統：Stripe 付款驗證被拒絕（${why}）。未更改階段。`, '系統');
      await audit.log({ kind: 'system' }, 'payment.rejected', { type: 'payment', id: p.id }, { reason: why, via }, c);
      return { changed: false, rejected: why };
    }
    const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || p.payment_intent_id || null;
    const np = await one("update payments set status = 'paid', paid_at = now(), updated_at = now(), verified_via = $2, last_error = null, last_rejection = null, payment_intent_id = $3 where id = $1 returning *", [p.id, via, pi], c);
    await histPay(c, lead.id, np, `Stripe 付款已驗證（${via}）：paid，金額 ${C.fmt(np.amount_minor / 100)}${LIVE ? '' : '（測試套餐價值，非真實收入）'}`, via === 'webhook' ? 'Stripe webhook' : '員工驗證');
    await core.moveStageTx(c, lead, 'Package Sold', via === 'webhook' ? 'Stripe webhook' : '員工驗證 Stripe 付款', `已驗證 Stripe 付款 ${p.session_id}，付款狀態 paid${payTag}`, { verifiedPayment: true });
    await core.addNoteTx(c, lead.id, `系統：已驗證 Stripe 付款 ${p.session_id}（payment_intent ${pi || '—'}），已移至 Package Sold。${LIVE ? '' : '這是 Test Mode 樣本資料，並非真實交易或真實收入。'}`, '系統');
    await audit.log({ kind: 'system' }, 'payment.paid', { type: 'payment', id: p.id }, { lead: lead.id, via, livemode: LIVE }, c);
    return { changed: true };
  }
  async function setStatus(c, p, status, text, col) {
    if (p.status === status) return false;
    await q(`update payments set status = $2, updated_at = now(), ${col} = now(), last_error = $3 where id = $1`, [p.id, status, text], c);
    const np = { ...p, status }; await histPay(c, p.lead_id, np, text); await core.addNoteTx(c, p.lead_id, `系統：Stripe 付款（${p.session_id}）狀態 → ${status}。${text}`, '系統'); return true;
  }

  async function verifyPayment(leadId, staff) {
    if (await one("select 1 from payments where lead_id = $1 and status = 'paid'", [leadId])) return { result: 'already_paid', message: '此付款已驗證為 paid。' };
    const p = await one("select * from payments where lead_id = $1 and status in ('pending','failed') order by created_at desc limit 1", [leadId]);
    if (!p) throw bad('沒有待驗證的 Stripe 付款紀錄，請先建立 Stripe 付款。');
    const s = await stripe.retrieveCheckoutSession(p.session_id);   // server-side retrieve with our own key
    if (s.payment_status === 'paid') {
      const r = await db.tx(async c => { const x = await applyPaid(c, p.id, s, 'staff-verify'); await audit.log({ kind: 'staff', id: staff.id, name: staff.name }, 'payment.verify', { type: 'payment', id: p.id }, { result: x.rejected ? 'rejected' : 'paid' }, c); return x; });
      if (r.rejected) throw new HttpError(409, '驗證未通過，未移動階段：' + r.rejected);
      return { result: 'paid', message: `已向 Stripe 取回 session，確認為${LIVE ? '' : '測試模式'}已付款，已移至 Package Sold。` };
    }
    if (s.status === 'expired') { await db.tx(async c => { const cur = await one('select * from payments where id = $1 for update', [p.id], c); await setStatus(c, cur, 'expired', 'Stripe 顯示 session 已逾時。', 'expired_at'); }); return { result: 'expired', message: 'Stripe 顯示此連結已逾時（expired）。請重新建立。' }; }
    return { result: 'pending', message: `Stripe 顯示尚未付款（payment_status=${s.payment_status}，status=${s.status}）。階段不會改變。` };
  }

  // ---- webhook events (signature already verified by caller) ----
  async function handleEvent(ev) {
    if (!ev || typeof ev.id !== 'string' || typeof ev.type !== 'string' || !ev.data || typeof ev.data.object !== 'object') return { ignored: 'malformed_event' };
    if (await one('select 1 from processed_events where event_id = $1', [ev.id])) return { duplicate: true };
    let retrieved = null;
    if (ev.livemode === LIVE && ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type) && ev.data.object.payment_status === 'paid' && await one('select 1 from payments where session_id = $1', [ev.data.object.id]))
      retrieved = await stripe.retrieveCheckoutSession(ev.data.object.id);      // never trust the webhook body alone
    return db.tx(async c => {
      const ins = await q('insert into processed_events(event_id, type) values ($1,$2) on conflict (event_id) do nothing', [ev.id, ev.type], c);
      if (!ins.rowCount) return { duplicate: true };                           // idempotent: concurrent/replayed delivery
      const res = ev.livemode !== LIVE ? { ignored: 'livemode_mismatch' } : await route(c, ev, retrieved);
      await q('update processed_events set result = $2 where event_id = $1', [ev.id, Object.keys(res)[0] || 'ok'], c);
      return res;
    });
  }
  async function route(c, ev, retrieved) {
    const o = ev.data.object; const bySession = id => one('select * from payments where session_id = $1 for update', [id], c);
    switch (ev.type) {
      case 'checkout.session.completed': case 'checkout.session.async_payment_succeeded': {
        const p = await bySession(o.id); if (!p) return { ignored: 'unknown_session' };
        if (o.payment_status !== 'paid') return { ignored: 'not_paid_yet' };
        const r = await applyPaid(c, p.id, retrieved || o, 'webhook'); return r.rejected ? { rejected: r.rejected } : r.already ? { already: true } : { applied: true };
      }
      case 'checkout.session.async_payment_failed': { const p = await bySession(o.id); if (!p) return { ignored: 'unknown_session' }; if (['paid', 'refunded'].includes(p.status)) return { ignored: 'already_final' }; return { updated: await setStatus(c, p, 'failed', 'Stripe 通知延遲付款失敗。', 'failed_at') }; }
      case 'checkout.session.expired': { const p = await bySession(o.id); if (!p) return { ignored: 'unknown_session' }; if (!['pending', 'failed'].includes(p.status)) return { ignored: 'already_final' }; return { updated: await setStatus(c, p, 'expired', 'Checkout 連結已逾時。', 'expired_at') }; }
      case 'payment_intent.payment_failed': {
        const m = o.metadata || {};
        let p = await one('select * from payments where payment_intent_id = $1 for update', [o.id], c);
        if (!p && m.lead_id) p = await one("select * from payments where lead_id = $1 and booking_id = $2 and status = 'pending' order by created_at desc limit 1 for update", [m.lead_id, m.booking_id], c);
        if (!p) return { ignored: 'unknown_payment' }; if (p.status !== 'pending') return { ignored: 'not_pending' };
        const msg = (o.last_payment_error && o.last_payment_error.message) ? stripe.redact(o.last_payment_error.message).slice(0, 200) : '付款失敗';
        if (!p.payment_intent_id) await q('update payments set payment_intent_id = $2 where id = $1', [p.id, o.id], c);
        return { updated: await setStatus(c, p, 'failed', '付款失敗：' + msg, 'failed_at') };
      }
      case 'charge.refunded': {
        const pi = typeof o.payment_intent === 'string' ? o.payment_intent : null; const p = pi && await one('select * from payments where payment_intent_id = $1 for update', [pi], c);
        if (!p) return { ignored: 'unknown_payment' }; if (p.status !== 'paid') return { ignored: 'not_paid' }; if (o.refunded !== true) return { ignored: 'partial_refund_not_tracked' };
        return { updated: await setStatus(c, p, 'refunded', '付款已全數退款。階段維持不變，請由員工人手跟進。', 'refunded_at') };
      }
      default: return { ignored: 'unhandled_type' };
    }
  }
  return { createCheckout, verifyPayment, handleEvent, applyPaid, validateSession };
};
