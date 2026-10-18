'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const E = require('./errors'), pages = require('./pages'); const { HttpError, bad, notFound } = E;
const PUB = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp' };
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;

function secHeaders(cfg) {
  const h = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin'
  };
  if (cfg.prod) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}
function cookiesOf(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function cookieHeader(cfg, name, val, maxAge) { return `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (cfg.prod ? '; Secure' : ''); }

function readBody(req, max) {
  return new Promise((ok, no) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > max) { no(new HttpError(413, '資料過大')); req.destroy(); } else ch.push(c); });
    req.on('end', () => ok(Buffer.concat(ch))); req.on('error', no);
  });
}
const parseJson = buf => { if (!buf.length) return {}; try { const j = JSON.parse(buf.toString('utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { throw bad('資料格式不正確'); } };

// Strict Origin check for mutating requests (CSRF defence, on top of SameSite=Strict cookies and JSON-only bodies).
function checkOrigin(req, cfg) {
  const o = req.headers.origin || (req.headers.referer ? (() => { try { return new URL(req.headers.referer).origin; } catch (e) { return ''; } })() : '');
  if (!o) throw new HttpError(403, '來源不被接受（缺少 Origin）');
  let host; try { host = new URL(o).host; } catch (e) { throw new HttpError(403, '來源不被接受'); }
  const allowed = cfg.ORIGIN ? new URL(cfg.ORIGIN).host === host : host === req.headers.host;
  if (!allowed) throw new HttpError(403, '來源不被接受');
  const sfs = req.headers['sec-fetch-site']; if (sfs && !['same-origin', 'same-site', 'none'].includes(sfs)) throw new HttpError(403, '來源不被接受');
}

function createStatic(cfg, hooks) {
  const cache = new Map();   // file -> {buf, gz, etag, type}
  function resolve(p) {
    if (p.endsWith('/')) p += 'index.html';
    const f = path.normalize(path.join(PUB, p)); if (!f.startsWith(PUB + path.sep)) return null;
    return f;
  }
  function load(f, flags) {
    const key = f + (flags ? JSON.stringify(flags) : ''); if (cache.has(key) && !flags) return cache.get(key);
    let buf; try { buf = fs.readFileSync(f); } catch (e) { return null; } const ext = path.extname(f), type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html') buf = Buffer.from(pages.transform(buf.toString('utf8'), cfg, flags), 'utf8');
    const e = { buf, type, etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"', gz: COMPRESSIBLE.test(type) && buf.length > 512 ? zlib.gzipSync(buf) : null };
    if (!flags) cache.set(key, e); return e;
  }
  return async function serve(req, res, url, sec, staffUser) {
    let p; try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
    if (p.includes('\0') || p.includes('..')) { res.writeHead(400); return res.end(); }
    const f = resolve(p); if (!f) { res.writeHead(403); return res.end(); }
    if (path.basename(f).startsWith('.')) { res.writeHead(404); return res.end(); }
    const rel = '/' + path.relative(PUB, f).split(path.sep).join('/');
    if (!cfg.SITE_DEMO_MODE && rel === '/team.html') { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end('Not found'); }   // sample practitioner profiles are fictional: demo only
    if (rel.startsWith('/staff/') && !rel.startsWith('/staff/assets/') && !['/staff/login.html', '/staff/register.html', '/staff/forgot.html'].includes(rel)) {
      if (!staffUser) { res.writeHead(302, { Location: '/staff/login.html', 'Cache-Control': 'no-store' }); return res.end(); }
      if (hooks.adminOnly.includes(rel) && staffUser.role !== 'admin') { res.writeHead(302, { Location: '/staff/index.html' }); return res.end(); }
    }
    let flags = null; if (hooks.dynamicFlags && /^\/(privacy|terms)\.html$/.test(rel)) flags = await hooks.dynamicFlags(rel);
    const e = load(f, flags);
    if (!e) { const nf = Buffer.from('404 找不到頁面'); res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...sec }); return res.end(nf); }
    const isHtml = e.type.startsWith('text/html'), isImg = e.type.startsWith('image/');
    const headers = { 'Content-Type': e.type, ETag: e.etag, Vary: 'Accept-Encoding', ...sec };
    headers['Cache-Control'] = rel.startsWith('/staff/') ? 'no-store' : isHtml ? 'no-cache' : isImg ? 'public, max-age=604800' : 'public, max-age=3600';
    if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, headers); return res.end(); }
    const useGz = e.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (useGz) headers['Content-Encoding'] = 'gzip';
    const body = useGz ? e.gz : e.buf; headers['Content-Length'] = body.length;
    res.writeHead(200, headers); if (req.method === 'HEAD') return res.end(); res.end(body);
  };
}
function sendJson(req, res, sec, code, obj, extra) {
  const raw = Buffer.from(JSON.stringify(obj)); const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...sec, ...(extra || {}) };
  if (raw.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; const gz = zlib.gzipSync(raw); h['Content-Length'] = gz.length; res.writeHead(code, h); return res.end(gz); }
  h['Content-Length'] = raw.length; res.writeHead(code, h); res.end(raw);
}
module.exports = { secHeaders, cookiesOf, cookieHeader, readBody, parseJson, checkOrigin, createStatic, sendJson };
