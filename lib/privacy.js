'use strict';
// Data subject rights (PDPO): export, delete/anonymise, retention purge. No HKID is ever collected.
const E = require('./errors'); const { notFound, bad } = E;
const iso = d => d instanceof Date ? d.toISOString() : d;
module.exports = ctx => {
  const { db, cfg } = ctx, audit = ctx.audit, q = db.q, one = db.one, all = db.all;
  async function exportLead(leadId, client) {
    const l = await one('select * from leads where id = $1', [leadId], client); if (!l) throw notFound('找不到客戶');
    const bks = await all('select id, service_id, price_hkd, date, time, status, created_at from bookings where lead_id = $1 order by date', [leadId], client);
    const rem = await all('select r.id, r.booking_id, r.kind, r.state, r.scheduled_for, r.sent_via, r.sent_at, r.delivery_status from reminders r join bookings b on b.id = r.booking_id where b.lead_id = $1 order by r.id', [leadId], client);
    const notes = await all('select at, by_name, text from lead_notes where lead_id = $1 order by id', [leadId], client);
    const hist = await all("select at, from_stage, to_stage, kind, why from lead_history where lead_id = $1 order by id", [leadId], client);
    const pays = await all('select id, status, amount_minor, currency, livemode, created_at, paid_at from payments where lead_id = $1 order by created_at', [leadId], client);
    return { lead: { id: l.id, name: l.name, phone: l.phone, email: l.email, source: l.source, service: l.service_id, stage: l.stage, consentPersonalData: l.consent_pics, consentAt: iso(l.consent_at), marketingOptIn: l.marketing_opt_in, marketingOptInAt: iso(l.marketing_at), createdAt: iso(l.created_at) }, bookings: bks, reminders: rem, staffNotes: notes, stageHistory: hist, payments: pays };
  }
  async function exportCustomer(customerId) {
    const c = await one('select id, name, email, phone, consent_at, created_at from customers where id = $1 and anonymised_at is null', [customerId]); if (!c) throw notFound('找不到會員');
    const leads = await all('select id from leads where customer_id = $1 and anonymised_at is null order by created_at', [customerId]);
    const out = { exportedAt: new Date().toISOString(), notice: '此檔案列出本店持有的你的個人資料。', account: c, records: [] };
    for (const l of leads) out.records.push(await exportLead(l.id)); return out;
  }
  async function anonymiseLeadTx(c, leadId) {
    await q("update leads set name = '已刪除客戶', phone = 'deleted:' || id, email = null, marketing_opt_in = false, consent_pics = false, customer_id = null, anonymised_at = now() where id = $1 and anonymised_at is null", [leadId], c);
    await q("update lead_notes set text = '[已刪除]', by_name = case when by_name = '系統' then '系統' else '員工' end where lead_id = $1", [leadId], c);
    await q("update lead_history set why = '' where lead_id = $1 and kind = 'stage'", [leadId], c);
    await q("update bookings set manage_token_hash = null, status = case when status = 'booked' then 'cancelled' else status end where lead_id = $1", [leadId], c);
    await q("update reminders set draft_whatsapp = null, draft_email_subject = null, draft_email_body = null, void = true where booking_id in (select id from bookings where lead_id = $1)", [leadId], c);
    await q("update payments set last_error = null, last_rejection = null where lead_id = $1", [leadId], c);
  }
  async function anonymiseLead(leadId, actor) {
    await db.tx(async c => {
      const l = await one('select id, anonymised_at from leads where id = $1 for update', [leadId], c); if (!l) throw notFound('找不到客戶'); if (l.anonymised_at) throw bad('此客戶資料已匿名化');
      await anonymiseLeadTx(c, leadId);
      await audit.log({ kind: 'staff', id: actor.id, name: actor.name }, 'lead.anonymised', { type: 'lead', id: leadId }, null, c);
    });
  }
  async function anonymiseCustomer(customerId, actor) {
    await db.tx(async c => {
      const cu = await one('select id, anonymised_at from customers where id = $1 for update', [customerId], c); if (!cu || cu.anonymised_at) throw notFound('找不到會員');
      const ls = await all('select id from leads where customer_id = $1 for update', [customerId], c);
      for (const l of ls) await anonymiseLeadTx(c, l.id);
      await q("update customers set name = '已刪除會員', email = null, phone = null, pw_hash = null, anonymised_at = now() where id = $1", [customerId], c);
      await ctx.auth.revokeAll('customer', customerId, c);
      await audit.log(actor || { kind: 'customer', id: customerId }, 'customer.anonymised', { type: 'customer', id: customerId }, { leads: ls.length }, c);
    });
  }
  // Retention: anonymise leads whose last booking is older than DATA_RETENTION_MONTHS. Package Sold / paid customers are kept (contract & accounting records: confirm period with your adviser).
  async function purgeExpired(months) {
    months = months || cfg.DATA_RETENTION_MONTHS;
    const rows = await all(`select l.id from leads l where l.anonymised_at is null and l.is_sample = false and l.stage <> 'Package Sold'
      and not exists (select 1 from payments p where p.lead_id = l.id and p.status in ('paid','refunded'))
      and not exists (select 1 from bookings b where b.lead_id = l.id and b.date > current_date - ($1::int * interval '1 month'))
      and l.created_at < now() - ($1::int * interval '1 month')`, [months]);
    for (const r of rows) await db.tx(async c => { await anonymiseLeadTx(c, r.id); await audit.log({ kind: 'system' }, 'lead.retention_purged', { type: 'lead', id: r.id }, { months }, c); });
    return rows.length;
  }
  return { exportLead, exportCustomer, anonymiseLead, anonymiseCustomer, purgeExpired };
};
