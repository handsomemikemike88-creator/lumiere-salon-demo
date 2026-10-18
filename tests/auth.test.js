const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./helpers'), S = require('../lib/security'), env = require('../lib/env');

// capture outgoing e-mail through a mocked provider
const mockMail = () => { const sent = []; return { sent, p: { name: 'mock', async send(m) { sent.push(m); return { id: 'm' + sent.length }; } } }; };

test('no demo credentials / invite code exist; only the env-created admin', async () => {
  const app = await H.makeApp(); try {
    const c = new H.Client(app.base);
    for (const [e, p] of [['admin@example.com', 'Admin#12345'], ['staff@example.com', 'Staff#12345']]) assert.equal((await c.post('/api/staff/login', { email: e, password: p })).status, 401);
    assert.equal((await c.post('/api/staff/register', { token: 'LUMIERE-DEMO', name: 'x', password: 'Whatever-Pass-123' })).status, 404);
    assert.equal((await app.ctx.db.one('select count(*)::int n from staff')).n, 1);
    assert.equal((await c.post('/api/staff/login', H.ADMIN)).status, 200);
  } finally { await app.stop(); }
});
test('session: token stored hashed, cookie flags, rotation on login, logout', async () => {
  const app = await H.makeApp(); try {
    const c = new H.Client(app.base); await c.post('/api/staff/login', H.ADMIN);
    const sc = c.last.headers.getSetCookie()[0]; assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.doesNotMatch(sc, /Secure/);   // non-production
    const tok = decodeURIComponent(c.jar.staff_sid); const row = await app.ctx.db.one('select * from sessions'); assert.equal(row.token_hash, S.sha256(tok)); assert.notEqual(row.token_hash, tok);
    assert.equal((await app.ctx.db.all("select 1 from sessions where token_hash = $1", [tok])).length, 0);
    const first = c.jar.staff_sid; await c.post('/api/staff/login', H.ADMIN);      // login again with old cookie => rotated
    assert.notEqual(c.jar.staff_sid, first); const old = new H.Client(app.base); old.jar.staff_sid = first; assert.equal((await old.get('/api/staff/me')).status, 401);
    assert.equal((await c.get('/api/staff/me')).status, 200); await c.post('/api/staff/logout'); assert.equal((await c.get('/api/staff/me')).status, 401);
  } finally { await app.stop(); }
});
test('production cookies are Secure + HttpOnly + SameSite=Strict + __Host- prefixed; HSTS set', async () => {
  const app = await H.makeApp({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://salon.example.com', TRUST_PROXY: '1' }); try {
    const c = new H.Client(app.base, 'https://salon.example.com'); const r = await c.post('/api/staff/login', H.ADMIN, { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' } });
    assert.equal(r.status, 200); const sc = r.headers.getSetCookie()[0]; assert.match(sc, /^__Host-staff_sid=/); assert.match(sc, /; Secure/); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
    assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
    const plain = await new H.Client(app.base).get('/staff/login.html', { headers: { 'X-Forwarded-Proto': 'http' } }); assert.equal(plain.status, 308);   // http -> https redirect behind proxy
  } finally { await app.stop(); }
});
test('CSRF: mutating requests need same Origin + JSON content type', async () => {
  const app = await H.makeApp(); try {
    const c = new H.Client(app.base);
    assert.equal((await c.post('/api/staff/login', H.ADMIN, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.post('/api/staff/login', H.ADMIN, { noOrigin: true })).status, 403);
    assert.equal((await c.post('/api/staff/login', H.ADMIN, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await c.req('POST', '/api/staff/login', 'email=a&password=b', { raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await c.post('/api/staff/login', H.ADMIN)).status, 200);
    assert.equal((await c.post('/api/staff/logout', {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.get('/api/staff/me')).status, 200);   // still logged in: forged logout rejected
  } finally { await app.stop(); }
});
test('rate limiting on login / register / booking (per instance) returns 429 + Retry-After', async () => {
  const app = await H.makeApp(); try {
    const c = new H.Client(app.base); let last;
    for (let i = 0; i < 9; i++) last = await c.post('/api/staff/login', { email: 'nobody@x.example', password: 'wrong-password-123' });
    assert.equal(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) > 0);
    let b; for (let i = 0; i < 12; i++) b = await c.post('/api/bookings', { service: 'hf-trial', date: '2000-01-01', time: '10:00', name: 'x', phone: '91234567', consent: true });
    assert.equal(b.status, 429);
    let r; for (let i = 0; i < 11; i++) r = await c.post('/api/staff/register', { token: 'bad', name: 'x', password: 'Whatever-Pass-123' }); assert.equal(r.status, 429);
    let cr; for (let i = 0; i < 6; i++) cr = await c.post('/api/customer/register', { name: 'x', email: 'a' + i + '@x.example', password: 'Whatever-Pass-123' }); assert.equal(cr.status, 429);
  } finally { await app.stop(); }
});
test('account lockout with exponential backoff; success resets', async () => {
  const app = await H.makeApp({ LOCKOUT_THRESHOLD: '3', RATE_LIMIT_DISABLED: undefined }); try {
    app.ctx.limiter.disabled = true;                       // isolate lockout from the IP limiter
    const c = new H.Client(app.base);
    for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/staff/login', { email: H.ADMIN.email, password: 'wrong-wrong-wrong' })).status, 401);
    const locked = await c.post('/api/staff/login', H.ADMIN); assert.equal(locked.status, 429, 'correct password rejected while locked'); assert.match(locked.json.error, /鎖定/);
    let row = await app.ctx.db.one('select failed_logins, locked_until from staff'); assert.equal(row.failed_logins, 3); assert.ok(new Date(row.locked_until) > new Date());
    await app.ctx.db.q("update staff set locked_until = now() - interval '1 second'");               // lock elapsed
    assert.equal((await c.post('/api/staff/login', { email: H.ADMIN.email, password: 'wrong-wrong-wrong' })).status, 401);
    row = await app.ctx.db.one('select failed_logins, locked_until from staff'); assert.equal(row.failed_logins, 4);
    const mins = (new Date(row.locked_until) - Date.now()) / 60000; assert.ok(mins > 1.5 && mins <= 2.1, 'backoff doubled to ~2 min, got ' + mins);
    await app.ctx.db.q("update staff set locked_until = null"); assert.equal((await c.post('/api/staff/login', H.ADMIN)).status, 200);
    assert.equal((await app.ctx.db.one('select failed_logins from staff')).failed_logins, 0);
  } finally { await app.stop(); }
});
test('password policy (>=12 chars) and scrypt hashing', async () => {
  assert.ok(S.passwordProblem('short1!A')); assert.ok(S.passwordProblem('aaaaaaaaaaaaaaaa')); assert.ok(S.passwordProblem('alllowercaseonly')); assert.equal(S.passwordProblem('Correct-Horse-Battery-9'), null);
  const h = await S.hashPassword('Correct-Horse-Battery-9'); assert.match(h, /^scrypt\$32768\$/); assert.ok(await S.verifyPassword('Correct-Horse-Battery-9', h)); assert.ok(!(await S.verifyPassword('wrong', h)));
  const app = await H.makeApp(); try { const row = await app.ctx.db.one('select pw_hash from staff'); assert.match(row.pw_hash, /^scrypt\$/); assert.doesNotMatch(row.pw_hash, /Correct-Horse/);
    const a = await H.loginAdmin(app); assert.equal((await a.post('/api/staff/password', { current: H.ADMIN.password, next: 'tooshort1A' })).status, 400);
  } finally { await app.stop(); }
});
test('password change revokes ALL other sessions', async () => {
  const app = await H.makeApp(); try {
    const a1 = await H.loginAdmin(app), a2 = await H.loginAdmin(app); assert.equal((await a2.get('/api/staff/me')).status, 200);
    const r = await a1.post('/api/staff/password', { current: H.ADMIN.password, next: 'Brand-New-Passphrase-77' }); assert.equal(r.status, 200);
    assert.equal((await a2.get('/api/staff/me')).status, 401); assert.equal((await a1.get('/api/staff/me')).status, 200);   // current device gets a fresh session
    assert.equal((await new H.Client(app.base).post('/api/staff/login', H.ADMIN)).status, 401); assert.equal((await new H.Client(app.base).post('/api/staff/login', { email: H.ADMIN.email, password: 'Brand-New-Passphrase-77' })).status, 200);
    assert.ok((await app.ctx.db.one("select count(*)::int n from audit_log where action = 'staff.password_changed'")).n >= 1);
  } finally { await app.stop(); }
});
test('password reset (staff + customer): token via mocked e-mail only, never in response, single use, revokes sessions', async () => {
  const m = mockMail(); const app = await H.makeApp({ NODE_ENV: 'test', EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'x', EMAIL_FROM: 'Salon <no-reply@x.example>' }, { providers: { email: m.p, whatsapp: null } }); try {
    const s1 = await H.loginAdmin(app); const c = new H.Client(app.base);
    const r = await c.post('/api/auth/forgot', { kind: 'staff', identifier: H.ADMIN.email }); assert.equal(r.status, 200); assert.doesNotMatch(JSON.stringify(r.json), /[A-Za-z0-9_-]{40,}/);
    const r2 = await c.post('/api/auth/forgot', { kind: 'staff', identifier: 'unknown@x.example' }); assert.deepEqual(r2.json, r.json);   // no enumeration
    assert.equal(m.sent.length, 1); assert.equal(m.sent[0].to, H.ADMIN.email);
    const token = new URL(/https?:\/\/\S+/.exec(m.sent[0].text)[0]).searchParams.get('t');
    assert.equal((await c.post('/api/auth/reset', { kind: 'staff', token, password: 'short' })).status, 400);
    assert.equal((await c.post('/api/auth/reset', { kind: 'staff', token, password: 'Reset-Passphrase-2026' })).status, 200);
    assert.equal((await c.post('/api/auth/reset', { kind: 'staff', token, password: 'Another-Passphrase-2026' })).status, 400, 'token is single-use');
    assert.equal((await s1.get('/api/staff/me')).status, 401, 'old sessions revoked');
    assert.equal((await new H.Client(app.base).post('/api/staff/login', { email: H.ADMIN.email, password: 'Reset-Passphrase-2026' })).status, 200);
    // expiry
    await c.post('/api/auth/forgot', { kind: 'staff', identifier: H.ADMIN.email }); const t2 = new URL(/https?:\/\/\S+/.exec(m.sent[1].text)[0]).searchParams.get('t');
    await app.ctx.db.q("update password_resets set expires_at = now() - interval '1 minute'"); assert.equal((await c.post('/api/auth/reset', { kind: 'staff', token: t2, password: 'Expired-Passphrase-2026' })).status, 400);
    // customer
    const cu = new H.Client(app.base); assert.equal((await cu.post('/api/customer/register', { name: '客', email: 'cust@x.example', password: 'Customer-Passphrase-1', consent: true })).status, 200);
    await c.post('/api/auth/forgot', { kind: 'customer', identifier: 'cust@x.example' }); const t3 = new URL(/https?:\/\/\S+/.exec(m.sent[2].text)[0]); assert.equal(t3.searchParams.get('k'), 'customer');
    assert.equal((await c.post('/api/auth/reset', { kind: 'customer', token: t3.searchParams.get('t'), password: 'Customer-NewPass-22' })).status, 200);
    assert.equal((await cu.get('/api/customer/me')).json.customer, null);
    assert.equal((await new H.Client(app.base).post('/api/customer/login', { identifier: 'cust@x.example', password: 'Customer-NewPass-22' })).status, 200);
  } finally { await app.stop(); }
});
test('no e-mail provider: reset link goes to the server log only, never to the HTTP response', async () => {
  const app = await H.makeApp({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://salon.example.com' }); try {
    const c = new H.Client(app.base, 'https://salon.example.com'); const r = await c.post('/api/auth/forgot', { kind: 'staff', identifier: H.ADMIN.email });
    assert.equal(r.status, 200); assert.doesNotMatch(r.text, /reset\.html|token/i);
    assert.ok(app.logs.some(l => /reset\.html\?k=staff&t=/.test(l) && /NO EMAIL PROVIDER/.test(l)), 'link available to the operator in logs');
  } finally { await app.stop(); }
});
test('unauthenticated and wrong-role access is refused', async () => {
  const app = await H.makeApp(); try {
    const c = new H.Client(app.base);
    for (const p of ['/api/staff/dashboard', '/api/staff/leads', '/api/admin/audit', '/api/admin/invitations', '/api/customer/bookings']) assert.equal((await c.get(p)).status, 401, p);
    assert.equal((await c.get('/staff/index.html')).status, 302); assert.equal((await c.get('/staff/audit.html')).status, 302);
    const cu = new H.Client(app.base); await cu.post('/api/customer/register', { name: '客', email: 'c2@x.example', password: 'Customer-Passphrase-1', consent: true });
    assert.equal((await cu.get('/api/staff/dashboard')).status, 401, 'customer session is not a staff session');
  } finally { await app.stop(); }
});
