(function(){
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(m,u,b){var o={method:m,credentials:'same-origin',headers:{}};if(m!=='GET'){o.headers['Content-Type']='application/json';o.body=JSON.stringify(b||{})}return fetch(u,o).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'發生錯誤');return j})})}
var RS={pending:'待安排',drafted:'已備草稿（職員尚未發出）',sent:'已發出',failed:'發送失敗，職員跟進中'},RK={confirmation:'預約確認','day-before':'前一日提醒','same-day':'當日提醒'},ST={booked:'已預約',attended:'已出席','no-show':'未出席',cancelled:'已取消'};
var PK={none:'暫未有套餐記錄。套餐價錢已公開，由你自己決定，我們不會即場推銷。',consultation:'你正在了解 10 次套餐（只是諮詢階段，尚未購買）。',sold:'套餐已購買。'};
var reg=false,f=document.getElementById('af'),err=document.getElementById('aerr');
function mode(r){reg=r;document.getElementById('tl').className='chip'+(r?'':' on');document.getElementById('tr').className='chip'+(r?' on':'');document.getElementById('ex').hidden=!r;document.getElementById('cs').hidden=!r;document.getElementById('idl').hidden=r;document.getElementById('ab').textContent=r?'註冊':'登入';f.password.autocomplete=r?'new-password':'current-password'}
document.getElementById('tl').onclick=function(){mode(false)};document.getElementById('tr').onclick=function(){mode(true)};
f.onsubmit=function(e){e.preventDefault();err.textContent='';
 var p=reg?api('POST','/api/customer/register',{name:f.name.value,email:f.email.value,phone:f.phone.value,password:f.password.value,consent:f.consent.checked}):api('POST','/api/customer/login',{identifier:f.identifier.value,password:f.password.value});
 p.then(show).catch(function(x){err.textContent=x.message})};
document.getElementById('lo').onclick=function(){api('POST','/api/customer/logout').then(function(){location.reload()})};
function show(){api('GET','/api/customer/bookings').then(function(j){
 document.getElementById('auth').hidden=true;document.getElementById('me').hidden=false;
 document.getElementById('hello').innerHTML='你好，<b>'+esc(j.customer.name)+'</b>';document.getElementById('pkg').textContent=PK[j.packageStatus];
 document.getElementById('bk').innerHTML=j.bookings.length?j.bookings.map(function(b){return '<div class="card"><b>'+esc(b.serviceName)+'</b>（'+esc(b.priceLabel)+'）<br>'+esc(b.date)+' '+esc(b.time)+' · <b>'+esc(ST[b.status])+'</b> · 編號 '+esc(b.id)+
  '<ul class="check">'+Object.keys(b.reminders).map(function(k){return '<li>'+RK[k]+'：'+RS[b.reminders[k]]+'</li>'}).join('')+'</ul>'+
  (b.canChange?'<a class="btn ghost" href="../booking.html?reschedule='+encodeURIComponent(b.id)+'">改期</a> <button class="btn ghost" data-cx="'+esc(b.id)+'" type="button">取消預約</button>':(b.status==='booked'?'<span class="small">預約前 24 小時內不能自助改期或取消，請聯絡本店。</span>':''))+'</div>'}).join(''):'<p>暫時沒有預約。<a href="../booking.html">立即預約</a></p>'}).catch(function(){})}
document.getElementById('bk').addEventListener('click',function(e){var b=e.target.closest('[data-cx]');if(b&&confirm('確定取消此預約？'))api('POST','/api/bookings/'+encodeURIComponent(b.dataset.cx)+'/cancel',{}).then(show).catch(function(x){alert(x.message)})});
api('GET','/api/customer/me').then(function(j){if(j.customer)show()});
})();

(function(){
var m=document.getElementById('dmsg');function say(x,b){m.className=b?'small err':'small ok';m.textContent=x}
document.getElementById('exp').onclick=function(){fetch('/api/customer/export',{credentials:'same-origin'}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'發生錯誤');return j})}).then(function(j){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(j,null,2)],{type:'application/json'}));a.download='my-data.json';a.click();say('已下載。')}).catch(function(e){say(e.message,1)})};
document.getElementById('del').onclick=function(){var pw=prompt('刪除帳戶無法還原。請輸入你的密碼確認：');if(!pw)return;var c=prompt('請輸入 DELETE 確認：');if(c!=='DELETE')return;
 fetch('/api/customer/delete',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw,confirm:c})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'發生錯誤');return j})}).then(function(){alert('帳戶已刪除（匿名化）。');location.reload()}).catch(function(e){say(e.message,1)})};
})();
