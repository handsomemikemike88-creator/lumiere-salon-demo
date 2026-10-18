'use strict';
// HTML templating at serve time: demo-only blocks, production placeholders, store details from env.
// <!--demo-->..<!--/demo--> shown only when SITE_DEMO_MODE=true; <!--prod-->..<!--/prod--> only when off;
// <!--ai-->..<!--/ai--> = AI demo images (kept with their badge in demo mode, replaced by a neutral placeholder otherwise);
// <!--draft-->..<!--/draft--> = "lawyer review" banner (hidden once admin ticks the review in the go-live checklist).
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function transform(html, cfg, flags) {
  flags = flags || {}; const demo = cfg.SITE_DEMO_MODE, st = cfg.store;
  html = html.replace(/<!--demo-->([\s\S]*?)<!--\/demo-->/g, (m, a) => demo ? a : '');
  html = html.replace(/<!--prod-->([\s\S]*?)<!--\/prod-->/g, (m, a) => demo ? '' : a);
  html = html.replace(/<!--draft-->([\s\S]*?)<!--\/draft-->/g, (m, a) => flags.hideDraft ? '' : a);
  html = html.replace(/<!--ai-->([\s\S]*?)<!--\/ai-->/g, (m, a) => demo ? a : '<figure class="ph ph-todo"><div class="ph-missing">圖片位置（待商家提供真實相片）</div></figure>');
  const name = esc(st.name || '【店名待填】');
  if (!demo) {
    html = html.replace(/Lumière(?:<small>[^<]*<\/small>| 雅緻美容)?(?:（示範品牌 Demo）|（示範 Demo）|（示範）|（示範，單一門店）)?/g, name);
    const parts = []; const tbc = t => `<span class="tbc">[${t}待填]</span>`;
    parts.push('地址：' + (st.address ? esc(st.address) : tbc('地址'))); parts.push('電話：' + (st.phone ? esc(st.phone) : tbc('電話')));
    parts.push('WhatsApp：' + (st.whatsapp ? esc(st.whatsapp) : tbc('WhatsApp'))); parts.push('營業時間：' + (st.hours ? esc(st.hours) : tbc('營業時間')));
    if (st.brn) parts.push('商業登記號碼：' + esc(st.brn));
    html = html.replace(/（示範品牌 Demo）｜單一門店｜地址、電話、WhatsApp、營業時間：<span class="tbc">待商家確認<\/span>/g, '｜單一門店｜' + parts.join('｜'));
    html = html.replace(/（示範，單一門店）/g, '（單一門店）').replace(/（示範）/g, '').replace(/，示範版本不收款/g, '');
    html = html.replace(/,"additionalProperty":\{[^}]*\}/g, '').replace(/"description":"示範網站[^"]*",/g, '');
    html = html.replace(/（示範品牌 Demo）｜單一門店/g, '｜單一門店｜' + parts.join('｜'));
    html = html.replace(/<a href="(?:\.\.\/)?team\.html"(?: aria-current=page)?>護理師團隊<\/a>/g, '');
  }
  html = html.replace(/\{\{STORE_NAME\}\}/g, esc(st.name || (demo ? 'Lumière 雅緻美容' : '【店名待填】')));
  return html;
}
module.exports = { transform, esc };
