'use strict';
// OPTIONAL sample data. Runs ONLY when SEED_DEMO_DATA=true (or `npm run seed` with that flag) and the DB has no leads.
// Every record is flagged is_sample=true, uses fictional names, +852 5550 xxxx numbers and example.com e-mails.
// No demo accounts/passwords are created: sign in with the admin you created via ADMIN_EMAIL/ADMIN_PASSWORD.
const C = require('./constants');
// [name, service, stage, dayOffset, time, status, payment, marketing, source]
const ROWS = [
  ['陳示範甲', 'hf-trial', 'Package Sold', -21, '10:00', 'attended', 'paid', true, 'website'],
  ['李示範乙', 'laser-trial', 'Package Sold', -18, '11:30', 'attended', 'paid', false, 'social'],
  ['黃示範丙', 'hf-trial', 'Package Consultation', -9, '13:00', 'attended', 'unpaid', false, 'website'],
  ['張示範丁', 'hf-single', 'Attended', -7, '14:30', 'attended', 'paid', false, 'referral'],
  ['劉示範戊', 'laser-trial', 'Attended', -6, '16:00', 'attended', 'unpaid', true, 'website'],
  ['周示範己', 'hf-trial', 'Lost', -8, '10:00', 'no-show', 'unpaid', false, 'whatsapp'],
  ['吳示範庚', 'hf-trial', 'Lost', -5, '17:30', 'no-show', 'unpaid', false, 'website'],
  ['徐示範辛', 'hf-trial', 'Package Consultation', -4, '11:30', 'attended', 'unpaid', true, 'website'],
  ['何示範壬', 'hf-single', 'Attended', -3, '13:00', 'attended', 'paid', false, 'walk-in'],
  ['林示範癸', 'hf-trial', 'Confirmed', 1, '10:00', 'booked', 'unpaid', false, 'website'],
  ['梁示範子', 'laser-trial', 'Reminder Sent', 0, '17:30', 'booked', 'unpaid', false, 'whatsapp'],
  ['鄭示範丑', 'hf-trial', 'New Trial Lead', 2, '14:30', 'booked', 'unpaid', false, 'website'],
  ['蔡示範寅', 'package10', 'New Trial Lead', 3, '11:30', 'booked', 'unpaid', false, 'website'],
  ['馮示範卯', 'hf-single', 'Confirmed', 4, '16:00', 'booked', 'unpaid', true, 'social'],
  ['羅示範辰', 'laser-trial', 'New Trial Lead', 5, '13:00', 'booked', 'unpaid', false, 'website']
];
const PATH = ['New Trial Lead', 'Reminder Sent', 'Confirmed', 'Attended', 'Package Consultation', 'Package Sold'];
module.exports = ctx => async function seedDemo() {
  const { db, core } = ctx;
  if ((await db.one('select count(*)::int n from leads')).n > 0) return { seeded: false, reason: 'database already has leads' };
  await db.tx(async c => {
    const today = core.todayStr();
    for (let i = 0; i < ROWS.length; i++) {
      const [name, service, stage, off, time, status, pay, mk, source] = ROWS[i], s = C.svc(service);
      let date = core.addDays(today, off); if (core.dow(date) === 0) date = core.addDays(date, 1);
      const created = new Date(Date.now() + (Math.min(off, 0) - 3) * 86400e3);
      const lead = await db.one("insert into leads(name, phone, email, source, service_id, price_hkd, stage, consent_pics, consent_at, marketing_opt_in, marketing_at, payment_status, is_sample, sample_sale, created_at) values ($1,$2,$3,$4,$5,$6,'New Trial Lead',true,$7,$8,$7,$9,true,$10,$7) returning *",
        [name, '+852 5550 ' + String(100 + i + 1).padStart(4, '0'), 'sample' + (i + 1) + '@example.com', source, service, s.price, created, mk, pay, stage === 'Package Sold'], c);
      await db.q("insert into lead_history(lead_id, from_stage, to_stage, at, by_name, why) values ($1,null,'New Trial Lead',$2,'系統','樣本資料')", [lead.id, created], c);
      const target = stage === 'Lost' ? 'Reminder Sent' : stage; let prev = 'New Trial Lead';
      for (const st of PATH.slice(1, PATH.indexOf(target) + 1)) { await db.q("insert into lead_history(lead_id, from_stage, to_stage, at, by_name, why) values ($1,$2,$3,$4,'示範員工','樣本資料')", [lead.id, prev, st, created], c); prev = st; }
      if (stage === 'Lost') await db.q("insert into lead_history(lead_id, from_stage, to_stage, at, by_name, why) values ($1,$2,'Lost',$3,'示範員工','未出席，未能聯絡（樣本）')", [lead.id, prev, created], c);
      await db.q('update leads set stage = $2 where id = $1', [lead.id, stage], c);
      const b = await db.one('insert into bookings(lead_id, service_id, price_hkd, date, time, status, created_at) values ($1,$2,$3,$4,$5,$6,$7) returning *', [lead.id, service, s.price, date, time, status, created], c);
      await core.makeReminders(c, b);
      const rs = await db.all('select * from reminders where booking_id = $1 order by id', [b.id], c); const past = status !== 'booked';
      for (const r of rs) {
        if (past) { await core.genDraft(c, r); await db.q("update reminders set state = 'sent', sent_via = 'whatsapp', sent_by = '示範員工', sent_at = $2 where id = $1", [r.id, created], c); }
        else if (r.kind === 'confirmation') { await core.genDraft(c, r); if (stage === 'Reminder Sent' || stage === 'Confirmed') await db.q("update reminders set state = 'sent', sent_via = 'whatsapp', sent_by = '示範員工', sent_at = now() where id = $1", [r.id, ], c); }
      }
      if (i === 13) await db.q("update reminders set state = 'failed' where booking_id = $1 and kind = 'confirmation'", [b.id], c);
      await core.addNoteTx(c, lead.id, '【樣本資料】此記錄為虛構示範，並非真實客戶。', '系統');
      if (stage === 'Package Sold') await core.addNoteTx(c, lead.id, '【樣本資料】此「已購套餐」為預先寫入的示範記錄，並非 Stripe 付款，亦非真實交易。', '系統');
      if (status === 'attended') await core.addNoteTx(c, lead.id, '護理完成，客人表示舒適。未即場介紹套餐。（樣本備註）', '示範員工');
      if (status === 'no-show') await core.addNoteTx(c, lead.id, '未有出席，已嘗試以 WhatsApp 聯絡。（樣本備註）', '示範員工');
    }
  });
  return { seeded: true, rows: ROWS.length };
};
module.exports.ROWS = ROWS;
