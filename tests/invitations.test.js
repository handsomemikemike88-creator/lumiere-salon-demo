const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./helpers');
const tokenOf = inv => new URL(inv.link).searchParams.get('t');

test('invitation: single-use, hashed at rest, needs admin approval, role checks', async () => {
  const app = await H.makeApp(); try {
    const admin = await H.loginAdmin(app); const inv = await admin.post('/api/admin/invitations', { email: 'new@x.example' }); assert.equal(inv.status, 200);
    const tok = tokenOf(inv.json); const row = await app.ctx.db.one('select * from invitations'); assert.notEqual(row.token_hash, tok); assert.equal(JSON.stringify(row).includes(tok), false);
    assert.equal((await new H.Client(app.base).get('/api/invite/' + tok)).json.email, 'new@x.example');
    const c = new H.Client(app.base);
    assert.equal((await c.post('/api/staff/register', { token: tok, name: 'N', password: 'short' })).status, 400);
    const ok = await c.post('/api/staff/register', { token: tok, name: 'N', password: H.STAFF_PW }); assert.equal(ok.status, 200); assert.equal(ok.json.status, 'pending');
    assert.equal((await c.post('/api/staff/register', { token: tok, name: 'N2', password: H.STAFF_PW })).status, 404, 'single use');
    const l = await c.post('/api/staff/login', { email: 'new@x.example', password: H.STAFF_PW }); assert.equal(l.status, 403, 'pending account cannot log in'); assert.match(l.json.error, /批准|待/);
    const u = (await admin.get('/api/admin/staff')).json.users.find(x => x.email === 'new@x.example'); assert.equal(u.role, 'staff');
    await admin.post('/api/admin/staff/' + u.id + '/status', { status: 'active' }); assert.equal((await c.post('/api/staff/login', { email: 'new@x.example', password: H.STAFF_PW })).status, 200);
    // staff role cannot reach admin API or admin pages
    for (const p of ['/api/admin/invitations', '/api/admin/staff', '/api/admin/audit', '/api/admin/checklist', '/api/admin/settings', '/api/admin/suppression']) assert.equal((await c.get(p)).status, 403, p);
    assert.equal((await c.post('/api/admin/invitations', { email: 'x@y.example' })).status, 403); assert.equal((await c.post('/api/admin/staff/' + u.id + '/role', { role: 'admin' })).status, 403);
    assert.equal((await c.get('/staff/audit.html')).status, 302); assert.equal((await c.get('/staff/leads.html')).status, 200); assert.equal((await c.get('/api/staff/leads')).status, 200);
    assert.ok((await admin.get('/api/admin/audit')).json.entries.some(e => e.action === 'invitation.created'));
  } finally { await app.stop(); }
});
test('invitation: expiry, revoke, bad tokens', async () => {
  const app = await H.makeApp(); try {
    const admin = await H.loginAdmin(app); const c = new H.Client(app.base);
    const a = (await admin.post('/api/admin/invitations', { email: 'a@x.example' })).json; await app.ctx.db.q("update invitations set expires_at = now() - interval '1 minute'");
    assert.equal((await c.post('/api/staff/register', { token: tokenOf(a), name: 'A', password: H.STAFF_PW })).status, 404); assert.equal((await c.get('/api/invite/' + tokenOf(a))).status, 404);
    const b = (await admin.post('/api/admin/invitations', { email: 'b@x.example' })).json; assert.equal((await admin.post('/api/admin/invitations/' + b.invitation.id + '/revoke')).status, 200);
    assert.equal((await c.post('/api/staff/register', { token: tokenOf(b), name: 'B', password: H.STAFF_PW })).status, 404);
    assert.equal((await c.post('/api/staff/register', { token: 'x'.repeat(30), name: 'B', password: H.STAFF_PW })).status, 404);
    assert.equal((await admin.post('/api/admin/invitations', { email: 'not-an-email' })).status, 400);
  } finally { await app.stop(); }
});
test('admin safeguards: disabling a user kills sessions; cannot demote/disable the last admin', async () => {
  const app = await H.makeApp(); try {
    const admin = await H.loginAdmin(app); const s = await H.makeStaff(app, admin, 's@x.example'); assert.equal((await s.client.get('/api/staff/me')).status, 200);
    await admin.post('/api/admin/staff/' + s.id + '/status', { status: 'disabled' }); assert.equal((await s.client.get('/api/staff/me')).status, 401); assert.equal((await new H.Client(app.base).post('/api/staff/login', { email: 's@x.example', password: H.STAFF_PW })).status, 403);
    const me = (await admin.get('/api/staff/me')).json.user; assert.equal((await admin.post('/api/admin/staff/' + me.id + '/status', { status: 'disabled' })).status, 400);
    assert.equal((await admin.post('/api/admin/staff/' + me.id + '/role', { role: 'staff' })).status, 400); assert.equal((await admin.get('/api/staff/me')).status, 200);
  } finally { await app.stop(); }
});
test('session idle and absolute timeouts', async () => {
  const app = await H.makeApp(); try {
    const a = await H.loginAdmin(app); await app.ctx.db.q("update sessions set last_seen_at = now() - interval '3 hours'"); assert.equal((await a.get('/api/staff/me')).status, 401, 'idle > 2h');
    const b = await H.loginAdmin(app); await app.ctx.db.q("update sessions set expires_at = now() - interval '1 minute' where revoked_at is null"); assert.equal((await b.get('/api/staff/me')).status, 401, 'absolute expiry');
  } finally { await app.stop(); }
});
