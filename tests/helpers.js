'use strict';
const crypto = require('crypto'), http = require('http');
const { Client: PgClient } = require('pg');
const env = require('../lib/env'), { createApp } = require('../lib/app'), logger = require('../lib/logger');
const ADMIN = { email: 'admin@test.example', password: 'Correct-Horse-Battery-9' };
const STAFF_PW = 'Another-Strong-Pass-42';

async function createDatabase() {
  const admin = new PgClient({ connectionString: process.env.TEST_PG_ADMIN_URL }); await admin.connect();
  const name = 't_' + crypto.randomBytes(6).toString('hex'); await admin.query('create database ' + name); await admin.end();
  const u = new URL(process.env.TEST_PG_ADMIN_URL); u.pathname = '/' + name; return u.toString();
}
function baseEnv(url, extra) {
  return { NODE_ENV: 'test', DATABASE_URL: url, APP_SECRET: 'x'.repeat(40), PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ...extra };
}
async function makeApp(envExtra, overrides) {
  const url = (overrides && overrides.dbUrl) || await createDatabase();
  const cfg = env.load(baseEnv(url, envExtra)); const logs = [];
  const app = await createApp(cfg, { log: logger.create('debug', l => logs.push(l)), ...(overrides || {}) });
  await app.start(); app.logs = logs; app.dbUrl = url; app.base = app.url(); return app;
}
class Client {
  constructor(base, origin) { this.base = base; this.origin = origin || base; this.jar = {}; this.last = null; }
  async req(method, path, body, o) {
    o = o || {}; const headers = { ...(o.headers || {}) }; if (!o.noOrigin) headers.Origin = o.origin || this.origin;
    if (body !== undefined && !o.raw) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    const ck = Object.entries(this.jar).map(([k, v]) => k + '=' + v).join('; '); if (ck) headers.Cookie = ck;
    const r = await fetch(this.base + path, { method, headers, body: o.raw ? body : body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach(sc => { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0/i.test(sc) || v === '') delete this.jar[k]; else this.jar[k] = v; });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* html */ }
    this.last = { status: r.status, headers: r.headers, json, text }; return this.last;
  }
  get(p, o) { return this.req('GET', p, undefined, o); } post(p, b, o) { return this.req('POST', p, b === undefined ? {} : b, o); }
}
async function loginAdmin(app) { const c = new Client(app.base); const r = await c.post('/api/staff/login', ADMIN); if (r.status !== 200) throw new Error('admin login failed ' + JSON.stringify(r.json)); return c; }
// create an active staff member through the real invitation + approval flow
async function makeStaff(app, admin, email, name) {
  const inv = (await admin.post('/api/admin/invitations', { email })).json; const token = new URL(inv.link).searchParams.get('t');
  const c = new Client(app.base); const rr = await c.post('/api/staff/register', { token, name: name || 'Staff', password: STAFF_PW }); if (rr.status !== 200) throw new Error(JSON.stringify(rr.json));
  const list = (await admin.get('/api/admin/staff')).json.users; const u = list.find(x => x.email === email);
  await admin.post('/api/admin/staff/' + u.id + '/status', { status: 'active' });
  const l = await c.post('/api/staff/login', { email, password: STAFF_PW }); if (l.status !== 200) throw new Error('staff login ' + JSON.stringify(l.json)); return { client: c, id: u.id };
}
function futureWeekday(minDays) { // a non-Sunday date >= minDays ahead (HK date)
  const core = require('../lib/core').helpers; let d = core.addDays(core.todayStr(), minDays); while (core.dow(d) === 0) d = core.addDays(d, 1); return d;
}
// fake Stripe API server (stands in for api.stripe.com)
function fakeStripe() {
  const state = { sessions: {}, calls: [], n: 0, live: false };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      state.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b });
      const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        const p = new URLSearchParams(b); const id = (state.live ? 'cs_live_' : 'cs_test_') + 'fake' + (++state.n);
        const s = { id, object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', status: 'open', amount_total: Number(p.get('line_items[0][price_data][unit_amount]')), currency: p.get('line_items[0][price_data][currency]'), livemode: state.live, client_reference_id: p.get('client_reference_id'), metadata: { lead_id: p.get('metadata[lead_id]'), booking_id: p.get('metadata[booking_id]') }, url: 'https://checkout.stripe.com/c/pay/' + id, expires_at: Math.floor(Date.now() / 1000) + 86400, payment_intent: null, _params: Object.fromEntries(p) };
        state.sessions[id] = s; return send(200, s);
      }
      let m = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(req.url);
      if (m) { const s = state.sessions[m[1]]; if (!s) return send(404, { error: { message: 'No such session' } }); if (m[2]) { s.status = 'expired'; return send(200, s); } return send(200, s); }
      send(404, { error: { message: 'not found' } });
    });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, state, url: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise(r => srv.close(r)) })));
}
function signedWebhook(ev, secret) { const raw = JSON.stringify(ev); return { raw, sig: require('../lib/stripe').signPayload(raw, secret) }; }
module.exports = { ADMIN, STAFF_PW, createDatabase, baseEnv, makeApp, Client, loginAdmin, makeStaff, futureWeekday, fakeStripe, signedWebhook, PgClient };
