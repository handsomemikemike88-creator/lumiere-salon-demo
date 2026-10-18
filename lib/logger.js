'use strict';
// Structured JSON logs. No PII or secrets: sensitive keys are dropped, IPs are hashed by callers (see security.ipTag).
const crypto = require('crypto');
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SENSITIVE = /(pass|secret|token|authorization|cookie|key|email|phone|name|address|body|text|note|hkid)/i;
const SECRET_RE = /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9_*]+|\bwhsec_[A-Za-z0-9_*]+|SG\.[A-Za-z0-9_.-]{10,}|EAA[A-Za-z0-9]{20,}/g;
function clean(v, depth) {
  if (v == null) return v;
  if (typeof v === 'string') return v.replace(SECRET_RE, '[redacted]').slice(0, 500);
  if (typeof v !== 'object') return v;
  if (v instanceof Error) return clean(v.message, depth);
  if (depth > 3) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 20).map(x => clean(x, depth + 1));
  const o = {}; Object.keys(v).forEach(k => { o[k] = SENSITIVE.test(k) && !/^(keyId|requestId)$/.test(k) ? '[omitted]' : clean(v[k], depth + 1); }); return o;
}
function create(level, sink) {
  const min = LEVELS[level] || LEVELS.info; sink = sink || (l => process.stdout.write(l + '\n'));
  const emit = (lv, msg, f) => { if (LEVELS[lv] < min) return; sink(JSON.stringify({ ts: new Date().toISOString(), level: lv, msg: clean(String(msg), 0), ...clean(f || {}, 0) })); };
  return { debug: (m, f) => emit('debug', m, f), info: (m, f) => emit('info', m, f), warn: (m, f) => emit('warn', m, f), error: (m, f) => emit('error', m, f) };
}
module.exports = { create, clean };
