'use strict';
// Audit log of staff actions. `detail` must not contain PII (ids, stages, statuses only).
module.exports = ctx => {
  async function log(actor, action, target, detail, client) {
    actor = actor || { kind: 'system' };
    try {
      await ctx.db.q('insert into audit_log(actor_kind, actor_id, actor_name, action, target_type, target_id, detail, ip_tag) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [actor.kind || 'staff', actor.id || null, actor.name || null, action, target && target.type || null, target && target.id || null, detail ? JSON.stringify(detail) : null, actor.ipTag || null], client);
    } catch (e) { if (client) throw e; ctx.log.error('audit write failed', { action, err: e.message }); }
  }
  const list = (limit, offset, action) => ctx.db.all(`select id, at, actor_kind, actor_id, actor_name, action, target_type, target_id, detail from audit_log ${action ? 'where action = $3' : ''} order by id desc limit $1 offset $2`, action ? [limit, offset, action] : [limit, offset]);
  return { log, list };
};
