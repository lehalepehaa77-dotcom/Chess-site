const { eloUpdate } = require('./elo');
const enabled = !!process.env.DATABASE_URL;
const { Pool } = enabled ? require('pg') : {};
const pool = enabled ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 }) : null;

async function init() {
  if (!enabled) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    rating INT NOT NULL DEFAULT 1200,
    games INT NOT NULL DEFAULT 0,
    wins INT NOT NULL DEFAULT 0,
    losses INT NOT NULL DEFAULT 0,
    draws INT NOT NULL DEFAULT 0,
    puzzle_rating INT NOT NULL DEFAULT 800,
    puzzle_solved INT NOT NULL DEFAULT 0,
    streak INT NOT NULL DEFAULT 0,
    last_daily INT NOT NULL DEFAULT 0,
    lessons JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_lower_idx ON users (lower(username))');
  await pool.query(`CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    white_id INT, black_id INT,
    white_name TEXT NOT NULL, black_name TEXT NOT NULL,
    result TEXT NOT NULL, reason TEXT NOT NULL, moves TEXT NOT NULL,
    tc TEXT NOT NULL, rated BOOLEAN NOT NULL DEFAULT false,
    delta_w INT, delta_b INT, rating_w INT, rating_b INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS games_white_idx ON games (white_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS games_black_idx ON games (black_id)');
}
function publicUser(u) {
  return {
    id: u.id, username: u.username, rating: u.rating, games: u.games, wins: u.wins, losses: u.losses, draws: u.draws,
    puzzleRating: u.puzzle_rating, puzzleSolved: u.puzzle_solved, streak: u.streak, lastDaily: u.last_daily, lessons: u.lessons || {}
  };
}
async function createUser(username, hash) {
  const { rows } = await pool.query('INSERT INTO users (username, pass_hash) VALUES ($1,$2) RETURNING *', [username, hash]);
  return rows[0];
}
async function findByName(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  return rows[0] || null;
}
async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}
const clampInt = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
async function saveProgress(uid, p) {
  const lessons = {};
  if (p.lessons && typeof p.lessons === 'object') {
    for (const k of Object.keys(p.lessons).slice(0, 40)) if (/^[a-z0-9_-]{1,20}$/.test(k) && p.lessons[k]) lessons[k] = true;
  }
  const { rows } = await pool.query(`UPDATE users SET
      puzzle_rating = CASE WHEN $2 >= puzzle_solved THEN $1 ELSE puzzle_rating END,
      streak = CASE WHEN $2 >= puzzle_solved THEN $3 ELSE streak END,
      last_daily = CASE WHEN $2 >= puzzle_solved THEN $4 ELSE last_daily END,
      puzzle_solved = GREATEST(puzzle_solved, $2),
      lessons = lessons || $5::jsonb
    WHERE id = $6 RETURNING *`,
    [clampInt(p.puzzleRating, 100, 3000), clampInt(p.puzzleSolved, 0, 100000), clampInt(p.streak, 0, 100000),
     clampInt(p.lastDaily, 0, 1000000), JSON.stringify(lessons), uid]);
  return rows[0] || null;
}
async function leaderboard(type) {
  const q = type === 'puzzles'
    ? 'SELECT username, puzzle_rating AS rating, puzzle_solved AS games FROM users WHERE puzzle_solved > 0 ORDER BY puzzle_rating DESC, puzzle_solved DESC LIMIT 50'
    : 'SELECT username, rating, games FROM users WHERE games > 0 ORDER BY rating DESC, games DESC LIMIT 50';
  const { rows } = await pool.query(q);
  return rows;
}
// score: 1 = white won, 0 = black won, 0.5 = draw
async function applyGameResult(wid, bid, score) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT id, rating, games FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [[wid, bid]]);
    const W = rows.find((r) => r.id === wid), B = rows.find((r) => r.id === bid);
    if (!W || !B) throw new Error('user not found');
    const { dw, db } = eloUpdate(W.rating, B.rating, score, W.games, B.games);
    const upd = 'UPDATE users SET rating = GREATEST(100, rating + $1), games = games + 1, wins = wins + $2, losses = losses + $3, draws = draws + $4 WHERE id = $5 RETURNING rating';
    const uw = await c.query(upd, [dw, score === 1 ? 1 : 0, score === 0 ? 1 : 0, score === 0.5 ? 1 : 0, wid]);
    const ub = await c.query(upd, [db, score === 0 ? 1 : 0, score === 1 ? 1 : 0, score === 0.5 ? 1 : 0, bid]);
    await c.query('COMMIT');
    return { dw, db, rw: uw.rows[0].rating, rb: ub.rows[0].rating };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}
async function saveGame(g) {
  await pool.query(
    `INSERT INTO games (white_id, black_id, white_name, black_name, result, reason, moves, tc, rated, delta_w, delta_b, rating_w, rating_b)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [g.whiteId, g.blackId, g.whiteName, g.blackName, g.result, g.reason, g.moves, g.tc, g.rated, g.deltaW, g.deltaB, g.ratingW, g.ratingB]);
}
function gameRow(r) {
  return {
    id: r.id, whiteName: r.white_name, blackName: r.black_name, result: r.result, reason: r.reason, tc: r.tc, rated: r.rated,
    deltaW: r.delta_w, deltaB: r.delta_b, createdAt: r.created_at
  };
}
async function getProfile(name) {
  const u = await findByName(name);
  if (!u) return null;
  const { rows } = await pool.query(
    `SELECT id, white_name, black_name, result, reason, tc, rated, delta_w, delta_b, created_at
     FROM games WHERE white_id = $1 OR black_id = $1 ORDER BY id DESC LIMIT 20`, [u.id]);
  const hist = await pool.query(
    `SELECT CASE WHEN white_id = $1 THEN rating_w ELSE rating_b END AS r
     FROM games WHERE (white_id = $1 OR black_id = $1) AND rated AND rating_w IS NOT NULL ORDER BY id DESC LIMIT 60`, [u.id]);
  return {
    user: {
      username: u.username, rating: u.rating, games: u.games, wins: u.wins, losses: u.losses, draws: u.draws,
      puzzleRating: u.puzzle_rating, puzzleSolved: u.puzzle_solved, streak: u.streak, lessonsDone: Object.keys(u.lessons || {}).length,
      createdAt: u.created_at
    },
    games: rows.map(gameRow),
    ratingHistory: hist.rows.map((x) => x.r).reverse()
  };
}
async function getGame(id) {
  const { rows } = await pool.query('SELECT * FROM games WHERE id = $1', [id]);
  if (!rows[0]) return null;
  return Object.assign(gameRow(rows[0]), { moves: rows[0].moves.split(' ').filter(Boolean) });
}
module.exports = { saveGame, getProfile, getGame, enabled, init, publicUser, createUser, findByName, findById, saveProgress, leaderboard, applyGameResult };
