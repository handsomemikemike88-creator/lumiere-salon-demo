(function(){
var t=new URLSearchParams(location.search).get('t')||'',f=document.getElementById('rf'),info=document.getElementById('info'),err=document.getElementById('err'),done=document.getElementById('done');
function api(m,u,b){var o={method:m,credentials:'same-origin',headers:{}};if(m!=='GET'){o.headers['Content-Type']='application/json';o.body=JSON.stringify(b||{})}return fetch(u,o).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'發生錯誤');return j})})}
api('GET','/api/invite/'+encodeURIComponent(t)).then(function(j){info.textContent='邀請對象：'+j.email;f.email.value=j.email;f.hidden=false}).catch(function(e){info.className='err';info.textContent=e.message});
f.onsubmit=function(e){e.preventDefault();err.textContent='';api('POST','/api/staff/register',{token:t,name:f.name.value,password:f.password.value}).then(function(j){f.hidden=true;info.hidden=true;done.textContent=j.message}).catch(function(x){err.textContent=x.message})};
})();
