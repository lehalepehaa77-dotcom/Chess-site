function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function kFactor(games) { return games < 20 ? 40 : 24; }
// scoreW: 1 = white won, 0 = black won, 0.5 = draw
function eloUpdate(rw, rb, scoreW, gamesW, gamesB) {
  const ew = expected(rw, rb);
  const dw = Math.round(kFactor(gamesW) * (scoreW - ew));
  const db = Math.round(kFactor(gamesB) * ((1 - scoreW) - (1 - ew)));
  return { dw, db };
}
module.exports = { expected, eloUpdate };
