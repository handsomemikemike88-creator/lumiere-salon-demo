const test = require('node:test'), assert = require('node:assert/strict');
const env = require('../lib/env');
const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h:5432/d', APP_SECRET: 'a'.repeat(40), PUBLIC_BASE_URL: 'https://salon.example.com', ADMIN_EMAIL: 'a@b.example', ADMIN_PASSWORD: 'Correct-Horse-Battery-9' };
const fails = (e, re) => assert.throws(() => env.load(e), err => err instanceof env.ConfigError && re.test(err.message), re.toString());

test('valid production config loads, defaults are safe', () => {
  const c = env.load(base);
  assert.equal(c.STRIPE_MODE, 'test'); assert.equal(c.NOTIFY_ENABLED, false); assert.equal(c.SITE_DEMO_MODE, false); assert.equal(c.SEED_DEMO_DATA, false); assert.equal(c.EMAIL_PROVIDER, 'none'); assert.equal(c.HOST, '0.0.0.0');
});
test('fails fast with clear messages, listing all problems', () => {
  try { env.load({ NODE_ENV: 'production' }); assert.fail('should throw'); } catch (e) { assert.ok(e instanceof env.ConfigError); assert.ok(e.problems.length >= 3); assert.match(e.message, /DATABASE_URL/); assert.match(e.message, /APP_SECRET/); assert.match(e.message, /PUBLIC_BASE_URL/); }
});
test('production requires https base url and strong secret', () => {
  fails({ ...base, PUBLIC_BASE_URL: 'http://x.example.com' }, /https/); fails({ ...base, APP_SECRET: 'short' }, /APP_SECRET/);
});
test('admin password policy: min 12 chars', () => { fails({ ...base, ADMIN_PASSWORD: 'short1!' }, /ADMIN_PASSWORD/); fails({ ...base, ADMIN_EMAIL: '' }, /同時設定/); });
test('seed demo data refused in production unless demo mode', () => {
  fails({ ...base, SEED_DEMO_DATA: 'true' }, /SEED_DEMO_DATA/); assert.equal(env.load({ ...base, SEED_DEMO_DATA: 'true', SITE_DEMO_MODE: 'true' }).SEED_DEMO_DATA, true);
});
test('Stripe: live key is REFUSED in test mode (default)', () => {
  fails({ ...base, STRIPE_SECRET_KEY: 'sk_live_' + 'a'.repeat(24) }, /live.*金鑰|正式/);
  fails({ ...base, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_' + 'a'.repeat(24) }, /正式/);   // no STRIPE_ALLOW_LIVE=yes
  fails({ ...base, STRIPE_SECRET_KEY: 'pk_test_abc' }, /sk_test_/);
});
test('Stripe: STRIPE_MODE=live without ALLOW falls back to test mode with a warning', () => {
  const c = env.load({ ...base, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_test_' + 'a'.repeat(24) });
  assert.equal(c.STRIPE_MODE, 'test'); assert.ok(c.warnings.some(w => /STRIPE_ALLOW_LIVE/.test(w)));
});
test('Stripe: live needs ALLOW_LIVE=yes + sk_live_ + webhook secret', () => {
  const live = { ...base, STRIPE_MODE: 'live', STRIPE_ALLOW_LIVE: 'yes', STRIPE_SECRET_KEY: 'sk_live_' + 'a'.repeat(24), STRIPE_WEBHOOK_SECRET: 'whsec_' + 'b'.repeat(20) };
  assert.equal(env.load(live).STRIPE_LIVE, true);
  fails({ ...live, STRIPE_SECRET_KEY: 'sk_test_' + 'a'.repeat(24) }, /sk_live_/); fails({ ...live, STRIPE_WEBHOOK_SECRET: '' }, /STRIPE_WEBHOOK_SECRET/); fails({ ...live, STRIPE_ALLOW_LIVE: 'true' }, /正式/);
});
test('notifications: all off by default; enabling WhatsApp demands template + credentials', () => {
  const c = env.load(base); assert.equal(c.NOTIFY_ENABLED, false); assert.equal(c.NOTIFY_WHATSAPP, false);
  fails({ ...base, NOTIFY_ENABLED: 'true', NOTIFY_WHATSAPP: 'true' }, /WHATSAPP_PHONE_NUMBER_ID/);
  fails({ ...base, EMAIL_PROVIDER: 'sendgrid', EMAIL_FROM: 'x@y.example' }, /SENDGRID_API_KEY/); fails({ ...base, EMAIL_PROVIDER: 'smtp' }, /EMAIL_FROM/);
});
test('bad enum / numbers are rejected', () => { fails({ ...base, DATABASE_SSL: 'maybe' }, /DATABASE_SSL/); fails({ ...base, TRUST_PROXY: '9' }, /TRUST_PROXY/); fails({ ...base, RATE_LIMIT_DISABLED: 'true' }, /RATE_LIMIT/); });
