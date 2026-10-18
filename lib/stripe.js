'use strict';
// Minimal Stripe client (zero deps: fetch + crypto). Mode is decided by validated config (see env.js):
// test mode accepts only sk_test_ keys; live mode needs STRIPE_ALLOW_LIVE=yes and an sk_live_ key.
const crypto = require('crypto');
class StripeError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const redact = s => String(s == null ? '' : s).replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9_*]+/g, '[redacted-key]').replace(/\bwhsec_[A-Za-z0-9_*]+/g, '[redacted-secret]');

function encodeForm(obj) {
  const out = [];
  (function walk(v, prefix) {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, prefix + '[' + i + ']'));
    else if (typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], prefix ? prefix + '[' + k + ']' : k));
    else out.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(String(v)));
  })(obj, '');
  return out.join('&');
}
// Verify Stripe-Signature: t=<unix>,v1=<hex> over `${t}.${rawBody}` (HMAC-SHA256 with whsec), 5 min tolerance, constant-time.
function verifyWebhook(rawBody, header, secret, toleranceSec, nowMs) {
  toleranceSec = toleranceSec == null ? 300 : toleranceSec;
  if (!Buffer.isBuffer(rawBody)) throw new StripeError(400, 'webhook 需要原始 body');
  if (typeof header !== 'string' || !header) throw new StripeError(400, '缺少 Stripe-Signature');
  let t = null; const sigs = [];
  header.split(',').forEach(part => { const i = part.indexOf('='); if (i < 0) return; const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim(); if (k === 't') t = v; else if (k === 'v1') sigs.push(v); });
  if (!t || !/^\d+$/.test(t) || !sigs.length) throw new StripeError(400, 'Stripe-Signature 格式不正確');
  const expected = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(t + '.', 'utf8'), rawBody])).digest();
  if (!sigs.some(s => /^[0-9a-fA-F]{64}$/.test(s) && crypto.timingSafeEqual(expected, Buffer.from(s, 'hex')))) throw new StripeError(400, 'Stripe 簽名驗證失敗');
  if (Math.abs((nowMs == null ? Date.now() : nowMs) / 1000 - Number(t)) > toleranceSec) throw new StripeError(400, 'Stripe 簽名時間超出 5 分鐘容許範圍');
  try { return JSON.parse(rawBody.toString('utf8')); } catch (e) { throw new StripeError(400, 'webhook 內容不是有效 JSON'); }
}
const signPayload = (raw, secret, tSec) => { tSec = tSec || Math.floor(Date.now() / 1000); return `t=${tSec},v1=${crypto.createHmac('sha256', secret).update(tSec + '.' + raw).digest('hex')}`; };

module.exports = cfg => {
  const mode = cfg.STRIPE_MODE;
  function secretKey() {
    const k = cfg.STRIPE_SECRET_KEY;
    if (!k) throw new StripeError(503, 'Stripe 尚未設定：請設定 STRIPE_SECRET_KEY（' + (mode === 'live' ? 'sk_live_' : 'sk_test_') + ' 開頭）。');
    if (mode === 'test' && !k.startsWith('sk_test_')) throw new StripeError(500, '已拒絕：測試模式只接受 sk_test_ 金鑰。');
    if (mode === 'live' && !k.startsWith('sk_live_')) throw new StripeError(500, '已拒絕：正式模式需要 sk_live_ 金鑰。');
    return k;
  }
  function webhookSecret() {
    if (!cfg.STRIPE_WEBHOOK_SECRET) throw new StripeError(503, 'Stripe webhook 尚未設定：請設定 STRIPE_WEBHOOK_SECRET（whsec_ 開頭）。');
    return cfg.STRIPE_WEBHOOK_SECRET;
  }
  function apiBase() {
    if (!cfg.STRIPE_API_BASE) return 'https://api.stripe.com';
    const u = new URL(cfg.STRIPE_API_BASE);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new StripeError(500, 'STRIPE_API_BASE 只可指向本機測試伺服器。');
    return u.origin;
  }
  function status() {
    let keyOk = false, keyError = null, whOk = false; try { secretKey(); keyOk = true; } catch (e) { keyError = e.message; } try { webhookSecret(); whOk = true; } catch (e) { /* unset */ }
    return { mode, live: mode === 'live', secretKeyConfigured: keyOk, keyError, webhookSecretConfigured: whOk };
  }
  async function request(method, p, params, opts) {
    const headers = { Authorization: 'Bearer ' + secretKey(), 'Stripe-Version': '2024-06-20' }; let body;
    if (method !== 'GET') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = encodeForm(params || {}); if (opts && opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey; }
    let r, text;
    try { r = await fetch(apiBase() + p, { method, headers, body, signal: AbortSignal.timeout(20000) }); text = await r.text(); }
    catch (e) { if (e instanceof StripeError) throw e; throw new StripeError(502, '無法連接 Stripe（' + redact(e.name === 'TimeoutError' ? '逾時' : e.message) + '）。'); }
    let j; try { j = JSON.parse(text); } catch (e) { throw new StripeError(502, 'Stripe 回應格式不正確（HTTP ' + r.status + '）'); }
    if (!r.ok) throw new StripeError(502, 'Stripe 錯誤：' + redact((j.error && j.error.message) || ('HTTP ' + r.status)));
    return j;
  }
  return {
    StripeError, mode, secretKey, webhookSecret, status, redact,
    createCheckoutSession: (params, idem) => request('POST', '/v1/checkout/sessions', params, { idempotencyKey: idem }),
    retrieveCheckoutSession: id => request('GET', '/v1/checkout/sessions/' + encodeURIComponent(id)),
    expireCheckoutSession: id => request('POST', '/v1/checkout/sessions/' + encodeURIComponent(id) + '/expire', {}),
    verifyWebhook
  };
};
module.exports.verifyWebhook = verifyWebhook; module.exports.signPayload = signPayload; module.exports.StripeError = StripeError; module.exports.encodeForm = encodeForm; module.exports.redact = redact;
