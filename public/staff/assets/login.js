(function(){
var f=document.getElementById('lf'),err=document.getElementById('err');
function api(url,body){return fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'發生錯誤');return j})})}
f.onsubmit=function(e){e.preventDefault();err.textContent='';api('/api/staff/login',{email:f.email.value,password:f.password.value}).then(function(){location.href='/staff/index.html'}).catch(function(x){err.textContent=x.message})};
})();
