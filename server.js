const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server);
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
    rooms.set(id, { game: new Chess(), pids: { w: null, b: null }, socks: { w: null, b: null }, last: null, result: null, touched: Date.now() });
  }
  const r = rooms.get(id);
  r.touched = Date.now();
  return r;
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
    seated: { w: !!r.pids.w, b: !!r.pids.b }
  };
}

function broadcast(roomId) {
  const r = rooms.get(roomId);
  if (r) io.to(roomId).emit('state', publicState(r));
}

io.on('connection', (socket) => {
  io.emit('online', io.engine.clientsCount);

  socket.on('find', ({ pid } = {}) => {
    pid = String(pid || '').slice(0, 64);
    if (!pid) return;
    removeFromQueue(socket);
    const i = queue.findIndex((q) => q.pid !== pid && q.socket.connected);
    if (i === -1) {
      queue.push({ socket, pid });
      socket.emit('waiting');
      return;
    }
    const other = queue.splice(i, 1)[0];
    const id = newRoomId();
    const r = getRoom(id);
    const whiteFirst = Math.random() < 0.5;
    r.pids.w = whiteFirst ? pid : other.pid;
    r.pids.b = whiteFirst ? other.pid : pid;
    socket.emit('matched', { room: id });
    other.socket.emit('matched', { room: id });
  });

  socket.on('cancel', () => removeFromQueue(socket));

  socket.on('join', ({ room, pid }) => {
    room = String(room || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    pid = String(pid || '').slice(0, 64);
    if (!room || !pid) return;
    const r = getRoom(room);
    let color;
    if (r.pids.w === pid) color = 'w';
    else if (r.pids.b === pid) color = 'b';
    else if (!r.pids.w) color = 'w';
    else if (!r.pids.b) color = 'b';
    else color = 's';
    if (color !== 's') { r.pids[color] = pid; r.socks[color] = socket.id; }
    socket.data = { room, color };
    socket.join(room);
    socket.emit('you', color);
    broadcast(room);
  });

  socket.on('move', ({ from, to }) => {
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
    broadcast(room);
  });

  socket.on('resign', () => {
    const { room, color } = socket.data || {};
    const r = rooms.get(room);
    if (!r || (color !== 'w' && color !== 'b') || resultOf(r)) return;
    r.result = (color === 'w' ? 'Белые сдались. Победили чёрные.' : 'Чёрные сдались. Победили белые.');
    broadcast(room);
  });

  socket.on('rematch', () => {
    const { room, color } = socket.data || {};
    const r = rooms.get(room);
    if (!r || (color !== 'w' && color !== 'b') || !resultOf(r)) return;
    r.game = new Chess();
    r.last = null;
    r.result = null;
    [r.pids.w, r.pids.b] = [r.pids.b, r.pids.w];
    [r.socks.w, r.socks.b] = [r.socks.b, r.socks.w];
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
