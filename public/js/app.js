(function(){
var btn=document.querySelector('.menu-btn'),nav=document.getElementById('nav');
if(btn)btn.onclick=function(){var o=nav.classList.toggle('open');btn.setAttribute('aria-expanded',o)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(method,url,body){var o={method:method,headers:{},credentials:'same-origin'};if(method!=='GET'){o.headers['Content-Type']='application/json';o.body=JSON.stringify(body||{})}
 return fetch(url,o).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'發生錯誤');return j})})}
function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
var WD=['日','一','二','三','四','五','六'];
var RS={pending:'待安排',drafted:'已備草稿（職員尚未發出）',sent:'已發出',failed:'發送失敗，職員跟進中'},RK={confirmation:'預約確認','day-before':'前一日提醒','same-day':'當日提醒'};
var STORE='';fetch('/api/config').then(function(r){return r.json()}).then(function(c){STORE=c.storeName+(c.demo?'（示範，單一門店）':'（單一門店）');var d=document.getElementById('detail');if(d&&d.firstChild&&window.__lastBooking)render(window.__lastBooking)}).catch(function(){});
var f=document.getElementById('bf');
if(f){
 var q=new URLSearchParams(location.search),date=null,time=null,rid=q.get('reschedule'),tok=q.get('t')||'';
 var err=document.getElementById('err'),days=document.getElementById('days'),slots=document.getElementById('slots'),avail={};
 if(q.get('service')){var r=f.querySelector('input[value="'+q.get('service').replace(/[^\w-]/g,'')+'"]');if(r)r.checked=true}
 if(rid){document.getElementById('svc').closest('fieldset').hidden=true;document.getElementById('infoset').hidden=true;document.getElementById('submitbtn').textContent='確認改期 Reschedule';
  var h=document.querySelector('h1');if(h)h.innerHTML='改期 <span class="en">Reschedule</span>'}
 else{api('GET','/api/customer/me').then(function(j){if(j.customer){f.name.value=j.customer.name;f.phone.value=j.customer.phone||'';f.email.value=j.customer.email||'';
  var n=document.getElementById('cnote');n.hidden=false;n.textContent='已以會員身份登入：預約會顯示在你的會員專區。'}}).catch(function(){})}
 var from=new Date(),to=new Date(Date.now()+28*864e5);
 api('GET','/api/availability?from='+iso(from)+'&to='+iso(to)).then(function(j){
  j.days.slice(0,14).forEach(function(dd){avail[dd.date]=dd.slots;var d=new Date(dd.date+'T00:00:00');var b=document.createElement('button');b.type='button';b.className='chip';b.textContent=(d.getMonth()+1)+'/'+d.getDate()+'（'+WD[d.getDay()]+'）';
   b.onclick=function(){date=dd.date;time=null;[].forEach.call(days.children,function(c){c.classList.remove('on')});b.classList.add('on');draw()};days.appendChild(b)})
 }).catch(function(e){err.textContent=e.message});
 function draw(){slots.innerHTML='';(avail[date]||[]).forEach(function(s){var b=document.createElement('button');b.type='button';b.className='chip';
  var past=new Date(date+'T'+s.time+':00').getTime()<Date.now()+2*36e5;b.textContent=s.time+(s.remaining>0&&!past?'':'（已滿）');
  if(s.remaining<=0||past){b.disabled=true;b.title=past?'已過時間':'已滿'}
  b.onclick=function(){time=s.time;[].forEach.call(slots.children,function(c){c.classList.remove('on')});b.classList.add('on')};slots.appendChild(b)})}
 f.onsubmit=function(e){e.preventDefault();err.textContent='';
  if(rid){if(!date||!time)return err.textContent='請選擇日期及時段。';
   return api('POST','/api/bookings/'+encodeURIComponent(rid)+'/reschedule',{date:date,time:time,token:tok}).then(function(){location.href='confirmation.html?id='+encodeURIComponent(rid)+(tok?'&t='+encodeURIComponent(tok):'')}).catch(function(x){err.textContent=x.message})}
  var s=f.service.value,name=f.name.value.trim(),ph=f.phone.value.replace(/[\s-]/g,'');
  if(!s)return err.textContent='請選擇服務。';if(!date||!time)return err.textContent='請選擇日期及時段。';
  if(!name)return err.textContent='請填寫稱呼。';if(!/^(\+?852)?[2-9]\d{7}$/.test(ph))return err.textContent='請填寫有效的香港電話號碼（8 位數字）。';
  if(!f.consent.checked)return err.textContent='請剔選同意《收集個人資料聲明》。';
  api('POST','/api/bookings',{service:s,date:date,time:time,name:name,phone:f.phone.value.trim(),email:f.email.value.trim(),note:f.note.value.trim(),consent:f.consent.checked,marketing:f.marketing.checked}).then(function(j){location.href='confirmation.html?id='+encodeURIComponent(j.id)+'&t='+encodeURIComponent(j.token)}).catch(function(x){err.textContent=x.message})};
}
var det=document.getElementById('detail');
if(det){var qq=new URLSearchParams(location.search),id=qq.get('id'),t=qq.get('t')||'';
 function render(b){window.__lastBooking=b;det.innerHTML='<dl class="det"><dt>預約編號</dt><dd>'+esc(b.id)+'</dd><dt>服務</dt><dd>'+esc(b.serviceName)+'（'+esc(b.priceLabel)+'）</dd><dt>日期</dt><dd>'+esc(b.date)+'</dd><dt>時間</dt><dd>'+esc(b.time)+'</dd><dt>門店</dt><dd>'+esc(STORE)+'</dd><dt>稱呼</dt><dd>'+esc(b.name)+'</dd><dt>WhatsApp</dt><dd>'+esc(b.phone)+'</dd><dt>狀態</dt><dd>'+(b.status==='cancelled'?'已取消':b.status==='booked'?'已預約':b.status==='attended'?'已出席':'未出席')+'</dd></dl>';
  var rem=document.getElementById('remstatus');if(rem)rem.innerHTML=['confirmation','day-before','same-day'].filter(function(k){return b.reminders[k]}).map(function(k){return '<li>'+RK[k]+'：'+RS[b.reminders[k]]+'</li>'}).join('');
  var a=document.getElementById('actions');
  a.innerHTML=b.status==='booked'&&b.canChange?'<a class="btn ghost" href="booking.html?reschedule='+encodeURIComponent(b.id)+'&t='+encodeURIComponent(t)+'">免費改期</a> <button class="btn ghost" id="cx" type="button">取消預約</button>':(b.status==='booked'?'<span class="small">預約前 24 小時內不能自助改期或取消，請聯絡本店。</span>':'');
  var c=document.getElementById('cx');if(c)c.onclick=function(){if(confirm('確定取消此預約？')){api('POST','/api/bookings/'+encodeURIComponent(b.id)+'/cancel',{token:t}).then(load).catch(function(x){alert(x.message)})}}}
 function load(){api('GET','/api/bookings/'+encodeURIComponent(id)+'?t='+encodeURIComponent(t)).then(function(j){render(j.booking)}).catch(function(){det.innerHTML='<p>找不到預約記錄。<a href="booking.html">前往預約</a></p>';document.querySelector('#conf .card:nth-of-type(2)').hidden=true})}
 load()}
})();
