'use strict';
// Optional REAL sending of transactional booking confirmations/reminders. DISABLED by default.
// Hard rules enforced here (not just in the UI):
//  * NOTIFY_ENABLED must be true, and the channel must be enabled + configured (or NOTIFY_DRY_RUN for a rehearsal);
//  * only booked, non-cancelled trial/single bookings; never anonymised leads;
//  * each message needs explicit staff approval of that reminder, OR the admin setting "auto-send" (default OFF);
//  * category is transactional; marketing is blocked unless the lead has the separate marketing opt-in;
//  * suppression list (unsubscribe) is always respected; every message carries an opt-out line.
const S = require('./security'), C = require('./constants'), E = require('./errors'); const { bad, notFound, forbidden } = E;

module.exports = ctx => {
  const { db, cfg, log } = ctx, audit = ctx.audit, q = db.q, one = db.one, all = db.all;
  const normAddr = (ch, a) => { if (ch === 'email') return String(a || '').trim().toLowerCase(); const d = String(a || '').replace(/\D/g, ''); return d.length === 8 ? '852' + d : d; };
  const addrHash = (ch, a) => S.sha256(ch + '|' + normAddr(ch, a));
  async function getSetting(key, d) { const r = await one('select value from settings where key = $1', [key]); return r ? r.value : d; }
  async function setSetting(key, value, actor) { await q('insert into settings(key, value, updated_by) values ($1,$2,$3) on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by', [key, JSON.stringify(value), actor ? actor.name : null]); }
  const autoSendEnabled = async () => (await getSetting('auto_send_reminders', false)) === true;

  // ---------- suppression list ----------
  async function isSuppressed(ch, a) { return !!(await one('select 1 from suppression_list where channel = $1 and address_hash = $2', [ch, addrHash(ch, a)])); }
  async function suppress(ch, a, reason, by) {
    if (!['email', 'whatsapp'].includes(ch)) throw bad('渠道不正確'); if (!normAddr(ch, a)) throw bad('請填寫地址／電話');
    await q("insert into suppression_list(channel, address_hash, reason, created_by) values ($1,$2,$3,$4) on conflict (channel, address_hash) do nothing", [ch, addrHash(ch, a), String(reason || 'unsubscribe').slice(0, 60), by || null]);
  }
  const unsuppress = (ch, hash) => q('delete from suppression_list where channel = $1 and address_hash like $2', [ch, String(hash).replace(/[^a-f0-9]/g, '') + '%']);
  const listSuppression = () => all('select channel, substr(address_hash,1,10) as ref, reason, created_by, created_at from suppression_list order by created_at desc limit 500');
  // customer-facing unsubscribe link (HMAC-signed, no login needed)
  async function unsubscribe(channel, addr, sig) {
    if (!ctx.core.verifyUnsub(channel, addr, sig)) throw bad('退訂連結無效。');
    await suppress(channel, addr, 'unsubscribe-link', null); await audit.log({ kind: 'customer' }, 'suppression.added', { type: 'suppression', id: channel }, { via: 'link' });
  }

  // ---------- eligibility ----------
  function channelStatus() {
    const email = !!ctx.providers.email, wa = !!ctx.providers.whatsapp;
    return { enabled: cfg.NOTIFY_ENABLED, dryRun: cfg.NOTIFY_DRY_RUN, email: { configured: email, enabled: cfg.NOTIFY_ENABLED && cfg.NOTIFY_EMAIL && (email || cfg.NOTIFY_DRY_RUN) }, whatsapp: { configured: wa, enabled: cfg.NOTIFY_ENABLED && cfg.NOTIFY_WHATSAPP && (wa || cfg.NOTIFY_DRY_RUN) }, autoSend: null };
  }
  function check(r, lead, b, ch, category) {
    category = category || 'transactional';
    if (!cfg.NOTIFY_ENABLED) throw bad('真實發送功能未啟用（NOTIFY_ENABLED=false）。目前只會產生草稿。');
    if (ch === 'email' && !cfg.NOTIFY_EMAIL || ch === 'whatsapp' && !cfg.NOTIFY_WHATSAPP) throw bad('此渠道未啟用');
    if (!['email', 'whatsapp'].includes(ch)) throw bad('渠道不正確');
    if (category !== 'transactional' && !(category === 'marketing' && lead.marketing_opt_in)) throw forbidden('推廣訊息只可發給已另行同意推廣的客人。');
    if (lead.anonymised_at) throw bad('客戶資料已匿名化');
    if (r.void || b.status !== 'booked') throw bad('預約已取消或已完成，不會發送');
    if (!['trial', 'single'].includes(C.svc(b.service_id).kind)) throw bad('只可為已預約的體驗／單次護理發送預約通知');
    if (!r.draft_whatsapp) throw bad('尚未產生草稿');
    if (ch === 'email' && !lead.email) throw bad('客人沒有提供電郵'); if (ch === 'whatsapp' && !lead.phone) throw bad('客人沒有電話');
    const to = ch === 'email' ? lead.email : normAddr('whatsapp', lead.phone);
    if (cfg.SEND_ONLY_TO_ALLOWLIST.length && !cfg.SEND_ONLY_TO_ALLOWLIST.includes(String(to).toLowerCase())) throw bad('目標不在 NOTIFY_TEST_ALLOWLIST 內（測試保護）。');
    return to;
  }

  // ---------- send ----------
  // actor: staff user (explicit approval) or null for auto-send (requires admin setting)
  async function send(reminderId, ch, actor, o) {
    o = o || {}; const auto = !actor;
    if (auto && !(await autoSendEnabled())) throw forbidden('自動發送未開啟（需要管理員在設定中啟用）。');
    const claim = await db.tx(async c => {
      const r = await one('select * from reminders where id = $1 for update', [reminderId], c); if (!r) throw notFound('找不到提醒');
      const b = await one('select * from bookings where id = $1', [r.booking_id], c), lead = await one('select * from leads where id = $1', [b.lead_id], c);
      if (r.state === 'sent') throw bad('此提醒已發出');
      if (r.delivery_status === 'sending' && Date.now() - new Date(r.delivery_updated_at).getTime() < 600e3) throw bad('正在發送中，請稍後再看狀態');
      const to = check(r, lead, b, ch, o.category);
      if (await isSuppressed(ch, to)) {
        await q("update reminders set delivery_channel = $2, delivery_status = 'suppressed', delivery_error = '地址在退訂名單內', delivery_updated_at = now() where id = $1", [r.id, ch], c);
        await q("insert into reminder_deliveries(reminder_id, channel, provider, status, error, created_by) values ($1,$2,'-','suppressed','on suppression list',$3)", [r.id, ch, actor ? actor.name : 'auto'], c);
        return { suppressed: true };
      }
      if (cfg.NOTIFY_DRY_RUN) {
        await q("update reminders set delivery_channel = $2, delivery_status = 'dry_run', delivery_provider = 'dry-run', delivery_error = null, delivery_updated_at = now(), approved_by = $3, approved_at = now() where id = $1", [r.id, ch, actor ? actor.name : 'auto-send'], c);
        await q("insert into reminder_deliveries(reminder_id, channel, provider, status, dry_run, created_by) values ($1,$2,'dry-run','dry_run',true,$3)", [r.id, ch, actor ? actor.name : 'auto'], c);
        log.info('DRY RUN: would send reminder', { reminder: r.id, channel: ch }); return { dryRun: true };
      }
      const provider = ch === 'email' ? ctx.providers.email : ctx.providers.whatsapp; if (!provider) throw bad('尚未設定此渠道的發送服務');
      await q("update reminders set delivery_channel = $2, delivery_status = 'sending', delivery_provider = $3, delivery_error = null, delivery_updated_at = now(), approved_by = $4, approved_at = now() where id = $1", [r.id, ch, provider.name, actor ? actor.name : 'auto-send'], c);
      return { r, b, lead, to, provider };
    });
    if (claim.suppressed) return { status: 'suppressed' }; if (claim.dryRun) return { status: 'dry_run' };
    const { r, b, lead, to, provider } = claim; let res, err = null;
    try {
      if (ch === 'email') res = await provider.send({ to, subject: r.draft_email_subject, text: r.draft_email_body, unsubscribeUrl: ctx.core.unsubLink('email', lead.email) });
      else {
        const tpl = cfg.WHATSAPP.templates[r.kind]; if (!tpl) throw new Error('沒有此類提醒的 WhatsApp 範本');
        const s = C.svc(b.service_id);
        res = await provider.sendTemplate({ to, template: tpl, lang: cfg.WHATSAPP.lang, params: [lead.name, `${s.name}（${C.fmt(b.price_hkd)}）`, `${b.date} ${b.time}`, b.id] });
      }
    } catch (e) { err = String(e.message || e).slice(0, 300); }
    await db.tx(async c => {
      if (!err) {
        await q("update reminders set state = 'sent', sent_via = $2, sent_by = $3, sent_at = now(), delivery_status = 'sent', delivery_message_id = $4, delivery_error = null, delivery_updated_at = now(), updated_at = now() where id = $1", [r.id, ch, actor ? actor.name : 'auto-send', res && res.id || null], c);
        await q("insert into reminder_deliveries(reminder_id, channel, provider, status, provider_message_id, created_by) values ($1,$2,$3,'sent',$4,$5)", [r.id, ch, provider.name, res && res.id || null, actor ? actor.name : 'auto'], c);
        await ctx.core.advanceAfterReminder(c, b.lead_id, actor ? actor.name : '系統', '提醒已經 ' + ch + ' 發出');
      } else {
        await q("update reminders set state = 'failed', delivery_status = 'failed', delivery_error = $2, delivery_updated_at = now(), updated_at = now() where id = $1", [r.id, err], c);
        await q("insert into reminder_deliveries(reminder_id, channel, provider, status, error, created_by) values ($1,$2,$3,'failed',$4,$5)", [r.id, ch, provider.name, err, actor ? actor.name : 'auto'], c);
      }
      await audit.log(actor ? { kind: 'staff', id: actor.id, name: actor.name } : { kind: 'system' }, 'reminder.send', { type: 'reminder', id: r.id }, { channel: ch, ok: !err, auto }, c);
    });
    if (err) throw new E.HttpError(502, '發送失敗：' + err);
    return { status: 'sent', messageId: res && res.id || null };
  }
  async function autoSendDue() {
    if (!cfg.NOTIFY_ENABLED || !(await autoSendEnabled())) return 0;
    const rows = await all(`select r.id, l.email from reminders r join bookings b on b.id = r.booking_id join leads l on l.id = b.lead_id
      where r.state = 'drafted' and r.void = false and r.scheduled_for <= now() and b.status = 'booked' and r.delivery_status is null and l.anonymised_at is null order by r.scheduled_for limit 25`);
    let n = 0;
    for (const r of rows) {
      const ch = (r.email && cfg.NOTIFY_EMAIL) ? 'email' : (cfg.NOTIFY_WHATSAPP ? 'whatsapp' : null); if (!ch) continue;
      try { await send(r.id, ch, null); n++; } catch (e) { log.warn('auto-send skipped', { reminder: r.id, err: e.message }); await q("update reminders set delivery_status = coalesce(delivery_status, 'skipped'), delivery_error = coalesce(delivery_error, $2), delivery_updated_at = now() where id = $1 and delivery_status is null", [r.id, String(e.message).slice(0, 200)]); }
    }
    return n;
  }
  return { getSetting, setSetting, autoSendEnabled, isSuppressed, suppress, unsuppress, listSuppression, unsubscribe, channelStatus, send, autoSendDue, check, normAddr };
};
