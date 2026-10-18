'use strict';
const crypto = require('crypto');
const scrypt = (pw, salt, n) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, { N: n, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (e, k) => e ? no(e) : ok(k)));
const SCRYPT_N = 32768;
async function hashPassword(pw) { const salt = crypto.randomBytes(16); const h = await scrypt(pw, salt, SCRYPT_N); return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${h.toString('hex')}`; }
async function verifyPassword(pw, stored) {
  try {
    const [alg, n, s, h] = String(stored || '').split('$'); if (alg !== 'scrypt') return false;
    const c = await scrypt(String(pw), Buffer.from(s, 'hex'), Number(n)); const hb = Buffer.from(h, 'hex');
    return c.length === hb.length && crypto.timingSafeEqual(c, hb);
  } catch (e) { return false; }
}
// A throwaway hash so unknown accounts cost the same time as known ones (no user enumeration by timing).
let dummy; const dummyHash = async () => dummy || (dummy = await hashPassword('dummy-password-never-valid'));
const COMMON = ['password1234', '123456789012', 'qwertyuiop12', 'iloveyou1234', 'administrator', 'password12345', 'welcome12345', 'letmein12345'];
// Password policy: min 12, max 200, not the email, not obviously common, at least 2 character classes.
function passwordProblem(pw, email) {
  if (typeof pw !== 'string') return '請輸入密碼';
  if (pw.length < 12) return '密碼最少 12 個字元';
  if (pw.length > 200) return '密碼過長（最多 200 個字元）';
  const l = pw.toLowerCase();
  if (email && (l === String(email).toLowerCase() || l.includes(String(email).toLowerCase().split('@')[0]) && String(email).split('@')[0].length >= 5)) return '密碼不可包含電郵名稱';
  if (COMMON.includes(l) || /^(.)\1+$/.test(pw)) return '密碼太容易猜中，請改用較長且少見的密碼';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (classes < 2) return '密碼須混合至少兩種字元類型（大小寫字母、數字、符號）；或使用較長的句子';
  return null;
}
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = (bytes) => crypto.randomBytes(bytes || 32).toString('base64url');
const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(String(s)).digest('base64url');
function safeEq(a, b) { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
// Short, non-reversible tag for logs (never log raw IPs).
const ipTag = (secret, ip) => crypto.createHmac('sha256', secret).update(String(ip || '')).digest('hex').slice(0, 10);

// In-memory sliding-window rate limiter (PER INSTANCE: with several app instances each keeps its own counters).
class RateLimiter {
  constructor(disabled) { this.m = new Map(); this.disabled = !!disabled; this.t = setInterval(() => this.sweep(), 60000); this.t.unref(); }
  sweep() { const now = Date.now(); for (const [k, v] of this.m) { if (!v.hits.length || v.hits[v.hits.length - 1] < now - v.win) this.m.delete(k); } }
  // returns {limited, retryAfterSec}
  hit(bucket, key, max, windowMs) {
    if (this.disabled) return { limited: false, retryAfterSec: 0 };
    const k = bucket + '|' + key, now = Date.now(); let e = this.m.get(k); if (!e) { e = { hits: [], win: windowMs }; this.m.set(k, e); }
    e.win = windowMs; e.hits = e.hits.filter(t => t > now - windowMs);
    if (e.hits.length >= max) return { limited: true, retryAfterSec: Math.max(1, Math.ceil((e.hits[0] + windowMs - now) / 1000)) };
    e.hits.push(now); return { limited: false, retryAfterSec: 0 };
  }
  reset() { this.m.clear(); }
  close() { clearInterval(this.t); }
}
// Client IP behind N trusted proxies: take the Nth entry from the right of X-Forwarded-For.
function clientIp(req, trustHops) {
  const direct = (req.socket && req.socket.remoteAddress) || '';
  if (!trustHops) return direct;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!xff.length) return direct;
  return xff[Math.max(0, xff.length - trustHops)] || direct;
}
module.exports = { hashPassword, verifyPassword, dummyHash, passwordProblem, sha256, newToken, hmac, safeEq, ipTag, RateLimiter, clientIp };
