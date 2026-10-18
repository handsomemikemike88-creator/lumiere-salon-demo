'use strict';
// Go-live checklist: AUTO items are computed from configuration; MANUAL items are ticked by an admin (stored in settings).
const MANUAL = [
  ['replace_images', '以真實相片取代所有 AI 示範圖片', '正式模式下，網站只會顯示「圖片位置」佔位框，直至你把真實相片放入 public/assets 並更新頁面。'],
  ['replace_therapists', '以真實、已核實的護理師資料取代示範護理師', '不可虛構姓名、資歷或相片；需護理師同意使用其資料及相片。'],
  ['hydrafacial_auth', '確認 Hydrafacial 品牌／商標使用授權', '未獲授權前，請改用通用名稱（例如「水氧面部護理」）。'],
  ['cooling_off_terms', '確認套票冷靜期、退款及取消條款', '政府建議預繳合約設 7 天冷靜期及 14 天退款期（仍未成為法例，上線前再核實）；條款須由商家及法律顧問確認。'],
  ['pics_review', '確認《收集個人資料聲明》（PICS）', '須列明收集目的、是否必須提供、資料轉移對象、查閱及更正聯絡方式、保留期限。'],
  ['privacy_policy_review', '私隱政策頁已由律師審閱並定稿', '/privacy.html 只是草擬範本。完成後可在此剔選，頁面上的「草擬」橫額會隱藏。'],
  ['terms_review', '條款及細則頁已由律師審閱並定稿', '/terms.html 只是草擬範本。完成後可在此剔選，頁面上的「草擬」橫額會隱藏。'],
  ['opening_hours', '確認營業時間及預約時段', '時段設定在 lib/constants.js（TIMES、DEFAULT_CAPACITY）及日曆名額。'],
  ['business_registration', '確認商業登記及（如適用）相關牌照／註冊', '請向專業顧問確認適用的規定；本系統不提供法律意見。'],
  ['pdpo_uemo_checks', '完成 PDPO／《非應邀電子訊息條例》檢查（啟用真實發送前）', '見 README「合規檢查」一節。'],
  ['backup_restore_tested', '已測試資料庫備份及還原', '執行 scripts/backup.sh 及 scripts/restore.sh 並確認資料完整。'],
  ['stripe_live_review', '（只在要收真實款項時）已完成 Stripe 帳戶審核並確認 live 設定', '見 DEPLOY.md「Stripe 正式收款」。']
];
module.exports = ctx => {
  const { cfg } = ctx;
  async function get() {
    const done = (await ctx.notify.getSetting('checklist', {})) || {};
    const st = cfg.store, ok = v => !!v;
    const auto = [
      ['store_name', '店名（STORE_NAME）', ok(st.name)], ['store_address', '店舖地址（STORE_ADDRESS）', ok(st.address)], ['store_phone', '店舖電話（STORE_PHONE）', ok(st.phone)],
      ['store_whatsapp', 'WhatsApp 號碼（STORE_WHATSAPP）', ok(st.whatsapp)], ['store_hours', '營業時間文字（STORE_HOURS）', ok(st.hours)], ['store_brn', '商業登記號碼（BUSINESS_REG_NO，如要顯示）', ok(st.brn)],
      ['demo_off', '示範模式已關閉（SITE_DEMO_MODE=false）', !cfg.SITE_DEMO_MODE], ['https', 'PUBLIC_BASE_URL 為 https', /^https:/.test(cfg.PUBLIC_BASE_URL || '')],
      ['email_provider', '電郵發送服務已設定（重設密碼電郵；EMAIL_PROVIDER）', cfg.EMAIL_PROVIDER !== 'none'], ['stripe_mode', cfg.STRIPE_LIVE ? 'Stripe 正式收款已啟用' : 'Stripe 仍是測試模式（只想測試可忽略）', cfg.STRIPE_LIVE]
    ].map(([id, title, okv]) => ({ id, title, type: 'auto', done: okv }));
    const manual = MANUAL.map(([id, title, hint]) => ({ id, title, hint, type: 'manual', done: !!(done[id] && done[id].done), by: done[id] && done[id].by || null, at: done[id] && done[id].at || null }));
    const items = auto.concat(manual);
    return { items, remaining: items.filter(i => !i.done).length, demoMode: cfg.SITE_DEMO_MODE };
  }
  async function set(id, value, actor) {
    if (!MANUAL.some(m => m[0] === id)) throw new (require('./errors').HttpError)(404, '找不到項目');
    const cur = (await ctx.notify.getSetting('checklist', {})) || {}; cur[id] = { done: !!value, by: actor.name, at: new Date().toISOString() };
    await ctx.notify.setSetting('checklist', cur, actor); await ctx.audit.log({ kind: 'staff', id: actor.id, name: actor.name }, 'checklist.set', { type: 'checklist', id }, { done: !!value });
  }
  return { get, set, MANUAL };
};
