(function(){
'use strict';
var CFG=null,ME=null,app=document.getElementById('app'),drawer=document.getElementById('drawer'),page=document.body.dataset.page;
var STZ={},SV={};
var ZH={attendance:{booked:'已預約',attended:'已出席','no-show':'未出席',cancelled:'已取消'},payment:{unpaid:'未付款',paid:'已付款',refunded:'已退款'},pkgpay:{not_started:'未開始 not_started',pending:'待付款 pending',paid:'已付款 paid',failed:'失敗 failed',expired:'已逾時 expired',refunded:'已退款 refunded'},rstate:{pending:'待生成',drafted:'草稿待發',sent:'已發出',failed:'失敗'},kind:{confirmation:'預約確認','day-before':'前一日提醒','same-day':'當日提醒'},src:{website:'網站',whatsapp:'WhatsApp','walk-in':'到店',referral:'轉介',social:'社交媒體',sample:'樣本'}};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(m,u,b){var o={method:m,credentials:'same-origin',headers:{}};if(m!=='GET'){o.headers['Content-Type']='application/json';o.body=JSON.stringify(b||{})}
 return fetch(u,o).then(function(r){if(r.status===401){location.href='/staff/login.html';throw new Error('未登入')}return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'發生錯誤');return j})})}
function dt(s){return s?new Date(s).toLocaleString('zh-HK',{timeZone:'Asia/Hong_Kong',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—'}
function badge(cls,t){return '<span class="badge b-'+esc(cls)+'">'+esc(t)+'</span>'}
function stz(s){return STZ[s]||s}
function opts(list,sel,lab){return list.map(function(x){var v=x.id||x;return '<option value="'+esc(v)+'"'+(v===sel?' selected':'')+'>'+esc(lab?lab(x):(x.name||x.zh||x))+'</option>'}).join('')}
function $(s,r){return (r||document).querySelector(s)}
function on(root,ev,fn){root.addEventListener(ev,fn)}
function toast(msg,bad){var e=$('#msg');if(e){e.className=bad?'err':'ok';e.textContent=msg}}

function nav(){var items=[['index','儀表板'],['calendar','預約日曆'],['leads','客戶資料庫'],['pipeline','銷售流程'],['reminders','提醒訊息'],['settings','設定']];if(ME.role==='admin')items=items.concat([['invitations','員工邀請'],['users','員工帳戶'],['admin-settings','發送設定'],['audit','操作紀錄'],['checklist','上線清單']]);
 var cur=page==='dashboard'?'index':page==='adminsettings'?'admin-settings':page;
 $('#top').innerHTML='<header class="top"><a class="brand" href="index.html">'+esc(CFG.storeName)+' 員工後台</a><nav>'+items.map(function(i){return '<a href="'+i[0]+'.html"'+(i[0]===cur?' class="on"':'')+'>'+i[1]+'</a>'}).join('')+'</nav><span class="who">'+esc(ME.name)+'（'+(ME.role==='admin'?'管理員':'員工')+'）</span><button class="btn ghost sm" id="lo" type="button">登出</button></header>';
 if(!CFG.stripe.live)$('#top').insertAdjacentHTML('beforeend','<div class="stripe-banner" role="note"><b>STRIPE TEST MODE 測試模式</b> — Test Mode - not real revenue. 這裡的付款全是 Stripe 測試付款（測試卡），<b>不是真實交易，也不是真實收入</b>。</div>');
 var mb=document.getElementById('modebar');if(mb&&CFG.demo){mb.hidden=false;mb.textContent='示範系統 Demo – 樣本資料 SAMPLE DATA ONLY'}
 $('#lo').onclick=function(){api('POST','/api/staff/logout').then(function(){location.href='/staff/login.html'})}}
function notice(){var n=CFG.notify||{};var m=n.enabled?(n.dryRun?'真實發送處於<b>試運行</b>模式：不會真正發出訊息。':'真實發送<b>已啟用</b>：每則訊息須由員工逐一核准'+(n.autoSend?'（管理員已開啟自動發送交易性提醒）':'')+'；只會發出預約確認及提醒，並設有退訂。'):'本系統預設只產生訊息「草稿」，<b>不會自動發送</b>任何 WhatsApp 或電郵。';return '<div class="nodraft"><b>重要：</b>'+m+' 「付款標記」只是人手標記；套餐付款只透過 <b>Stripe</b>'+(CFG.stripe.live?'（正式模式）':'（<b>測試模式</b>，非真實交易）')+'。'+(CFG.demo?' 資料為虛構樣本。':'')+'</div>'}

// ---------- consultation / Stripe test checkout panel ----------
function copyBtnText(b,t){b.textContent=t}
function consultPanel(l){
 var c=l.consultation; if(!c)return '';
 var p=l.packagePayment, st=l.packagePaymentStatus, h='<div class="card consult" id="consult"><h3>套餐諮詢 · 10-Session Package</h3>'+(c.label?'<div class="sample-tag">'+esc(c.label)+'</div>':'')+
  '<div class="row"><b>'+esc(c.productName)+'</b> ｜ <b>'+esc(c.priceLabel)+'</b>（標準價目'+(c.testMode?'；樣本／測試資料':'')+'）</div>'+
  '<div class="row">付款狀態：'+badge(st,ZH.pkgpay[st])+'</div>';
 if(p){h+='<div class="muted">session：'+esc(p.sessionId)+'<br>payment intent：'+esc(p.paymentIntentId||'—')+'<br>金額：'+esc(p.currency.toUpperCase())+' '+esc(p.amountMinor)+'（'+esc(p.amountLabel)+(p.livemode?'':'，測試')+'）｜ livemode：'+esc(p.livemode)+'<br>建立：'+esc(dt(p.createdAt))+(p.paidAt?'<br>付款確認：'+esc(dt(p.paidAt))+'（'+esc(p.verifiedVia)+'）':'')+(p.expiredAt?'<br>逾時：'+esc(dt(p.expiredAt)):'')+(p.failedAt?'<br>失敗：'+esc(dt(p.failedAt)):'')+(p.lastError?'<br>備註：'+esc(p.lastError):'')+(p.lastRejection?'<br><span class="err">驗證被拒：'+esc(p.lastRejection.reason)+'</span>':'')+'</div>'}
 if(l.stage==='Package Consultation'){
  h+='<p class="muted">客戶只有在付款經 Stripe webhook 或下方「驗證付款」確認為<b>已付款（經 Stripe 驗證）</b>後，才會自動移到 Package Sold。無法手動移動。</p>';
  if(st==='pending'&&p&&p.checkoutUrl){
   h+='<label class="f">Checkout 連結（只供員工開啟／複製，不會自動發送）<input id="ckurl" readonly value="'+esc(p.checkoutUrl)+'"></label><div class="row"><a class="btn sm" id="ckopen" target="_blank" rel="noopener noreferrer" href="'+esc(p.checkoutUrl)+'">開啟 Stripe 付款頁</a><button class="btn ghost sm" id="ckcopy" type="button">複製連結</button><button class="btn sm" id="ckverify" type="button">驗證付款 Verify payment</button><button class="btn warn sm" id="ckrenew" type="button">重新建立連結</button></div>'+
    '<div class="muted">客戶訊息草稿（只供複製，系統不會發送）：</div><pre class="draft" id="ckdraft">'+esc(l.name)+' 你好，\n以下是 10 次套餐的付款連結：\n'+esc(p.checkoutUrl)+(p.livemode?'\n如有任何疑問，歡迎回覆查詢。':'\n這是測試付款（Stripe 測試模式），請使用測試卡 4242 4242 4242 4242，任何未來到期日及任意 CVC；並非真實交易。')+'</pre><div class="row"><button class="btn ghost sm" id="ckdcopy" type="button">複製訊息草稿</button></div>';
  }else{
   h+='<div class="row"><button class="btn" id="ckcreate" type="button">建立 Stripe 付款連結 Create Stripe checkout'+(c.testMode?'（測試模式）':'')+'</button></div>';
   if(st==='failed')h+='<div class="row"><button class="btn sm" id="ckverify" type="button">驗證付款 Verify payment</button></div>';
  }
  if(c.testMode)h+='<div class="muted">測試卡：4242 4242 4242 4242，任何未來到期日，任意 CVC。</div>';
 }else if(l.stage==='Package Sold'){h+='<p class="ok">'+(st==='paid'?(p&&p.livemode?'已驗證的 Stripe 付款（paid）。':'已驗證的 Stripe 測試付款（paid）。這是測試資料，不是真實收入。'):l.sampleSale?'樣本資料：預先寫入的示範記錄，並非 Stripe 付款。':'')+'</p>'}
 return h+'<p id="cmsg" role="status"></p></div>'}
function wireConsult(l,done){
 var m=function(t,bad){var e=$('#cmsg');if(e){e.className=bad?'err':'ok';e.textContent=t}};
 function wire(id,fn){var el=$('#'+id);if(el)el.onclick=function(){fn(el)}}
 wire('ckcreate',function(b){b.disabled=true;m('建立中…');api('POST','/api/staff/leads/'+l.id+'/stripe-checkout',{}).then(done).catch(function(e){b.disabled=false;m(e.message,1)})});
 wire('ckrenew',function(){if(confirm('會使舊連結失效並建立新的測試連結，確定？'))api('POST','/api/staff/leads/'+l.id+'/stripe-checkout',{renew:true}).then(done).catch(function(e){m(e.message,1)})});
 wire('ckverify',function(b){b.disabled=true;m('向 Stripe 查詢中…');api('POST','/api/staff/leads/'+l.id+'/stripe-verify',{}).then(function(j){onLeadChange();renderLead(j.lead);setTimeout(function(){var e=$('#cmsg');if(e){e.className=j.result==='paid'?'ok':'muted';e.textContent=j.message}},50)}).catch(function(e){b.disabled=false;m(e.message,1)})});
 wire('ckcopy',function(b){copyText($('#ckurl').value).then(function(){copyBtnText(b,'已複製 ✓')})});
 wire('ckdcopy',function(b){copyText($('#ckdraft').textContent).then(function(){copyBtnText(b,'已複製 ✓')})});
}
function copyText(t){if(navigator.clipboard&&window.isSecureContext)return navigator.clipboard.writeText(t);return new Promise(function(ok){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(e){}a.remove();ok()})}

// ---------- shared lead drawer ----------
var onLeadChange=function(){};
function openLead(id){
 api('GET','/api/staff/leads/'+encodeURIComponent(id)).then(function(j){renderLead(j.lead)}).catch(function(e){alert(e.message)})}
function closeDrawer(){drawer.hidden=true;drawer.innerHTML=''}
function renderLead(l){
 drawer.hidden=false;
 var cons=consultPanel(l);
 var bk=l.bookings.map(function(b){return '<div class="row">'+esc(b.id)+' · '+esc(b.date)+' '+esc(b.time)+' · '+esc(b.serviceName)+' '+badge(b.status,ZH.attendance[b.status])+' <select data-att="'+esc(b.id)+'">'+Object.keys(ZH.attendance).map(function(k){return '<option value="'+k+'"'+(k===b.status?' selected':'')+'>'+ZH.attendance[k]+'</option>'}).join('')+'</select></div><div class="muted">提醒：'+Object.keys(b.reminders).map(function(k){return esc(ZH.kind[k])+'＝'+esc(ZH.rstate[b.reminders[k]])}).join('；')+'</div>'}).join('');
 drawer.innerHTML='<div class="row"><h2 style="flex:1">'+esc(l.name)+' <span class="muted">'+esc(l.id)+'</span></h2><button class="btn ghost sm" id="dc" type="button">關閉</button></div><p id="msg" class="ok" role="status"></p>'+
 '<div class="muted">電話 '+esc(l.phone)+' ｜ 電郵 '+esc(l.email||'—')+' ｜ 來源 '+esc(ZH.src[l.source]||l.source)+'</div>'+
 '<div class="row"><b>服務：</b>'+esc(l.serviceName)+'｜<b>標準價目：</b>'+esc(l.priceLabel)+'</div>'+
 '<div class="muted">已同意個人資料聲明：'+(l.consentPics?'是':'否')+' ｜ 推廣同意（另設，預設否）：'+(l.marketingOptIn?'是':'否')+'</div>'+
 '<div class="muted">'+(l.isSample?badge('sample','樣本資料 SAMPLE')+' ':'')+(l.sampleSale?badge('sample','樣本成交（預先寫入，非 Stripe 付款）')+' ':'')+'套餐付款（Stripe'+(CFG.stripe.live?'':' Test')+'）：'+badge(l.packagePaymentStatus,ZH.pkgpay[l.packagePaymentStatus])+'</div>'+cons+'<h3>銷售階段</h3><div class="row"><select id="stsel">'+opts(CFG.stages,l.stage,function(x){return x.id+'（'+x.zh+'）'})+'</select><button class="btn sm" id="stgo" type="button">更改階段</button></div>'+
 '<h3>付款標記 <span class="muted">（人手標記，只作記錄，並非 Stripe 收款；不會令客戶變成 Package Sold）</span></h3><div class="row"><select id="paysel">'+Object.keys(ZH.payment).map(function(k){return '<option value="'+k+'"'+(k===l.paymentStatus?' selected':'')+'>'+ZH.payment[k]+'</option>'}).join('')+'</select><button class="btn sm" id="payg" type="button">更新</button></div>'+
 '<h3>預約與出席</h3>'+(bk||'<p class="muted">暫無預約</p>')+
 '<h3>員工備註 <span class="muted">（只可新增，不可修改）</span></h3><div id="notes">'+l.notes.slice().reverse().map(function(n){return '<div class="hist"><b>'+esc(n.by)+'</b> · '+esc(dt(n.at))+'<br>'+esc(n.text)+'</div>'}).join('')+'</div>'+
 '<textarea id="nt" rows="3" maxlength="1000" placeholder="新增備註…"></textarea><button class="btn sm" id="nadd" type="button">新增備註</button>'+
 '<h3>階段紀錄</h3>'+l.history.slice().reverse().map(function(h){if(h.kind==='payment')return '<div class="hist pay">💳 付款 → <b>'+esc(h.payStatus)+'</b> · '+esc(h.by)+' · '+esc(dt(h.at))+'<br><span class="muted">'+esc(h.why)+'<br>session '+esc(h.sessionId)+(h.paymentIntentId?' · PI '+esc(h.paymentIntentId):'')+' · '+esc(h.currency)+' '+esc(h.amountMinor)+' · livemode='+esc(h.livemode)+'</span></div>';return '<div class="hist">'+esc(h.from?stz(h.from):'（新建）')+' → <b>'+esc(stz(h.to))+'</b> · '+esc(h.by)+' · '+esc(dt(h.at))+(h.why?'<br><span class="muted">'+esc(h.why)+'</span>':'')+'</div>'}).join('');
 drawer.insertAdjacentHTML('beforeend','<h3>資料保障</h3><div class="row"><button class="btn ghost sm" id="lexp" type="button">下載此客戶資料（JSON）</button>'+(ME.role==='admin'&&!l.anonymised?'<button class="btn warn sm" id="lanon" type="button">刪除／匿名化此客戶</button>':'')+'</div>');
 function done(){onLeadChange();openLead(l.id)}
 $('#lexp').onclick=function(){api('GET','/api/staff/leads/'+l.id+'/export').then(function(j){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(j,null,2)],{type:'application/json'}));a.download='customer-'+l.id+'.json';a.click()}).catch(function(e){toast(e.message,1)})};
 var an=$('#lanon');if(an)an.onclick=function(){var v=prompt('此操作無法還原：客戶姓名、電話、電郵及備註將被匿名化。請輸入客戶編號 '+l.id+' 確認：');if(v===l.id)api('POST','/api/admin/leads/'+l.id+'/anonymise',{confirm:v}).then(function(){onLeadChange();closeDrawer()}).catch(function(e){toast(e.message,1)})};
 $('#dc').onclick=closeDrawer;
 $('#stgo').onclick=function(){api('POST','/api/staff/leads/'+l.id+'/stage',{stage:$('#stsel').value}).then(done).catch(function(e){toast(e.message,1)})};
 $('#payg').onclick=function(){api('POST','/api/staff/leads/'+l.id+'/payment',{status:$('#paysel').value}).then(done).catch(function(e){toast(e.message,1)})};
 wireConsult(l,done);
 $('#nadd').onclick=function(){var t=$('#nt').value.trim();if(!t)return;api('POST','/api/staff/leads/'+l.id+'/notes',{text:t}).then(done).catch(function(e){toast(e.message,1)})};
 [].forEach.call(drawer.querySelectorAll('[data-att]'),function(s){s.onchange=function(){api('POST','/api/staff/bookings/'+s.dataset.att+'/attendance',{status:s.value}).then(done).catch(function(e){toast(e.message,1)})}});
}

// ---------- dashboard ----------
function funnelSvg(f){var max=Math.max.apply(null,f.map(function(x){return x.count}).concat([1])),h=30,w=520,out='<svg viewBox="0 0 '+w+' '+(f.length*h+6)+'" width="100%" role="img" aria-label="銷售階段漏斗">';
 f.forEach(function(x,i){var bw=Math.round(x.count/max*300);out+='<text x="0" y="'+(i*h+19)+'" font-size="13" fill="#26302c">'+esc(x.zh)+'</text><rect x="150" y="'+(i*h+4)+'" width="'+Math.max(bw,2)+'" height="20" rx="4" fill="'+(x.stage==='Lost'?'#c98b8b':'#2f5a4a')+'"/><text x="'+(158+bw)+'" y="'+(i*h+19)+'" font-size="13" fill="#26302c">'+x.count+'</text>'});
 return out+'</svg>'}
function donut(att,ns){var tot=att+ns,r=52,c=2*Math.PI*r,pct=tot?att/tot:0;
 return '<svg viewBox="0 0 140 140" width="160" role="img" aria-label="出席率"><circle cx="70" cy="70" r="'+r+'" fill="none" stroke="#f0d3d3" stroke-width="16"/><circle cx="70" cy="70" r="'+r+'" fill="none" stroke="#2f5a4a" stroke-width="16" stroke-dasharray="'+(c*pct)+' '+c+'" transform="rotate(-90 70 70)"/><text x="70" y="76" text-anchor="middle" font-size="22" fill="#1f3d33">'+(tot?Math.round(pct*1000)/10+'%':'—')+'</text></svg>'}
function bkRows(list){return list.length?'<table class="t"><tr><th>日期</th><th>時間</th><th>客戶</th><th>服務</th><th>提醒</th></tr>'+list.map(function(b){return '<tr class="click" data-lead="'+esc(b.leadId)+'"><td>'+esc(b.date)+'</td><td>'+esc(b.time)+'</td><td>'+esc(b.name)+'</td><td>'+esc(b.serviceName)+'</td><td>'+Object.keys(b.reminders).map(function(k){return badge(b.reminders[k],ZH.kind[k].slice(0,2)+'：'+ZH.rstate[b.reminders[k]].slice(0,3))}).join(' ')+'</td></tr>'}).join('')+'</table>':'<p class="muted">沒有預約</p>'}
function dashboard(){
 api('GET','/api/staff/dashboard').then(function(d){
  var rate=d.attendanceRate==null?'—':(Math.round(d.attendanceRate*1000)/10)+'%';
  app.innerHTML='<h1>儀表板 <span class="muted">Dashboard · '+esc(d.today)+'（香港時間）</span></h1>'+notice()+
  '<div class="test-banner"><b>'+esc(d.stripe.modeLabel)+'</b>'+(d.stripe.live?'':'　測試模式：以下「Stripe 測試付款」數字全是測試資料，不是真實收入。')+(d.includesSample?'　資料包含樣本客戶（SAMPLE）。':'')+'</div><div class="kpis"><div class="kpi"><b id="k-trials">'+d.trialBookings+'</b><span>體驗預約數（不含已取消）</span></div><div class="kpi"><b id="k-rate">'+rate+'</b><span>出席率 = 已出席 ÷（已出席＋未出席）<br>'+d.attended+' ／ '+(d.attended+d.noShow)+'</span></div><div class="kpi"><b id="k-consult">'+d.packageConsultations+'</b><span>套餐諮詢數（曾進入該階段）</span></div><div class="kpi'+(d.stripe.live?'':' test')+'"><b id="k-sales">'+d.stripe.count+'</b><span>Package sales (Stripe '+(d.stripe.live?'live':'TEST')+' payments)<br>套餐銷售（Stripe '+(d.stripe.live?'正式':'測試')+'付款，已驗證）</span></div><div class="kpi'+(d.stripe.live?'':' test')+'"><b id="k-value">'+esc(d.stripe.valueLabel)+'</b><span>'+(d.stripe.live?'Package value（套餐價值）':'Test package value（測試套餐價值）<br>Test Mode - not real revenue')+'</span></div>'+(d.sampleSales.count?'<div class="kpi sample"><b id="k-sample">'+d.sampleSales.count+'</b><span>樣本套餐記錄（預先寫入，非 Stripe）<br>sample package value '+esc(d.sampleSales.valueLabel)+'</span></div>':'')+'<div class="kpi"><b id="k-rem">'+d.reminders.drafted+'</b><span>提醒草稿待發出<br>待生成 '+d.reminders.pending+' ｜ 失敗 '+d.reminders.failed+'</span></div></div>'+
  '<div class="card" id="paybreak"><h2>套餐付款狀態 Payment status <span class="muted">（Stripe '+(d.stripe.live?'Live':'Test Mode')+'）</span></h2><div class="row">'+Object.keys(d.stripe.statusBreakdown).map(function(k){return badge(k,ZH.pkgpay[k]+'：'+d.stripe.statusBreakdown[k])}).join(' ')+'</div><div class="muted">統計範圍：曾進入套餐諮詢或有付款紀錄的客戶。只有已驗證的 paid 會計入上面的數字；樣本記錄另列。'+(d.stripe.live?'':'不是真實收入。')+'</div></div>'+
  '<div class="grid2"><div class="card"><h2>銷售階段漏斗 <span class="muted">共 '+d.totalLeads+' 位客戶；Package Sold 欄可能含樣本記錄</span></h2>'+funnelSvg(d.funnel)+'</div><div class="card"><h2>出席率</h2><div class="row">'+donut(d.attended,d.noShow)+'<div class="muted">已出席 '+d.attended+'<br>未出席 '+d.noShow+'</div></div></div></div>'+
  '<div class="grid2"><div class="card"><h2>今日預約</h2>'+bkRows(d.upcomingToday)+'</div><div class="card"><h2>未來 7 日預約</h2>'+bkRows(d.upcomingWeek)+'</div></div>'+
  '<p class="muted">'+(d.includesSample?'示範模式：資料含虛構樣本。':'')+'<a href="reminders.html">前往提醒訊息頁</a></p>';
  onLeadChange=dashboard;
  app.addEventListener('click',function(e){var r=e.target.closest('[data-lead]');if(r)openLead(r.dataset.lead)});
 })}

// ---------- leads ----------
function leads(){
 app.innerHTML='<h1>客戶資料庫 <span class="muted">Lead database</span></h1>'+notice()+'<div class="filters"><input id="fq" placeholder="搜尋姓名／電話／電郵" size="24"><select id="fs"><option value="">全部階段</option>'+opts(CFG.stages,'',function(x){return x.zh})+'</select><select id="fv"><option value="">全部服務</option>'+opts(CFG.services,'',function(x){return x.name})+'</select><select id="fo"><option value="">全部來源</option>'+Object.keys(ZH.src).map(function(k){return '<option value="'+k+'">'+ZH.src[k]+'</option>'}).join('')+'</select><select id="fm"><option value="">推廣同意：全部</option><option value="true">已同意</option><option value="false">未同意</option></select><span class="muted" id="cnt"></span></div><div class="tblwrap" id="tb"></div>';
 function load(){var p=new URLSearchParams();[['q','fq'],['stage','fs'],['service','fv'],['source','fo'],['marketing','fm']].forEach(function(x){var v=$('#'+x[1]).value;if(v)p.set(x[0],v)});
  api('GET','/api/staff/leads?'+p).then(function(j){$('#cnt').textContent='顯示 '+j.leads.length+' ／ '+j.total;
   $('#tb').innerHTML='<table class="t"><tr><th>編號</th><th>姓名</th><th>電話</th><th>電郵</th><th>來源</th><th>服務</th><th>標準價目</th><th>預約日期</th><th>出席</th><th>階段</th><th>付款標記（人手）</th><th>套餐付款（Stripe）</th><th>個資聲明</th><th>推廣同意</th><th>建立時間</th></tr>'+j.leads.map(function(l){return '<tr class="click" data-lead="'+esc(l.id)+'"><td>'+esc(l.id)+'</td><td>'+esc(l.name)+'</td><td>'+esc(l.phone)+'</td><td>'+esc(l.email||'—')+'</td><td>'+esc(ZH.src[l.source]||l.source)+'</td><td>'+esc(l.serviceName)+'</td><td>'+esc(l.priceLabel)+'</td><td>'+esc(l.bookingDate?l.bookingDate+' '+l.bookingTime:'—')+'</td><td>'+(l.attendance?badge(l.attendance,ZH.attendance[l.attendance]):'—')+'</td><td>'+esc(stz(l.stage))+'</td><td>'+badge(l.paymentStatus,ZH.payment[l.paymentStatus])+'</td><td>'+badge(l.packagePaymentStatus,ZH.pkgpay[l.packagePaymentStatus])+(l.sampleSale||l.isSample?' '+badge('sample','樣本'):'')+'</td><td>'+(l.consentPics?'✓':'✗')+'</td><td>'+(l.marketingOptIn?'✓':'✗')+'</td><td>'+esc(dt(l.created))+'</td></tr>'}).join('')+'</table>'})}
 ['fq','fs','fv','fo','fm'].forEach(function(i){on($('#'+i),i==='fq'?'input':'change',load)});
 on($('#tb'),'click',function(e){var r=e.target.closest('[data-lead]');if(r)openLead(r.dataset.lead)});
 onLeadChange=load;load()}

// ---------- pipeline ----------
function pipeline(){
 function load(){api('GET','/api/staff/leads').then(function(j){
  var by={};CFG.stages.forEach(function(s){by[s.id]=[]});j.leads.forEach(function(l){by[l.stage].push(l)});
  app.innerHTML='<h1>銷售流程 <span class="muted">CRM pipeline</span></h1>'+notice()+'<p id="msg" role="status"></p><div class="board">'+CFG.stages.map(function(s,i){return '<div class="col" data-stage="'+esc(s.id)+'"><h3><span>'+esc(s.id)+'<br><span class="muted">'+esc(s.zh)+'</span></span><span>'+by[s.id].length+'</span></h3>'+by[s.id].map(function(l){return '<div class="pc" draggable="true" data-id="'+esc(l.id)+'"><b><a href="#" data-lead="'+esc(l.id)+'">'+esc(l.name)+'</a></b>'+esc(l.serviceName)+'<br>'+esc(l.priceLabel)+' · '+esc(l.bookingDate||'—')+'<br>'+(l.attendance?badge(l.attendance,ZH.attendance[l.attendance]):'')+' '+badge(l.paymentStatus,ZH.payment[l.paymentStatus])+(l.stage==='Package Sold'?(l.sampleSale&&l.packagePaymentStatus!=='paid'?' '+badge('sample','樣本資料 sample'):' '+badge('paid',CFG.stripe.live?'Stripe 已付款':'Stripe 測試已付款')):l.packagePaymentStatus!=='not_started'?' '+badge(l.packagePaymentStatus,ZH.pkgpay[l.packagePaymentStatus].split(' ')[0]):'')+'<div class="acts">'+(i>0&&!(s.id==='Package Sold'&&l.packagePaymentStatus==='paid')?'<button class="btn ghost sm" data-mv="'+esc(CFG.stages[i-1].id)+'" data-id="'+esc(l.id)+'" type="button" title="上一階段">◀</button>':'')+(s.id==='Package Consultation'?'<span class="muted" title="需要已驗證的 Stripe 付款才能進入 Package Sold；請開啟客戶面板建立／驗證付款">🔒 需 Stripe 付款</span>':i<CFG.stages.length-1?'<button class="btn sm" data-mv="'+esc(CFG.stages[i+1].id)+'" data-id="'+esc(l.id)+'" type="button" title="下一階段">▶</button>':'')+(s.id!=='Lost'?'<button class="btn warn sm" data-mv="Lost" data-id="'+esc(l.id)+'" type="button">流失</button>':'')+'</div></div>'}).join('')+'</div>'}).join('')+'</div>'})}
 function mv(id,st){api('POST','/api/staff/leads/'+id+'/stage',{stage:st}).then(load).catch(function(e){toast(e.message,1)})}
 on(app,'click',function(e){var b=e.target.closest('[data-mv]');if(b)return mv(b.dataset.id,b.dataset.mv);var a=e.target.closest('[data-lead]');if(a){e.preventDefault();openLead(a.dataset.lead)}});
 on(app,'dragstart',function(e){var c=e.target.closest('.pc');if(c)e.dataTransfer.setData('text/plain',c.dataset.id)});
 on(app,'dragover',function(e){var c=e.target.closest('.col');if(c){e.preventDefault();c.classList.add('over')}});
 on(app,'dragleave',function(e){var c=e.target.closest('.col');if(c)c.classList.remove('over')});
 on(app,'drop',function(e){var c=e.target.closest('.col');if(!c)return;e.preventDefault();var id=e.dataTransfer.getData('text/plain');if(id)mv(id,c.dataset.stage)});
 onLeadChange=load;load()}

// ---------- calendar ----------
function calendar(){
 var view='week',cur=CFG.today,bks=[],caps={},defCap=CFG.defaultCapacity,sel=null;
 function iso(d){return d.toISOString().slice(0,10)}
 if(new Date(cur+'T00:00:00Z').getUTCDay()===0)cur=iso(new Date(Date.parse(cur+'T00:00:00Z')+864e5));
 function add(s,n){var d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return iso(d)}
 function dow(s){return new Date(s+'T00:00:00Z').getUTCDay()}
 function monday(s){return add(s,-((dow(s)+6)%7))}
 function range(){if(view==='week'){var m=monday(cur);return [m,add(m,6)]}var y=cur.slice(0,7),f=y+'-01',d=new Date(f+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);var last=add(iso(d),-1);return [monday(f),add(monday(last),6)]}
 function load(){var r=range();api('GET','/api/staff/bookings?from='+r[0]+'&to='+r[1]).then(function(j){bks=j.bookings;caps=j.capacity;defCap=j.defaultCapacity;draw()})}
 function cap(d,t){var v=caps[d+' '+t];return v===undefined?defCap:v}
 function inSlot(d,t,all){return bks.filter(function(b){return b.date===d&&b.time===t&&(all||b.status!=='cancelled')})}
 var WDN=['日','一','二','三','四','五','六'];
 function grid(){var r=range(),s='';
  if(view==='week'){var days=[];for(var i=0;i<7;i++)days.push(add(r[0],i));
   s='<table class="cal"><tr><th style="width:70px">時段</th>'+days.map(function(d){return '<th>'+esc(d.slice(5))+'（'+WDN[dow(d)]+'）</th>'}).join('')+'</tr>'+CFG.times.map(function(t){return '<tr><th>'+t+'</th>'+days.map(function(d){if(dow(d)===0)return '<td class="off">休息</td>';var l=inSlot(d,t),c=cap(d,t);return '<td class="cell '+(l.length>=c?'full':l.length?'some':'')+'" data-d="'+d+'" data-t="'+t+'"><small>'+l.length+' / '+c+'</small>'+l.slice(0,3).map(function(b){return '<span class="nm">'+esc(b.name)+' '+badge(b.status,ZH.attendance[b.status])+'</span>'}).join('')+'</td>'}).join('')+'</tr>'}).join('')+'</table>'}
  else{var d=r[0];s='<table class="cal"><tr>'+['日','一','二','三','四','五','六'].map(function(x){return '<th>'+x+'</th>'}).join('')+'</tr>';
   // month grid starts Monday; header reorder
   s='<table class="cal"><tr>'+['一','二','三','四','五','六','日'].map(function(x){return '<th>'+x+'</th>'}).join('')+'</tr>';
   for(var w=0;w<6;w++){var row='';for(var k=0;k<7;k++){var dd=add(r[0],w*7+k),inM=dd.slice(0,7)===cur.slice(0,7);
    if(k===6){row+='<td class="off">'+esc(dd.slice(8))+'<small>休息</small></td>';continue}
    var n=bks.filter(function(b){return b.date===dd&&b.status!=='cancelled'}).length;
    row+='<td class="day'+(dd===CFG.today?' today':'')+'" data-day="'+dd+'" style="'+(inM?'':'opacity:.45')+'"><b>'+esc(dd.slice(8))+'</b>'+(n?'<small>'+n+' 個預約</small>':'')+'</td>'}
    s+='<tr>'+row+'</tr>'}
   s+='</table>'}
  return s}
 function panel(){if(!sel)return '';var d=sel.d,t=sel.t,l=inSlot(d,t,true);
  return '<div class="card"><h2>'+esc(d)+' '+esc(t)+' <span class="muted">名額 '+inSlot(d,t).length+' ／ '+cap(d,t)+'</span></h2><p id="msg" role="status"></p>'+
  (l.map(function(b){return '<div class="row"><a href="#" data-lead="'+esc(b.leadId)+'"><b>'+esc(b.name)+'</b></a> '+esc(b.serviceName)+'（'+esc(b.priceLabel)+'）'+badge(b.status,ZH.attendance[b.status])+
   (b.status!=='cancelled'?' <select data-att="'+esc(b.id)+'">'+Object.keys(ZH.attendance).map(function(k){return '<option value="'+k+'"'+(k===b.status?' selected':'')+'>'+ZH.attendance[k]+'</option>'}).join('')+'</select>':'')+
   (b.status==='booked'?' <input type="date" data-rd="'+esc(b.id)+'" value="'+esc(b.date)+'"><select data-rt="'+esc(b.id)+'">'+opts(CFG.times,b.time,function(x){return x})+'</select><button class="btn ghost sm" data-rs="'+esc(b.id)+'" type="button">改期</button><button class="btn warn sm" data-cx="'+esc(b.id)+'" type="button">取消</button>':'')+'</div><div class="muted">提醒：'+Object.keys(b.reminders).map(function(k){return esc(ZH.kind[k])+'＝'+esc(ZH.rstate[b.reminders[k]])}).join('；')+'</div>'}).join('')||'<p class="muted">此時段沒有預約</p>')+
  '<h3>調整此時段名額</h3><div class="row"><input id="capv" type="number" min="0" max="20" value="'+cap(d,t)+'" style="width:80px"><button class="btn ghost sm" id="capb" type="button">更新名額</button></div>'+
  '<h3>新增預約</h3><form id="nb"><div class="row"><input name="name" placeholder="客戶稱呼" required maxlength="60"><input name="phone" placeholder="電話 例 5550 0199" required><input name="email" type="email" placeholder="電郵（選填）"></div><div class="row"><select name="service">'+opts(CFG.services,'',function(x){return x.name+'（'+x.priceLabel+'）'})+'</select><select name="source">'+['walk-in','whatsapp','referral','social','website'].map(function(k){return '<option value="'+k+'">'+ZH.src[k]+'</option>'}).join('')+'</select><label><input type="checkbox" name="force"> 超出名額亦預約</label><button class="btn sm" type="submit">建立預約</button></div></form></div>'}
 function draw(){var r=range(),title=view==='week'?r[0]+' 至 '+r[1]:cur.slice(0,7);
  app.innerHTML='<h1>預約日曆 <span class="muted">Booking calendar（香港時間）</span></h1>'+notice()+'<div class="row"><button class="btn ghost sm" id="pv" type="button">◀</button><b>'+esc(title)+'</b><button class="btn ghost sm" id="nx" type="button">▶</button><button class="btn ghost sm" id="td" type="button">今日</button><button class="btn '+(view==='week'?'':'ghost')+' sm" id="vw" type="button">週</button><button class="btn '+(view==='month'?'':'ghost')+' sm" id="vm" type="button">月</button><span class="muted">每個時段預設名額 '+defCap+'；星期日休息</span></div>'+grid()+'<div id="pn">'+panel()+'</div>';
  $('#pv').onclick=function(){cur=view==='week'?add(cur,-7):add(cur.slice(0,7)+'-01',-1);load()};$('#nx').onclick=function(){cur=view==='week'?add(cur,7):add(add(cur.slice(0,7)+'-01',32).slice(0,7)+'-01',0);load()};
  $('#td').onclick=function(){cur=CFG.today;if(dow(cur)===0)cur=add(cur,1);load()};$('#vw').onclick=function(){view='week';load()};$('#vm').onclick=function(){view='month';load()}}
 function act(p){return p.then(function(){load()}).catch(function(e){toast(e.message,1)})}
 on(app,'click',function(e){var t=e.target;var c=t.closest('.cell');if(c){sel={d:c.dataset.d,t:c.dataset.t};draw();return}
  var dy=t.closest('.day');if(dy){cur=dy.dataset.day;view='week';load();return}
  var a=t.closest('[data-lead]');if(a){e.preventDefault();openLead(a.dataset.lead);return}
  var b=t.closest('[data-rs]');if(b){var id=b.dataset.rs;act(api('POST','/api/staff/bookings/'+id+'/reschedule',{date:$('[data-rd="'+id+'"]').value,time:$('[data-rt="'+id+'"]').value}));return}
  b=t.closest('[data-cx]');if(b){if(confirm('確定取消此預約？'))act(api('POST','/api/staff/bookings/'+b.dataset.cx+'/cancel',{}));return}
  if(t.id==='capb')act(api('POST','/api/staff/slots',{date:sel.d,time:sel.t,capacity:Number($('#capv').value)}))});
 on(app,'change',function(e){var s=e.target.closest('[data-att]');if(s)act(api('POST','/api/staff/bookings/'+s.dataset.att+'/attendance',{status:s.value}))});
 on(app,'submit',function(e){if(e.target.id!=='nb')return;e.preventDefault();var f=e.target;act(api('POST','/api/staff/bookings',{date:sel.d,time:sel.t,name:f.name.value,phone:f.phone.value,email:f.email.value,service:f.service.value,source:f.source.value,force:f.force.checked}))});
 onLeadChange=load;load()}

// ---------- reminders ----------
function sendBtn(r,ch){var n=CFG.notify||{};if(!n.enabled||!n[ch])return '';if(r.state==='sent')return '';return '<button class="btn warn sm" data-send="'+esc(r.id)+'|'+ch+'" type="button">核准並'+(n.dryRun?'試運行':'真實發送')+'（'+(ch==='email'?'電郵':'WhatsApp')+'）</button>'}
function reminders(){
 var st='open';
 function load(){api('GET','/api/staff/reminders'+(st?'?state='+st:'')).then(function(j){
  app.innerHTML='<h1>提醒訊息 <span class="muted">Reminders</span></h1>'+notice()+'<div class="row"><b>狀態：</b>'+[['open','待處理（草稿／失敗）'],['','全部'],['pending','待生成'],['drafted','草稿待發'],['sent','已發出'],['failed','失敗']].map(function(x){return '<button class="btn '+(st===x[0]?'':'ghost')+' sm" data-st="'+x[0]+'" type="button">'+x[1]+'</button>'}).join('')+'<button class="btn ghost sm" id="run" type="button">立即執行排程（只產生草稿）</button><span class="muted">伺服器每分鐘自動檢查一次；本頁載入時亦會檢查。</span></div><p id="msg" role="status"></p>'+
  (j.reminders.length?j.reminders.map(function(r){var d=r.drafts;return '<div class="rem"><div class="row"><b>'+esc(ZH.kind[r.kind])+'</b> · '+esc(r.leadName)+' · 預約 '+esc(r.date)+' '+esc(r.time)+' '+badge(r.state,ZH.rstate[r.state])+(r.sentVia?' <span class="muted">經 '+esc(r.sentVia)+'</span>':'')+'<span class="muted">預定產生：'+esc(dt(r.scheduledFor))+'</span></div>'+
   (d?'<div class="dr2"><div><b>WhatsApp 草稿</b><pre class="draft">'+esc(d.whatsapp.body)+'</pre><div class="row"><button class="btn ghost sm" data-copy="'+esc(r.id)+'|whatsapp" type="button">複製</button>'+(d.whatsapp.url.indexOf('https://wa.me/')===0?'<a class="btn ghost sm" target="_blank" rel="noopener noreferrer" href="'+esc(d.whatsapp.url)+'">開啟 WhatsApp 連結</a>':'')+'<button class="btn sm" data-sent="'+esc(r.id)+'|whatsapp" type="button">標記已發出（WhatsApp）</button>'+sendBtn(r,'whatsapp')+'</div></div>'+
   '<div><b>電郵草稿</b><div class="muted">主旨：'+esc(d.email.subject)+'</div><pre class="draft">'+esc(d.email.body)+'</pre><div class="row"><button class="btn ghost sm" data-copy="'+esc(r.id)+'|email" type="button">複製</button>'+(d.email.url.indexOf('mailto:')===0?'<a class="btn ghost sm" href="'+esc(d.email.url)+'">開啟 mailto</a>':'<span class="muted">客戶未提供電郵</span>')+'<button class="btn sm" data-sent="'+esc(r.id)+'|email" type="button">標記已發出（電郵）</button>'+sendBtn(r,'email')+'</div></div></div>'+(r.delivery?'<div class="muted">發送紀錄：'+esc(r.delivery.channel)+' → <b>'+esc(r.delivery.status)+'</b>'+(r.delivery.error?'（'+esc(r.delivery.error)+'）':'')+(r.approvedBy?' ｜ 核准：'+esc(r.approvedBy):'')+'</div>':'')+
   '<div class="row"><button class="btn warn sm" data-set="'+esc(r.id)+'|failed" type="button">標記失敗</button><button class="btn ghost sm" data-set="'+esc(r.id)+'|drafted" type="button">還原為草稿</button></div>':'<p class="muted">尚未到產生時間，草稿會自動建立。</p>')+'</div>'}).join(''):'<p class="muted">沒有符合的提醒。</p>');
  window.__rem=j.reminders;
 })}
 on(app,'click',function(e){var t=e.target,b;
  if((b=t.closest('[data-st]'))){st=b.dataset.st;return load()}
  if(t.id==='run')return api('POST','/api/staff/reminders/run',{}).then(function(j){load();setTimeout(function(){toast('已產生 '+j.generated+' 個草稿（沒有發送任何訊息）')},300)});
  if((b=t.closest('[data-copy]'))){var p=b.dataset.copy.split('|'),r=window.__rem.filter(function(x){return x.id===p[0]})[0],txt=p[1]==='email'?r.drafts.email.subject+'\n\n'+r.drafts.email.body:r.drafts.whatsapp.body;copyText(txt).then(function(){b.textContent='已複製 ✓'});return}
  if((b=t.closest('[data-send]'))){var z=b.dataset.send.split('|');if(!confirm('確定核准並發送此則'+(z[1]==='email'?'電郵':'WhatsApp')+'預約通知？（只限預約確認／提醒，訊息內附退訂方法）'))return;b.disabled=true;return api('POST','/api/staff/reminders/'+z[0]+'/send',{channel:z[1],approve:true}).then(function(j){load();setTimeout(function(){toast('結果：'+j.status)},300)}).catch(function(x){b.disabled=false;toast(x.message,1)})}
  if((b=t.closest('[data-sent]'))){var q=b.dataset.sent.split('|');return api('POST','/api/staff/reminders/'+q[0]+'/state',{state:'sent',via:q[1]}).then(load).catch(function(x){toast(x.message,1)})}
  if((b=t.closest('[data-set]'))){var s=b.dataset.set.split('|');api('POST','/api/staff/reminders/'+s[0]+'/state',{state:s[1]}).then(load).catch(function(x){toast(x.message,1)})}});
 onLeadChange=load;load()}

// ---------- settings (own account) ----------
function settings(){
 var h='<h1>設定 <span class="muted">Settings</span></h1>'+notice()+'<div class="card"><h2>標準價目（唯一來源：lib/constants.js，同步到 services 資料表）</h2><table class="t"><tr><th>服務</th><th>標準價目</th></tr>'+CFG.services.map(function(s){return '<tr><td>'+esc(s.name)+'</td><td>'+esc(s.priceLabel)+'</td></tr>'}).join('')+'</table></div>'+
 '<div class="card"><h2>更改密碼</h2><form id="pwf"><div class="row"><input name="current" type="password" placeholder="目前密碼" autocomplete="current-password" required><input name="next" type="password" placeholder="新密碼（最少 12 個字元）" autocomplete="new-password" minlength="12" required><button class="btn sm" type="submit">更改密碼</button></div><p class="muted">更改後，其他裝置上的登入會全部登出。</p><p id="msg" role="status"></p></form></div>';
 app.innerHTML=h;
 $('#pwf').onsubmit=function(e){e.preventDefault();var f=e.target;api('POST','/api/staff/password',{current:f.current.value,next:f.next.value}).then(function(){f.reset();toast('密碼已更新')}).catch(function(x){toast(x.message,1)})}}

// ---------- admin: invitations ----------
function invitations(){
 function load(){api('GET','/api/admin/invitations').then(function(j){
  app.innerHTML='<h1>員工邀請 <span class="muted">Invitations</span></h1><div class="card"><p class="muted">員工只能透過管理員建立的邀請連結註冊。連結只可使用一次，有時限；註冊後帳戶為「待批准」，須在「員工帳戶」頁批准才可登入。</p><form id="inf"><div class="row"><input name="email" type="email" placeholder="新員工電郵" required><label><input type="checkbox" name="sendEmail"> 同時以電郵寄出（需已設定電郵服務）</label><button class="btn sm" type="submit">建立邀請連結</button></div></form><p id="msg" role="status"></p><div id="newlink"></div></div>'+
  '<div class="tblwrap"><table class="t" id="invtbl"><tr><th>電郵</th><th>狀態</th><th>建立</th><th>到期</th><th></th></tr>'+j.invitations.map(function(i){return '<tr><td>'+esc(i.email)+'</td><td>'+badge(i.status==='open'?'drafted':i.status==='used'?'sent':'cancelled',{open:'未使用',used:'已使用',revoked:'已撤銷',expired:'已過期'}[i.status])+'</td><td>'+esc(dt(i.created_at))+'</td><td>'+esc(dt(i.expires_at))+'</td><td>'+(i.status==='open'?'<button class="btn ghost sm" data-rv="'+esc(i.id)+'" type="button">撤銷</button>':'')+'</td></tr>'}).join('')+'</table></div>';
  $('#inf').onsubmit=function(e){e.preventDefault();var f=e.target;api('POST','/api/admin/invitations',{email:f.email.value,sendEmail:f.sendEmail.checked}).then(function(r){load();setTimeout(function(){$('#newlink').innerHTML='<div class="nodraft"><b>邀請連結（只顯示一次，請安全地交給 '+esc(r.invitation.email)+'）</b><br><input readonly id="lnk" style="width:100%" value="'+esc(r.link)+'"><br>'+(r.emailed?'已電郵寄出。':'未有以電郵寄出。')+'</div>'},200)}).catch(function(x){toast(x.message,1)})};
  on($('#invtbl'),'click',function(e){var b=e.target.closest('[data-rv]');if(b&&confirm('確定撤銷此邀請？'))api('POST','/api/admin/invitations/'+b.dataset.rv+'/revoke',{}).then(load).catch(function(x){toast(x.message,1)})})})}
 load()}

// ---------- admin: staff accounts ----------
function users(){
 function load(){api('GET','/api/admin/staff').then(function(j){
  app.innerHTML='<h1>員工帳戶 <span class="muted">Staff accounts</span></h1><p id="msg" role="status"></p><div class="tblwrap"><table class="t" id="ustbl"><tr><th>姓名</th><th>電郵</th><th>角色</th><th>狀態</th><th>最後登入</th><th></th></tr>'+j.users.map(function(u){var me=u.id===ME.id;return '<tr><td>'+esc(u.name)+'</td><td>'+esc(u.email)+'</td><td>'+(u.role==='admin'?'管理員':'員工')+'</td><td>'+badge(u.status==='active'?'sent':u.status==='pending'?'drafted':'cancelled',{active:'已啟用',pending:'待批准',disabled:'已停用'}[u.status])+'</td><td>'+esc(dt(u.last_login_at))+'</td><td>'+(me?'<span class="muted">（你）</span>':(u.status!=='active'?'<button class="btn sm" data-st="'+esc(u.id)+'|active" type="button">'+(u.status==='pending'?'批准':'重新啟用')+'</button>':'<button class="btn warn sm" data-st="'+esc(u.id)+'|disabled" type="button">停用</button> <button class="btn ghost sm" data-role="'+esc(u.id)+'|'+(u.role==='admin'?'staff':'admin')+'" type="button">改為'+(u.role==='admin'?'員工':'管理員')+'</button>'))+'</td></tr>'}).join('')+'</table></div>';
  on($('#ustbl'),'click',function(e){var b=e.target.closest('[data-st]');if(b){var p=b.dataset.st.split('|');return api('POST','/api/admin/staff/'+p[0]+'/status',{status:p[1]}).then(load).catch(function(x){toast(x.message,1)})}
   b=e.target.closest('[data-role]');if(b){var q=b.dataset.role.split('|');if(confirm('確定更改角色？對方會被登出。'))api('POST','/api/admin/staff/'+q[0]+'/role',{role:q[1]}).then(load).catch(function(x){toast(x.message,1)})}})})}
 load()}

// ---------- admin: audit log ----------
function audit(){
 var off=0;
 function load(){api('GET','/api/admin/audit?limit=100&offset='+off).then(function(j){
  app.innerHTML='<h1>操作紀錄 <span class="muted">Audit log</span></h1><p class="muted">只記錄員工操作（階段移動、付款、備註、登入、角色變更等），不記錄客戶個人資料內容。</p><div class="row"><button class="btn ghost sm" id="pv" type="button"'+(off?'':' disabled')+'>◀ 較新</button><button class="btn ghost sm" id="nx" type="button"'+(j.entries.length<100?' disabled':'')+'>較舊 ▶</button></div><div class="tblwrap"><table class="t" id="audtbl"><tr><th>時間</th><th>操作者</th><th>動作</th><th>對象</th><th>細節</th></tr>'+j.entries.map(function(a){return '<tr><td>'+esc(dt(a.at))+'</td><td>'+esc(a.actor_name||a.actor_kind)+'</td><td>'+esc(a.action)+'</td><td>'+esc((a.target_type||'')+' '+(a.target_id||''))+'</td><td class="muted">'+esc(a.detail?JSON.stringify(a.detail):'')+'</td></tr>'}).join('')+'</table></div>';
  $('#pv').onclick=function(){off=Math.max(0,off-100);load()};$('#nx').onclick=function(){off+=100;load()}})}
 load()}

// ---------- admin: go-live checklist ----------
function checklist(){
 function load(){api('GET','/api/admin/checklist').then(function(j){
  app.innerHTML='<h1>上線檢查清單 <span class="muted">Go-live checklist</span></h1>'+(j.demoMode?'<div class="nodraft"><b>示範模式（SITE_DEMO_MODE=true）已開啟</b>：網站會顯示示範標籤、AI 示範圖及示範護理師。正式上線前請關閉。</div>':'')+'<p><b>尚餘 '+j.remaining+' 項未完成。</b> 自動項目由伺服器設定判斷；手動項目由管理員確認後剔選。這份清單不構成法律意見。</p><p id="msg" role="status"></p><div id="cl">'+j.items.map(function(i){return '<div class="rem"><div class="row"><b>'+(i.done?'✅':'⬜')+' '+esc(i.title)+'</b> '+badge(i.type==='auto'?'pending':'booked',i.type==='auto'?'自動檢查':'手動確認')+(i.type==='manual'?'<label style="margin-left:auto"><input type="checkbox" data-ck="'+esc(i.id)+'"'+(i.done?' checked':'')+'> 已完成</label>':'')+'</div>'+(i.hint?'<div class="muted">'+esc(i.hint)+'</div>':'')+(i.by?'<div class="muted">確認者：'+esc(i.by)+' · '+esc(dt(i.at))+'</div>':'')+'</div>'}).join('')+'</div>';
  on($('#cl'),'change',function(e){var c=e.target.closest('[data-ck]');if(c)api('POST','/api/admin/checklist/'+c.dataset.ck,{done:c.checked}).then(load).catch(function(x){toast(x.message,1)})})})}
 load()}

// ---------- admin: notification settings + suppression list ----------
function adminsettings(){
 function load(){Promise.all([api('GET','/api/admin/settings'),api('GET','/api/admin/suppression')]).then(function(r){var s=r[0],sup=r[1].entries;
  app.innerHTML='<h1>發送設定及退訂名單 <span class="muted">Notifications</span></h1>'+
  '<div class="card"><h2>真實發送狀態</h2><p>伺服器開關 NOTIFY_ENABLED：<b>'+(s.notify.enabled?'開':'關（預設）')+'</b>｜試運行：<b>'+(s.notify.dryRun?'是':'否')+'</b>｜電郵服務：<b>'+esc(s.emailProvider)+'</b>｜電郵渠道：<b>'+(s.notify.email.enabled?'可用':'未啟用')+'</b>｜WhatsApp 渠道：<b>'+(s.notify.whatsapp.enabled?'可用':'未啟用')+'</b></p><p class="muted">這些由伺服器環境變數控制（見 README／DEPLOY）。啟用前請先完成 PDPO／非應邀電子訊息條例檢查。</p>'+
  '<label><input type="checkbox" id="auto"'+(s.autoSendReminders?' checked':'')+(s.notify.enabled?'':' disabled')+'> 自動發送交易性預約確認／提醒（預設關；只限預約確認及提醒，並設有退訂）</label><p id="msg" role="status"></p></div>'+
  '<div class="card"><h2>退訂名單 Suppression list</h2><p class="muted">名單內的電郵／電話永不發送。名單只儲存雜湊值（不可還原）。客人按電郵內退訂連結會自動加入；收到 WhatsApp「STOP」回覆時請在此加入。</p><form id="sf"><div class="row"><select name="channel"><option value="email">電郵</option><option value="whatsapp">WhatsApp／電話</option></select><input name="address" placeholder="電郵或電話" required><button class="btn sm" type="submit">加入退訂名單</button></div></form><div class="tblwrap"><table class="t" id="suptbl"><tr><th>渠道</th><th>參考</th><th>原因</th><th>加入時間</th><th></th></tr>'+sup.map(function(e){return '<tr><td>'+esc(e.channel)+'</td><td>'+esc(e.ref)+'</td><td>'+esc(e.reason)+'</td><td>'+esc(dt(e.created_at))+'</td><td><button class="btn ghost sm" data-rm="'+esc(e.channel)+'|'+esc(e.ref)+'" type="button">移除</button></td></tr>'}).join('')+'</table></div></div>';
  $('#auto').onchange=function(e){api('POST','/api/admin/settings',{autoSendReminders:e.target.checked}).then(load).catch(function(x){e.target.checked=!e.target.checked;toast(x.message,1)})};
  $('#sf').onsubmit=function(e){e.preventDefault();var f=e.target;api('POST','/api/admin/suppression',{channel:f.channel.value,address:f.address.value,reason:'manual'}).then(load).catch(function(x){toast(x.message,1)})};
  on($('#suptbl'),'click',function(e){var b=e.target.closest('[data-rm]');if(b){var p=b.dataset.rm.split('|');if(confirm('確定移除？之後可能再向此地址發送預約通知。'))api('POST','/api/admin/suppression/remove',{channel:p[0],ref:p[1]}).then(load).catch(function(x){toast(x.message,1)})}})})}
 load()}

on(drawer,'keydown',function(e){if(e.key==='Escape')closeDrawer()});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDrawer()});
Promise.all([api('GET','/api/config'),api('GET','/api/staff/me')]).then(function(r){CFG=r[0];ME=r[1].user;CFG.stages.forEach(function(s){STZ[s.id]=s.id+'（'+s.zh+'）'});nav();
 ({dashboard:dashboard,leads:leads,pipeline:pipeline,calendar:calendar,reminders:reminders,settings:settings,invitations:invitations,users:users,audit:audit,checklist:checklist,adminsettings:adminsettings})[page]()}).catch(function(){});
})();
