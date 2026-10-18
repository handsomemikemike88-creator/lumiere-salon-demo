'use strict';
const S = require('./security'), E = require('./errors'), C = require('./constants');
const { bad, unauthorized, forbidden, conflict, tooMany, notFound, HttpError } = E;

module.exports = ctx => {
  const { db, cfg, log } = ctx; const audit = ctx.audit;
  const emailOk = v => typeof v === 'string' && v.length <= 120 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v.trim());
  const normEmail = v => String(v || '').trim().toLowerCase();
  const ttlMs = kind => (kind === 'staff' ? cfg.SESSION_TTL_HOURS_STAFF : cfg.SESSION_TTL_HOURS_CUSTOMER) * 3600e3;
  const idleMs = kind => (kind === 'staff' ? 2 : 24) * 3600e3;
  const table = kind => kind === 'staff' ? 'staff' : 'customers';

  // ---------------- sessions (hashed token stored in PostgreSQL) ----------------
  async function createSession(kind, userId, ipTag, client) {
    const token = S.newToken(32), exp = new Date(Date.now() + ttlMs(kind));
    await db.q('insert into sessions(token_hash, kind, user_id, expires_at, ip_tag) values ($1,$2,$3,$4,$5)', [S.sha256(token), kind, userId, exp, ipTag || null], client);
    return { token, maxAgeSec: Math.floor(ttlMs(kind) / 1000) };
  }
  async function getSession(kind, token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const row = await db.one('select * from sessions where token_hash = $1 and kind = $2 and revoked_at is null', [S.sha256(token), kind]);
    if (!row) return null; const now = Date.now();
    if (new Date(row.expires_at).getTime() < now || new Date(row.last_seen_at).getTime() < now - idleMs(kind)) { await db.q('update sessions set revoked_at = now() where id = $1', [row.id]); return null; }
    const user = await db.one(kind === 'staff' ? "select id, name, email, role, status from staff where id = $1 and status = 'active'" : 'select id, name, email, phone from customers where id = $1 and anonymised_at is null', [row.user_id]);
    if (!user) return null;
    if (new Date(row.last_seen_at).getTime() < now - 60000) await db.q('update sessions set last_seen_at = now() where id = $1', [row.id]);
    return { user, sessionId: row.id };
  }
  const revokeSession = async token => { if (token) await db.q('update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [S.sha256(token)]); };
  const revokeAll = (kind, userId, client) => db.q('update sessions set revoked_at = now() where kind = $1 and user_id = $2 and revoked_at is null', [kind, userId], client);
  const purgeSessions = () => db.q("delete from sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'");

  // ---------------- login with lockout/backoff ----------------
  async function login(kind, identifier, password, oldToken, ipTag) {
    let user;
    if (kind === 'staff') user = await db.one('select * from staff where email = $1', [normEmail(identifier)]);
    else {
      const id = normEmail(identifier); let ph = ''; try { ph = ctx.core.phone(id, false); } catch (e) { /* not a phone */ }
      user = await db.one('select * from customers where anonymised_at is null and ((email is not null and email = $1) or ($2 <> \'\' and phone = $2))', [id, ph]);
    }
    if (user && user.locked_until && new Date(user.locked_until) > new Date()) { await S.verifyPassword(password, await S.dummyHash()); throw tooMany('登入嘗試過多，帳戶暫時鎖定。請稍後再試，或使用「忘記密碼」。', Math.ceil((new Date(user.locked_until) - Date.now()) / 1000)); }
    const ok = user && user.pw_hash ? await S.verifyPassword(password, user.pw_hash) : (await S.verifyPassword(password, await S.dummyHash()), false);
    if (!ok) {
      if (user) {
        const n = user.failed_logins + 1; let lock = null;
        if (n >= cfg.LOCKOUT_THRESHOLD) lock = new Date(Date.now() + Math.min(60, Math.pow(2, n - cfg.LOCKOUT_THRESHOLD)) * 60e3);
        await db.q(`update ${table(kind)} set failed_logins = $2, locked_until = $3 where id = $1`, [user.id, n, lock]);
        await audit.log({ kind: 'system', ipTag }, kind + '.login_failed', { type: kind, id: user.id }, { attempts: n, locked: !!lock });
      }
      throw unauthorized(kind === 'staff' ? '電郵或密碼不正確' : '帳戶或密碼不正確');
    }
    if (kind === 'staff' && user.status !== 'active') throw forbidden(user.status === 'pending' ? '你的帳戶仍待管理員批准。' : '此帳戶已停用。');
    await db.q(`update ${table(kind)} set failed_logins = 0, locked_until = null${kind === 'staff' ? ', last_login_at = now()' : ''} where id = $1`, [user.id]);
    await revokeSession(oldToken);                                  // rotation: never reuse a pre-login token
    const s = await createSession(kind, user.id, ipTag);
    if (kind === 'staff') await audit.log({ kind: 'staff', id: user.id, name: user.name, ipTag }, 'staff.login', { type: 'staff', id: user.id });
    return { user, session: s };
  }

  async function changePassword(kind, user, current, next, keepToken) {
    const row = await db.one(`select pw_hash, email from ${table(kind)} where id = $1`, [user.id]);
    if (!(await S.verifyPassword(current, row.pw_hash))) throw unauthorized('目前密碼不正確');
    const why = S.passwordProblem(next, row.email); if (why) throw bad(why);
    const h = await S.hashPassword(next);
    await db.tx(async c => {
      await db.q(`update ${table(kind)} set pw_hash = $2, pw_changed_at = now(), failed_logins = 0, locked_until = null where id = $1`, [user.id, h], c);
      await revokeAll(kind, user.id, c);      // revoke ALL sessions on password change
      await audit.log({ kind, id: user.id, name: user.name }, kind + '.password_changed', { type: kind, id: user.id }, null, c);
    });
    return createSession(kind, user.id);     // fresh session for the current device
  }

  // ---------------- invitations (admin-created, single-use, expiring) + admin approval ----------------
  async function createInvitation(admin, email) {
    email = normEmail(email); if (!emailOk(email)) throw bad('電郵格式不正確');
    if (await db.one('select 1 from staff where email = $1', [email])) throw conflict('此電郵已有員工帳戶');
    const token = S.newToken(32), id = 'INV' + S.newToken(6).replace(/[-_]/g, 'x');
    const exp = new Date(Date.now() + cfg.INVITE_TTL_HOURS * 3600e3);
    await db.tx(async c => {
      await db.q('update invitations set revoked_at = now() where email = $1 and used_at is null and revoked_at is null', [email], c);
      await db.q('insert into invitations(id, email, token_hash, created_by, expires_at) values ($1,$2,$3,$4,$5)', [id, email, S.sha256(token), admin.id, exp], c);
      await audit.log({ kind: 'staff', id: admin.id, name: admin.name }, 'invitation.created', { type: 'invitation', id }, { role: 'staff' }, c);
    });
    const link = (cfg.PUBLIC_BASE_URL || 'http://localhost:' + cfg.PORT) + '/staff/register.html?t=' + token;
    return { id, email, expiresAt: exp, link };
  }
  const listInvitations = () => db.all("select id, email, role, created_by, created_at, expires_at, used_at, revoked_at, case when used_at is not null then 'used' when revoked_at is not null then 'revoked' when expires_at < now() then 'expired' else 'open' end as status from invitations order by created_at desc limit 200");
  async function revokeInvitation(admin, id) {
    const r = await db.q('update invitations set revoked_at = now() where id = $1 and used_at is null and revoked_at is null', [id]);
    if (!r.rowCount) throw notFound('找不到可撤銷的邀請'); await audit.log({ kind: 'staff', id: admin.id, name: admin.name }, 'invitation.revoked', { type: 'invitation', id });
  }
  async function inviteInfo(token) {
    const inv = await db.one('select email, expires_at, used_at, revoked_at from invitations where token_hash = $1', [S.sha256(String(token || ''))]);
    if (!inv || inv.used_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) throw notFound('邀請連結無效、已使用或已過期。請向管理員索取新邀請。');
    return { email: inv.email };
  }
  async function registerStaff(token, name, password, ipTag) {
    name = ctx.core.str(name, 60, '姓名', true);
    return db.tx(async c => {
      const inv = await db.one('select * from invitations where token_hash = $1 for update', [S.sha256(String(token || ''))], c);
      if (!inv || inv.used_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) throw notFound('邀請連結無效、已使用或已過期。');
      const why = S.passwordProblem(password, inv.email); if (why) throw bad(why);
      if (await db.one('select 1 from staff where email = $1', [inv.email], c)) throw conflict('此電郵已註冊');
      const u = await db.one("insert into staff(name, email, pw_hash, role, status, invited_by) values ($1,$2,$3,'staff','pending',$4) returning id, name, email, role, status", [name, inv.email, await S.hashPassword(password), inv.created_by], c);
      await db.q('update invitations set used_at = now(), used_by = $2 where id = $1', [inv.id, u.id], c);
      await audit.log({ kind: 'staff', id: u.id, name: u.name, ipTag }, 'staff.registered', { type: 'staff', id: u.id }, { invitation: inv.id, status: 'pending' }, c);
      return u;
    });
  }
  const listStaff = () => db.all('select id, name, email, role, status, last_login_at, created_at from staff order by created_at');
  async function setStaffStatus(admin, id, status) {
    if (!['active', 'disabled'].includes(status)) throw bad('狀態不正確');
    if (id === admin.id) throw bad('不能更改自己的狀態');
    return db.tx(async c => {
      const u = await db.one('select id, status, role from staff where id = $1 for update', [id], c); if (!u) throw notFound('找不到員工');
      if (status === 'disabled' && u.role === 'admin' && Number((await db.one("select count(*)::int n from staff where role = 'admin' and status = 'active'", [], c)).n) <= 1) throw bad('不能停用最後一位管理員');
      await db.q('update staff set status = $2 where id = $1', [id, status], c);
      if (status === 'disabled') await revokeAll('staff', id, c);
      await audit.log({ kind: 'staff', id: admin.id, name: admin.name }, status === 'active' ? 'staff.approved' : 'staff.disabled', { type: 'staff', id }, { from: u.status, to: status }, c);
    });
  }
  async function setStaffRole(admin, id, role) {
    if (!['admin', 'staff'].includes(role)) throw bad('角色不正確'); if (id === admin.id) throw bad('不能更改自己的角色');
    return db.tx(async c => {
      const u = await db.one('select id, role from staff where id = $1 for update', [id], c); if (!u) throw notFound('找不到員工');
      await db.q('update staff set role = $2 where id = $1', [id, role], c); await revokeAll('staff', id, c);
      await audit.log({ kind: 'staff', id: admin.id, name: admin.name }, 'staff.role_changed', { type: 'staff', id }, { from: u.role, to: role }, c);
    });
  }
  // first admin: env at boot or `npm run create-admin`. Never overwrites an existing account.
  async function createAdmin(email, password, name) {
    email = normEmail(email); if (!emailOk(email)) throw new Error('電郵格式不正確');
    const why = S.passwordProblem(password, email); if (why) throw new Error(why);
    const ex = await db.one('select id from staff where email = $1', [email]); if (ex) return { created: false, id: ex.id };
    const u = await db.one("insert into staff(name, email, pw_hash, role, status) values ($1,$2,$3,'admin','active') returning id", [name || '管理員', email, await S.hashPassword(password)]);
    await audit.log({ kind: 'system' }, 'staff.admin_created', { type: 'staff', id: u.id }); return { created: true, id: u.id };
  }
  async function bootstrapAdmin() {
    if (!cfg.ADMIN_EMAIL) return null;
    const n = await db.one("select count(*)::int n from staff where role = 'admin'"); if (n.n > 0) return { created: false };
    const r = await createAdmin(cfg.ADMIN_EMAIL, cfg.ADMIN_PASSWORD, cfg.ADMIN_NAME); log.info('first admin created from environment', { id: r.id }); return r;
  }

  // ---------------- customers ----------------
  async function registerCustomer(b, ipTag) {
    const name = ctx.core.str(b.name, 60, '稱呼', true), em = ctx.core.email(b.email, false), ph = ctx.core.phone(b.phone, false);
    if (!em && !ph) throw bad('請填寫電郵或電話其中一項'); if (b.consent !== true) throw bad('請剔選同意《收集個人資料聲明》');
    const why = S.passwordProblem(b.password, em); if (why) throw bad(why);
    if (await db.one('select 1 from customers where (email is not null and email = $1) or ($2 <> \'\' and phone = $2)', [em || null, ph])) throw conflict('此電郵或電話已註冊，請直接登入');
    const c = await db.one('insert into customers(name, email, phone, pw_hash, consent_at) values ($1,$2,$3,$4,now()) returning id, name, email, phone', [name, em || null, ph || null, await S.hashPassword(b.password)]);
    return { customer: c, session: await createSession('customer', c.id, ipTag) };
  }

  // ---------------- password reset (staff + customers) ----------------
  async function forgot(kind, identifier) {
    const user = kind === 'staff' ? await db.one("select id, name, email from staff where email = $1 and status <> 'disabled'", [normEmail(identifier)])
      : await db.one('select id, name, email from customers where anonymised_at is null and email = $1', [normEmail(identifier)]);
    if (!user || !user.email) return;                          // identical response either way (no enumeration)
    const token = S.newToken(32);
    await db.tx(async c => {
      await db.q('update password_resets set used_at = now() where kind = $1 and user_id = $2 and used_at is null', [kind, user.id], c);
      await db.q('insert into password_resets(kind, user_id, token_hash, expires_at) values ($1,$2,$3,$4)', [kind, user.id, S.sha256(token), new Date(Date.now() + cfg.RESET_TOKEN_TTL_MINUTES * 60e3)], c);
    });
    const link = (cfg.PUBLIC_BASE_URL || 'http://localhost:' + cfg.PORT) + '/reset.html?k=' + kind + '&t=' + token;
    const mail = { to: user.email, subject: '重設密碼', text: `你好，\n\n請於 ${cfg.RESET_TOKEN_TTL_MINUTES} 分鐘內開啟以下連結重設密碼：\n${link}\n\n如果不是你提出的要求，請忽略此電郵，你的密碼不會改變。` };
    if (ctx.providers.email) { try { await ctx.providers.email.send(mail); } catch (e) { log.error('reset email failed', { err: e.message }); } }
    else log.warn('NO EMAIL PROVIDER: password reset link written to server log ONLY (never returned to the browser)', { kind, link });
    return;
  }
  async function resetPassword(kind, token, password) {
    return db.tx(async c => {
      const r = await db.one('select * from password_resets where token_hash = $1 and kind = $2 for update', [S.sha256(String(token || '')), kind], c);
      if (!r || r.used_at || new Date(r.expires_at) < new Date()) throw bad('重設連結無效或已過期，請重新申請。');
      const u = await db.one(`select id, email, name from ${table(kind)} where id = $1`, [r.user_id], c); if (!u) throw bad('重設連結無效。');
      const why = S.passwordProblem(password, u.email); if (why) throw bad(why);
      await db.q(`update ${table(kind)} set pw_hash = $2, pw_changed_at = now(), failed_logins = 0, locked_until = null where id = $1`, [u.id, await S.hashPassword(password)], c);
      await db.q('update password_resets set used_at = now() where id = $1', [r.id], c);
      await revokeAll(kind, u.id, c);
      await audit.log({ kind: kind === 'staff' ? 'staff' : 'customer', id: u.id, name: u.name }, kind + '.password_reset', { type: kind, id: u.id }, null, c);
    });
  }
  return { createSession, getSession, revokeSession, revokeAll, purgeSessions, login, changePassword, createInvitation, listInvitations, revokeInvitation, inviteInfo, registerStaff, listStaff, setStaffStatus, setStaffRole, createAdmin, bootstrapAdmin, registerCustomer, forgot, resetPassword, emailOk, normEmail };
};
