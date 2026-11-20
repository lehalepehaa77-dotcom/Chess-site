const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const auth = require('./auth');
const db = require('./db');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/* ===================== API: аккаунты ===================== */
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const k = key + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(k, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 3600 * 1000);

function needDb(req, res, next) {
  if (!db.enabled) return res.status(503).json({ error: 'Аккаунты пока не включены' });
  next();
}
function needAuth(req, res, next) {
  const p = auth.verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/, ''));
  if (!p) return res.status(401).json({ error: 'Нужно войти' });
  req.uid = Number(p.uid);
  next();
}
const fail = (res, e) => { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); };

app.get('/api/status', (req, res) => res.json({ accounts: db.enabled }));

app.post('/api/register', needDb, async (req, res) => {
  if (limited(req.ip, 'reg', 8, 3600 * 1000)) return res.status(429).json({ error: 'Слишком много попыток. Попробуй позже.' });
  const { username, password } = req.body || {};
  const err = auth.validate(username, password);
  if (err) return res.status(400).json({ error: err });
  try {
    const u = await db.createUser(username.trim(), await auth.hashPassword(password));
    res.json({ token: auth.makeToken({ uid: u.id, name: u.username }), user: db.publicUser(u) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Это имя уже занято' });
    fail(res, e);
  }
});

app.post('/api/login', needDb, async (req, res) => {
  if (limited(req.ip, 'login', 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'Слишком много попыток. Попробуй позже.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Введи имя и пароль' });
  try {
    const u = await db.findByName(username.trim());
    if (!u || !(await auth.verifyPassword(password, u.pass_hash))) return res.status(401).json({ error: 'Неверное имя или пароль' });
    res.json({ token: auth.makeToken({ uid: u.id, name: u.username }), user: db.publicUser(u) });
  } catch (e) { fail(res, e); }
});

app.get('/api/me', needDb, needAuth, async (req, res) => {
  try {
    const u = await db.findById(req.uid);
    if (!u) return res.status(401).json({ error: 'Нужно войти' });
    res.json({ user: db.publicUser(u) });
  } catch (e) { fail(res, e); }
});

app.post('/api/progress', needDb, needAuth, async (req, res) => {
  try {
    const u = await db.saveProgress(req.uid, req.body || {});
    res.json({ user: u ? db.publicUser(u) : null });
  } catch (e) { fail(res, e); }
});

app.get('/api/leaderboard', needDb, async (req, res) => {
  try { res.json({ rows: await db.leaderboard(req.query.type === 'puzzles' ? 'puzzles' : 'games') }); }
  catch (e) { fail(res, e); }
});

if (db.enabled) db.init().then(() => console.log('Database ready')).catch((e) => console.error('Database init failed', e));
else console.log('DATABASE_URL is not set: accounts and ratings are disabled');

/* ===================== Игра ===================== */
const rooms = new Map();
const queue = [];

function removeFromQueue(socket) {
  const i = queue.findIndex((q) => q.socket === socket);
  if (i !== -1) queue.splice(i, 1);
}
function newRoomId() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s;
  do {
    s = '';
    for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  } while (rooms.has(s));
  return s;
}
function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      game: new Chess(), pids: { w: null, b: null }, socks: { w: null, b: null }, users: { w: null, b: null },
      timers: { w: null, b: null }, last: null, result: null, outcome: null, rated: false, finalized: false, delta: null, touched: Date.now()
    });
  }
  const r = rooms.get(id);
  r.touched = Date.now();
  return r;
}
async function socketUser(token) {
  if (!db.enabled) return null;
  const p = auth.verifyToken(String(token || ''));
  return p ? { id: Number(p.uid), username: String(p.name || '') } : null;
}

function resultOf(r) {
  if (r.result) return r.result;
  const g = r.game;
  if (g.isCheckmate()) return 'Мат! Победили ' + (g.turn() === 'w' ? 'чёрные' : 'белые') + '.';
  if (g.isStalemate()) return 'Пат. Ничья.';
  if (g.isThreefoldRepetition()) return 'Ничья: троекратное повторение.';
  if (g.isInsufficientMaterial()) return 'Ничья: недостаточно материала.';
  if (g.isDraw()) return 'Ничья.';
  return null;
}
function outcomeOf(r) {
  if (r.outcome) return r.outcome;
  if (r.game.isCheckmate()) return r.game.turn() === 'w' ? 'b' : 'w';
  return resultOf(r) ? 'd' : null;
}
function publicState(r) {
  const res = resultOf(r);
  return {
    fen: r.game.fen(),
    history: r.game.history(),
    turn: r.game.turn(),
    over: !!res,
    result: res,
    last: r.last,
    online: { w: !!r.socks.w, b: !!r.socks.b },
    seated: { w: !!r.pids.w, b: !!r.pids.b },
    names: { w: r.users.w ? r.users.w.username : null, b: r.users.b ? r.users.b.username : null },
    rated: r.rated,
    delta: r.delta
  };
}
function broadcast(roomId) {
  const r = rooms.get(roomId);
  if (r) io.to(roomId).emit('state', publicState(r));
}
// после любого изменения: разослать состояние и, если рейтинговая партия закончилась, обновить рейтинги
function afterChange(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;
  broadcast(roomId);
  if (r.rated && !r.finalized && resultOf(r) && r.users.w && r.users.b) {
    r.finalized = true;
    const o = outcomeOf(r);
    const score = o === 'w' ? 1 : o === 'b' ? 0 : 0.5;
    db.applyGameResult(r.users.w.id, r.users.b.id, score)
      .then((d) => { r.delta = { w: d.dw, b: d.db }; broadcast(roomId); })
      .catch((e) => console.error('Rating update failed', e));
  }
}

io.on('connection', (socket) => {
  io.emit('online', io.engine.clientsCount);

  socket.on('find', async ({ pid, token } = {}) => {
    pid = String(pid || '').slice(0, 64);
    if (!pid) return;
    const user = await socketUser(token);
    removeFromQueue(socket);
    const i = queue.findIndex((q) => q.pid !== pid && q.socket.connected && !(user && q.user && q.user.id === user.id));
    if (i === -1) {
      queue.push({ socket, pid, user });
      socket.emit('waiting');
      return;
    }
    const other = queue.splice(i, 1)[0];
    const id = newRoomId();
    const r = getRoom(id);
    const whiteFirst = Math.random() < 0.5;
    r.pids.w = whiteFirst ? pid : other.pid;
    r.pids.b = whiteFirst ? other.pid : pid;
    r.users.w = whiteFirst ? user : other.user;
    r.users.b = whiteFirst ? other.user : user;
    r.rated = !!(user && other.user);
    socket.emit('matched', { room: id });
    other.socket.emit('matched', { room: id });
  });

  socket.on('cancel', () => removeFromQueue(socket));

  socket.on('join', async ({ room, pid, token } = {}) => {
    room = String(room || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    pid = String(pid || '').slice(0, 64);
    if (!room || !pid) return;
    const user = await socketUser(token);
    const r = getRoom(room);
    let color;
    if (r.pids.w === pid) color = 'w';
    else if (r.pids.b === pid) color = 'b';
    else if (!r.pids.w) color = 'w';
    else if (!r.pids.b) color = 'b';
    else color = 's';
    if (color !== 's') {
      r.pids[color] = pid;
      r.socks[color] = socket.id;
      if (user && !r.rated) r.users[color] = user;
      clearTimeout(r.timers[color]);
    }
    socket.data = { room, color };
    socket.join(room);
    socket.emit('you', color);
    broadcast(room);
  });

  socket.on('move', ({ from, to } = {}) => {
    const { room, color } = socket.data || {};
    const r = rooms.get(room);
    if (!r || (color !== 'w' && color !== 'b')) return;
    if (resultOf(r) || r.game.turn() !== color) return;
    if (typeof from !== 'string' || typeof to !== 'string') return;
    try {
      const m = r.game.move({ from, to, promotion: 'q' });
      r.last = { from: m.from, to: m.to };
    } catch (e) { return; }
    r.touched = Date.now();
    afterChange(room);
  });

  socket.on('resign', () => {
    const { room, color } = socket.data || {};
    const r = rooms.get(room);
    if (!r || (color !== 'w' && color !== 'b') || resultOf(r)) return;
    r.outcome = color === 'w' ? 'b' : 'w';
    r.result = color === 'w' ? 'Белые сдались. Победили чёрные.' : 'Чёрные сдались. Победили белые.';
    afterChange(room);
  });

  socket.on('rematch', () => {
    const { room, color } = socket.data || {};
    const r = rooms.get(room);
    if (!r || (color !== 'w' && color !== 'b') || !resultOf(r)) return;
    r.game = new Chess();
    r.last = null;
    r.result = null;
    r.outcome = null;
    r.finalized = false;
    r.delta = null;
    [r.pids.w, r.pids.b] = [r.pids.b, r.pids.w];
    [r.socks.w, r.socks.b] = [r.socks.b, r.socks.w];
    [r.users.w, r.users.b] = [r.users.b, r.users.w];
    for (const c of ['w', 'b']) {
      const s = r.socks[c] && io.sockets.sockets.get(r.socks[c]);
      if (s) { s.data.color = c; s.emit('you', c); }
    }
    broadcast(room);
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket);
    io.emit('online', io.engine.clientsCount);
    const { room, color } = socket.data || {};
    const r = rooms.get(room);
    if (r && (color === 'w' || color === 'b') && r.socks[color] === socket.id) {
      r.socks[color] = null;
      // в рейтинговой партии игрок, не вернувшийся за 60 секунд, проигрывает
      if (r.rated && !resultOf(r)) {
        clearTimeout(r.timers[color]);
        r.timers[color] = setTimeout(() => {
          const rr = rooms.get(room);
          if (!rr || resultOf(rr) || rr.socks[color]) return;
          rr.outcome = color === 'w' ? 'b' : 'w';
          rr.result = (color === 'w' ? 'Белые' : 'Чёрные') + ' покинули партию. Победили ' + (color === 'w' ? 'чёрные' : 'белые') + '.';
          afterChange(room);
        }, 60 * 1000);
      }
      broadcast(room);
    }
  });
});

setInterval(() => {
  const limit = Date.now() - 12 * 3600 * 1000;
  for (const [id, r] of rooms) if (r.touched < limit) rooms.delete(id);
}, 3600 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Chess server on port ' + PORT));
