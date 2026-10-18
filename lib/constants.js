'use strict';
// Single source of truth for the service menu, prices and pipeline stages.
// ONLY these four prices are allowed anywhere in the app (HK$0, 688, 288, 8,800).
// The `services` table is synced from this list at every boot (see lib/db.js syncServices).
const SERVICES = [
  { id: 'hf-trial',    name: 'Hydrafacial 免費體驗', kind: 'trial',   price: 0 },
  { id: 'hf-single',   name: 'Hydrafacial 單次', kind: 'single',  price: 688 },
  { id: 'laser-trial', name: '激光脫毛體驗', kind: 'trial',   price: 288 },
  { id: 'package10',   name: '10 次套餐 諮詢預約（不即場購買）', kind: 'package', price: 8800 }
];
const ALLOWED_PRICES = [0, 688, 288, 8800];
if (SERVICES.some(s => !ALLOWED_PRICES.includes(s.price))) throw new Error('Disallowed price in SERVICES');
const STAGES = ['New Trial Lead', 'Reminder Sent', 'Confirmed', 'Attended', 'Package Consultation', 'Package Sold', 'Lost'];
const STAGE_ZH = { 'New Trial Lead': '新體驗客戶', 'Reminder Sent': '已發提醒', 'Confirmed': '已確認', 'Attended': '已出席', 'Package Consultation': '套餐諮詢', 'Package Sold': '已購套餐', 'Lost': '流失' };
const TIMES = ['10:00', '11:30', '13:00', '14:30', '16:00', '17:30'];
const DEFAULT_CAPACITY = 2;
const ATTENDANCE = ['booked', 'attended', 'no-show', 'cancelled'];
const PAYMENT = ['unpaid', 'paid', 'refunded'];            // manual staff marker only
const REMINDER_KINDS = ['confirmation', 'day-before', 'same-day'];
const SOURCES = ['website', 'whatsapp', 'walk-in', 'referral', 'social', 'sample'];
const PKG = SERVICES.find(x => x.kind === 'package');
const PKG_UNIT_AMOUNT = PKG.price * 100;     // minor units (HKD cents)
const PKG_CURRENCY = 'hkd';
const PKG_PAY_STATUS = ['not_started', 'pending', 'paid', 'failed', 'expired', 'refunded'];
const fmt = n => 'HK$' + Number(n).toLocaleString('en-US');
const svc = id => SERVICES.find(s => s.id === id);
// words that must never appear in public copy (checked by scripts/check-content.js and tests)
const BANNED_WORDS = ['治療', '治癒', '根治', '療效', '醫學級', '臨床證實', '皮膚科醫生推薦', '保證效果', '永久', '安全無副作用', '無痛'];
module.exports = { SERVICES, ALLOWED_PRICES, STAGES, STAGE_ZH, TIMES, DEFAULT_CAPACITY, ATTENDANCE, PAYMENT, REMINDER_KINDS, SOURCES, PKG, PKG_UNIT_AMOUNT, PKG_CURRENCY, PKG_PAY_STATUS, fmt, svc, BANNED_WORDS };
