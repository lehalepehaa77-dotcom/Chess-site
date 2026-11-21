const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET) console.warn('AUTH_SECRET is not set: all logins will reset on every restart');

function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, (e, key) => e ? reject(e) : resolve(salt.toString('hex') + ':' + key.toString('hex')));
  });
}
function verifyPassword(pw, stored) {
  return new Promise((resolve) => {
    const [s, h] = String(stored).split(':');
    if (!s || !h) return resolve(false);
    crypto.scrypt(pw, Buffer.from(s, 'hex'), 64, (e, key) => {
      if (e) return resolve(false);
      const a = Buffer.from(h, 'hex');
      resolve(a.length === key.length && crypto.timingSafeEqual(a, key));
    });
  });
}
function sign(data) { return crypto.createHmac('sha256', SECRET).update(data).digest('base64url'); }
function makeToken(payload, days = 30) {
  const body = Buffer.from(JSON.stringify(Object.assign({}, payload, { exp: Date.now() + days * 86400000 }))).toString('base64url');
  return body + '.' + sign(body);
}
function verifyToken(t) {
  try {
    const [body, sig] = String(t).split('.');
    if (!body || !sig) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}
function validate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return 'Введи имя и пароль';
  const u = username.trim();
  if (u.length < 3 || u.length > 20) return 'Имя: от 3 до 20 символов';
  if (!/^[A-Za-z0-9_\-А-Яа-яЁё]+$/.test(u)) return 'Имя может содержать буквы, цифры, _ и -';
  if (password.length < 6 || password.length > 72) return 'Пароль: от 6 до 72 символов';
  return null;
}
module.exports = { hashPassword, verifyPassword, makeToken, verifyToken, validate };
