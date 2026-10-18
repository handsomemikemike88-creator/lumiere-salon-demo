(function(){
var q=new URLSearchParams(location.search);
function api(u,b){return fetch(u,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'發生錯誤');return j})})}
var msg=document.getElementById('msg');function say(t,bad){msg.className=bad?'small err':'small ok';msg.textContent=t}
var ff=document.getElementById('ff');
if(ff)ff.onsubmit=function(e){e.preventDefault();api('/api/auth/forgot',{kind:q.get('k')==='customer'?'customer':'staff',identifier:ff.identifier.value}).then(function(j){say(j.message)}).catch(function(x){say(x.message,1)})};
var rf=document.getElementById('rf');
if(rf)rf.onsubmit=function(e){e.preventDefault();api('/api/auth/reset',{kind:q.get('k')==='customer'?'customer':'staff',token:q.get('t')||'',password:rf.password.value}).then(function(){say('密碼已更新，請重新登入。');rf.hidden=true;var a=document.createElement('p');a.innerHTML='<a href="'+(q.get('k')==='customer'?'/account/':'/staff/login.html')+'">前往登入</a>';rf.parentNode.appendChild(a)}).catch(function(x){say(x.message,1)})};
var go=document.getElementById('go');
if(go)go.onclick=function(){api('/api/unsubscribe',{c:q.get('c'),a:q.get('a'),s:q.get('s')}).then(function(){say('已退訂。你不會再收到預約通知。');go.hidden=true}).catch(function(x){say(x.message,1)})};
})();
