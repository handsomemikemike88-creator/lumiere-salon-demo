(function(){var r=new URLSearchParams(location.search).get('result');var t=document.getElementById('t'),m=document.getElementById('m'),tag=document.getElementById('tag'),mn=document.getElementById('modenote');
fetch('/api/config').then(function(x){return x.json()}).then(function(c){
 if(!c.stripe.live){tag.textContent='Sample / Test Data - Stripe Test Mode, not a real transaction';mn.textContent='這是測試模式，沒有真實扣款。'}else{tag.hidden=true}
}).catch(function(){});
if(r==='success'){t.textContent='已返回：付款頁已完成';m.textContent='付款頁顯示已完成。本頁只是返回頁，付款結果仍待本店系統驗證後才會確認。'}
else if(r==='cancel'){t.textContent='已取消付款';m.textContent='你已取消這次付款，沒有任何扣款。'}})();
