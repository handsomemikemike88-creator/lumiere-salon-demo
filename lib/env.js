'use strict';
// Environment loading + fail-fast validation. `load(env)` returns a frozen config object
// or throws ConfigError listing EVERY problem at once (clear messages, never echoing secrets).
const fs = require('fs'), path = require('path');

class ConfigError extends Error { constructor(problems) { super('配置錯誤 Configuration error:\n - ' + problems.join('\n - ')); this.problems = problems; } }

function loadEnvFile(file, target) {
  target = target || process.env;
  let txt; try { txt = fs.readFileSync(file || path.join(__dirname, '..', '.env'), 'utf8'); } catch (e) { return false; }
  txt.split(/\r?\n/).forEach(line => {
    if (/^\s*#/.test(line)) return;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (!m) return;
    let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    if (target[m[1]] === undefined || target[m[1]] === '') target[m[1]] = v;   // real env vars win
  });
  return true;
}

const bool = (v, d) => v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim());
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const str = (v, d) => (v === undefined || v === null || String(v).trim() === '') ? (d === undefined ? '' : d) : String(v).trim();

function load(env) {
  env = env || process.env;
  const p = [], w = [];
  const NODE_ENV = str(env.NODE_ENV, 'development');
  const prod = NODE_ENV === 'production';
  const c = { NODE_ENV, prod, warnings: w };
  c.PORT = int(env.PORT, 3000); if (c.PORT < 0 || c.PORT > 65535) p.push("PORT 必須是 1-65535 的數字。");
  c.HOST = str(env.HOST, prod ? '0.0.0.0' : '127.0.0.1');
  c.LOG_LEVEL = str(env.LOG_LEVEL, 'info');
  // --- database
  c.DATABASE_URL = str(env.DATABASE_URL);
  if (!c.DATABASE_URL) p.push('缺少 DATABASE_URL（例：postgres://user:password@localhost:5432/salon）。');
  else if (!/^postgres(ql)?:\/\//.test(c.DATABASE_URL)) p.push('DATABASE_URL 必須以 postgres:// 或 postgresql:// 開頭。');
  c.DATABASE_SSL = str(env.DATABASE_SSL, 'off').toLowerCase();
  if (!['off', 'require', 'no-verify'].includes(c.DATABASE_SSL)) p.push('DATABASE_SSL 只可以是 off、require 或 no-verify。');
  c.DB_POOL_MAX = int(env.DB_POOL_MAX, 10);
  c.AUTO_MIGRATE = bool(env.AUTO_MIGRATE, true);
  // --- secrets / URLs
  c.APP_SECRET = str(env.APP_SECRET);
  if (prod && c.APP_SECRET.length < 32) p.push('正式環境必須設定 APP_SECRET（至少 32 個字元的隨機字串；可用 `openssl rand -hex 32` 產生）。');
  if (!prod && c.APP_SECRET.length < 32) { c.APP_SECRET = require('crypto').randomBytes(32).toString('hex'); w.push('未設定 APP_SECRET：已使用臨時隨機值（重啟後退訂連結會失效）。'); }
  c.PUBLIC_BASE_URL = str(env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  if (c.PUBLIC_BASE_URL) {
    let u; try { u = new URL(c.PUBLIC_BASE_URL); } catch (e) { p.push('PUBLIC_BASE_URL 格式不正確（例：https://www.example.com）。'); }
    if (u) { if (!/^https?:$/.test(u.protocol)) p.push('PUBLIC_BASE_URL 必須是 http(s) 網址。'); if (prod && u.protocol !== 'https:') p.push('正式環境的 PUBLIC_BASE_URL 必須是 https:// 網址。'); c.ORIGIN = u.origin; }
  } else if (prod) p.push('正式環境必須設定 PUBLIC_BASE_URL（例：https://www.example.com），用於付款返回網址、重設密碼連結及來源檢查。');
  c.TRUST_PROXY = int(env.TRUST_PROXY, 0); if (c.TRUST_PROXY < 0 || c.TRUST_PROXY > 5) p.push('TRUST_PROXY 必須是 0-5（反向代理層數；Caddy／Render／Railway 後面用 1）。');
  // --- first admin
  c.ADMIN_EMAIL = str(env.ADMIN_EMAIL).toLowerCase(); c.ADMIN_PASSWORD = str(env.ADMIN_PASSWORD); c.ADMIN_NAME = str(env.ADMIN_NAME, '管理員');
  if ((c.ADMIN_EMAIL && !c.ADMIN_PASSWORD) || (!c.ADMIN_EMAIL && c.ADMIN_PASSWORD)) p.push('ADMIN_EMAIL 與 ADMIN_PASSWORD 必須同時設定（或同時留空，之後用 `npm run create-admin`）。');
  if (c.ADMIN_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.ADMIN_EMAIL)) p.push('ADMIN_EMAIL 格式不正確。');
  if (c.ADMIN_PASSWORD) { const why = require('./security').passwordProblem(c.ADMIN_PASSWORD, c.ADMIN_EMAIL); if (why) p.push('ADMIN_PASSWORD 不符合密碼規則：' + why); }
  // --- demo / content
  c.SITE_DEMO_MODE = bool(env.SITE_DEMO_MODE, false);
  c.SEED_DEMO_DATA = bool(env.SEED_DEMO_DATA, false);
  if (prod && c.SEED_DEMO_DATA && !c.SITE_DEMO_MODE) p.push('SEED_DEMO_DATA=true 在正式環境只可配合 SITE_DEMO_MODE=true（示範部署）使用；正式營運不得載入樣本資料。');
  c.store = { name: str(env.STORE_NAME), address: str(env.STORE_ADDRESS), phone: str(env.STORE_PHONE), whatsapp: str(env.STORE_WHATSAPP), hours: str(env.STORE_HOURS), brn: str(env.BUSINESS_REG_NO) };
  c.DATA_RETENTION_MONTHS = int(env.DATA_RETENTION_MONTHS, 24); if (c.DATA_RETENTION_MONTHS < 1) p.push('DATA_RETENTION_MONTHS 必須 ≥ 1。');
  // --- sessions / auth
  c.SESSION_TTL_HOURS_STAFF = int(env.SESSION_TTL_HOURS_STAFF, 8); c.SESSION_TTL_HOURS_CUSTOMER = int(env.SESSION_TTL_HOURS_CUSTOMER, 72);
  c.RESET_TOKEN_TTL_MINUTES = int(env.RESET_TOKEN_TTL_MINUTES, 60); c.INVITE_TTL_HOURS = int(env.INVITE_TTL_HOURS, 72);
  c.LOCKOUT_THRESHOLD = int(env.LOCKOUT_THRESHOLD, 5);
  c.RATE_LIMIT_DISABLED = bool(env.RATE_LIMIT_DISABLED, false);
  if (prod && c.RATE_LIMIT_DISABLED) p.push('RATE_LIMIT_DISABLED 不可在正式環境使用。');
  // --- Stripe
  const sm = str(env.STRIPE_MODE, 'test').toLowerCase();
  if (!['test', 'live'].includes(sm)) p.push('STRIPE_MODE 只可以是 test 或 live。');
  const key = str(env.STRIPE_SECRET_KEY), allow = str(env.STRIPE_ALLOW_LIVE).toLowerCase() === 'yes';
  c.STRIPE_WEBHOOK_SECRET = str(env.STRIPE_WEBHOOK_SECRET);
  c.STRIPE_API_BASE = str(env.STRIPE_API_BASE);
  let mode = 'test';
  if (sm === 'live') {
    if (!allow) { w.push('STRIPE_MODE=live 但沒有 STRIPE_ALLOW_LIVE=yes：已改用測試模式（test）並拒絕正式金鑰。'); }
    else if (!key) p.push('STRIPE_MODE=live 需要 STRIPE_SECRET_KEY（sk_live_ 開頭）。');
    else if (!/^sk_live_/.test(key)) p.push('STRIPE_MODE=live 時 STRIPE_SECRET_KEY 必須以 sk_live_ 開頭。');
    else mode = 'live';
  }
  if (mode === 'test' && key) {
    if (/^(sk|rk)_live_/.test(key)) p.push('已拒絕：偵測到正式（live）Stripe 金鑰，但目前是測試模式。要啟用正式收款，必須同時設定 STRIPE_MODE=live、STRIPE_ALLOW_LIVE=yes 及 sk_live_ 金鑰。');
    else if (!/^sk_test_/.test(key)) p.push('STRIPE_SECRET_KEY 必須以 sk_test_ 開頭（測試模式）。');
  }
  if (c.STRIPE_WEBHOOK_SECRET && !c.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) p.push('STRIPE_WEBHOOK_SECRET 必須以 whsec_ 開頭。');
  if (mode === 'live' && !c.STRIPE_WEBHOOK_SECRET) p.push('正式收款必須設定 STRIPE_WEBHOOK_SECRET。');
  if (c.STRIPE_API_BASE && prod) p.push('STRIPE_API_BASE 只供測試使用，不可在正式環境設定。');
  c.STRIPE_MODE = mode; c.STRIPE_SECRET_KEY = key; c.STRIPE_LIVE = mode === 'live';
  // --- notifications (ALL disabled by default)
  c.EMAIL_PROVIDER = str(env.EMAIL_PROVIDER, 'none').toLowerCase();
  if (!['none', 'smtp', 'sendgrid'].includes(c.EMAIL_PROVIDER)) p.push('EMAIL_PROVIDER 只可以是 none、smtp 或 sendgrid。');
  c.EMAIL_FROM = str(env.EMAIL_FROM);
  c.SMTP = { host: str(env.SMTP_HOST), port: int(env.SMTP_PORT, 587), secure: bool(env.SMTP_SECURE, false), user: str(env.SMTP_USER), pass: str(env.SMTP_PASS) };
  c.SENDGRID_API_KEY = str(env.SENDGRID_API_KEY); c.SENDGRID_API_BASE = str(env.SENDGRID_API_BASE, 'https://api.sendgrid.com');
  if (c.EMAIL_PROVIDER !== 'none' && !c.EMAIL_FROM) p.push('使用電郵發送必須設定 EMAIL_FROM（例：Salon <no-reply@example.com>）。');
  if (c.EMAIL_PROVIDER === 'smtp' && !c.SMTP.host) p.push('EMAIL_PROVIDER=smtp 需要 SMTP_HOST。');
  if (c.EMAIL_PROVIDER === 'sendgrid' && !c.SENDGRID_API_KEY) p.push('EMAIL_PROVIDER=sendgrid 需要 SENDGRID_API_KEY。');
  c.NOTIFY_ENABLED = bool(env.NOTIFY_ENABLED, false);          // master switch for REAL reminder sending
  c.NOTIFY_EMAIL = bool(env.NOTIFY_EMAIL, true);
  c.NOTIFY_WHATSAPP = bool(env.NOTIFY_WHATSAPP, false);
  c.NOTIFY_DRY_RUN = bool(env.NOTIFY_DRY_RUN, false);
  c.WHATSAPP = { phoneNumberId: str(env.WHATSAPP_PHONE_NUMBER_ID), token: str(env.WHATSAPP_ACCESS_TOKEN), apiVersion: str(env.WHATSAPP_API_VERSION, 'v21.0'), lang: str(env.WHATSAPP_TEMPLATE_LANG, 'zh_HK'), apiBase: str(env.WHATSAPP_API_BASE, 'https://graph.facebook.com'),
    templates: { confirmation: str(env.WHATSAPP_TEMPLATE_CONFIRMATION), 'day-before': str(env.WHATSAPP_TEMPLATE_REMINDER), 'same-day': str(env.WHATSAPP_TEMPLATE_REMINDER) } };
  if (c.NOTIFY_ENABLED && c.NOTIFY_WHATSAPP && !c.NOTIFY_DRY_RUN) {
    if (!c.WHATSAPP.phoneNumberId || !c.WHATSAPP.token) p.push('啟用 WhatsApp 發送需要 WHATSAPP_PHONE_NUMBER_ID 及 WHATSAPP_ACCESS_TOKEN。');
    if (!c.WHATSAPP.templates.confirmation || !c.WHATSAPP.templates['day-before']) p.push('啟用 WhatsApp 發送需要已獲批准的範本名稱：WHATSAPP_TEMPLATE_CONFIRMATION 及 WHATSAPP_TEMPLATE_REMINDER。');
  }
  if (c.NOTIFY_ENABLED && c.NOTIFY_EMAIL && c.EMAIL_PROVIDER === 'none' && !c.NOTIFY_DRY_RUN) w.push('NOTIFY_ENABLED=true 但 EMAIL_PROVIDER=none：電郵不會真正發送。');
  c.SEND_ONLY_TO_ALLOWLIST = str(env.NOTIFY_TEST_ALLOWLIST).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (p.length) throw new ConfigError(p);
  return Object.freeze(c);
}
module.exports = { load, loadEnvFile, ConfigError };
