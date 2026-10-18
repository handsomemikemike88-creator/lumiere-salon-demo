'use strict';
// npm run check:content -> scans public copy for banned words, disallowed prices and committed secrets. Exit 1 on any hit.
const fs = require('fs'), path = require('path'); const C = require('../lib/constants');
const root = path.join(__dirname, '..'); const hits = [];
function walk(d, out) { for (const f of fs.readdirSync(d)) { if (['node_modules', '.git', 'backups'].includes(f)) continue; const p = path.join(d, f), s = fs.statSync(p); if (s.isDirectory()) walk(p, out); else out.push(p); } return out; }
const files = walk(root, []);
const copy = files.filter(f => /public[\/\\].*\.(html|js|css)$/.test(f) || /lib[\/\\]core\.js$/.test(f));
for (const f of copy) {
  const t = fs.readFileSync(f, 'utf8');
  for (const w of C.BANNED_WORDS) if (t.includes(w)) hits.push(`${path.relative(root, f)}: banned word "${w}"`);
  const priceRe = /HK\$\s?([\d,]+)/g; let m;
  while ((m = priceRe.exec(t))) { const n = Number(m[1].replace(/,/g, '')); if (!C.ALLOWED_PRICES.includes(n)) hits.push(`${path.relative(root, f)}: disallowed price HK$${m[1]}`); }
}
const secretRe = [/sk_live_[A-Za-z0-9]{8,}/, /sk_test_[A-Za-z0-9]{16,}/, /whsec_[A-Za-z0-9]{16,}/, /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /LUMIERE-DEMO/, /Admin#12345|Staff#12345|Customer#12345/];
for (const f of files.filter(f => !/package-lock|\.(jpg|png|zip)$/.test(f) && !/tests[\/\\]/.test(f) && !/check-content/.test(f))) {
  const t = fs.readFileSync(f, 'utf8'); for (const re of secretRe) if (re.test(t) && !/\.env\.example$/.test(f)) hits.push(`${path.relative(root, f)}: matches secret/demo-credential pattern ${re}`);
}
if (fs.existsSync(path.join(root, '.env'))) hits.push('.env exists in project folder (must not be shipped)');
if (hits.length) { console.error('內容檢查失敗：\n - ' + hits.join('\n - ')); process.exit(1); }
console.log(`內容檢查通過：掃描 ${files.length} 個檔案，沒有禁用字詞、非指定價錢或金鑰／示範密碼。`);
