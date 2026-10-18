'use strict';
class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
const bad = m => new HttpError(400, m), unauthorized = m => new HttpError(401, m || '請先登入'), forbidden = m => new HttpError(403, m || '沒有權限'), notFound = m => new HttpError(404, m || '找不到記錄'), conflict = m => new HttpError(409, m), tooMany = (m, s) => new HttpError(429, m, { retryAfter: s });
module.exports = { HttpError, bad, unauthorized, forbidden, notFound, conflict, tooMany };
