'use strict';
// Pluggable delivery providers. Each returns { id } on success or throws. Nothing here runs unless configured AND enabled.
function parseFrom(from) { const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || ''); return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { name: '', email: String(from || '').trim() }; }
const redactErr = s => String(s || '').replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]').replace(/SG\.[A-Za-z0-9_.-]+/g, '[redacted]').slice(0, 300);

function smtp(cfg) {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: cfg.SMTP.host, port: cfg.SMTP.port, secure: cfg.SMTP.secure, auth: cfg.SMTP.user ? { user: cfg.SMTP.user, pass: cfg.SMTP.pass } : undefined, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
  return { name: 'smtp', async send(m) { const r = await t.sendMail({ from: cfg.EMAIL_FROM, to: m.to, subject: m.subject, text: m.text, headers: m.unsubscribeUrl ? { 'List-Unsubscribe': '<' + m.unsubscribeUrl + '>' } : undefined }); return { id: r.messageId }; } };
}
function sendgrid(cfg) {
  return { name: 'sendgrid', async send(m) {
    const from = parseFrom(cfg.EMAIL_FROM);
    const body = { personalizations: [{ to: [{ email: m.to }] }], from: from.name ? from : { email: from.email }, subject: m.subject, content: [{ type: 'text/plain', value: m.text }] };
    if (m.unsubscribeUrl) body.headers = { 'List-Unsubscribe': '<' + m.unsubscribeUrl + '>' };
    const r = await fetch(cfg.SENDGRID_API_BASE.replace(/\/+$/, '') + '/v3/mail/send', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.SENDGRID_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('SendGrid HTTP ' + r.status + ' ' + redactErr(await r.text()));
    return { id: r.headers.get('x-message-id') || null };
  } };
}
// Official WhatsApp Business Cloud API, approved TEMPLATE messages only (no free-form text).
function whatsapp(cfg) {
  const W = cfg.WHATSAPP;
  return { name: 'whatsapp-cloud', async sendTemplate(m) {   // m: {to (digits), template, lang, params:[...]}
    const body = { messaging_product: 'whatsapp', to: m.to, type: 'template', template: { name: m.template, language: { code: m.lang || W.lang }, components: [{ type: 'body', parameters: m.params.map(t => ({ type: 'text', text: String(t) })) }] } };
    const r = await fetch(`${W.apiBase.replace(/\/+$/, '')}/${W.apiVersion}/${W.phoneNumberId}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + W.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch (e) { /* non-JSON */ }
    if (!r.ok) throw new Error('WhatsApp HTTP ' + r.status + ' ' + redactErr((j.error && j.error.message) || text));
    return { id: j.messages && j.messages[0] && j.messages[0].id || null };
  } };
}
function create(cfg) {
  const email = cfg.EMAIL_PROVIDER === 'smtp' ? smtp(cfg) : cfg.EMAIL_PROVIDER === 'sendgrid' ? sendgrid(cfg) : null;
  const wa = (cfg.WHATSAPP.phoneNumberId && cfg.WHATSAPP.token) ? whatsapp(cfg) : null;
  return { email, whatsapp: wa };
}
module.exports = { create, parseFrom };
