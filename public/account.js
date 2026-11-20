(function () {
  var TK = 'chessAuthToken', UK = 'chessAuthUser', timer = null;
  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) {}
    return null;
  }
  function jget(k, d) {
    try { return Object.assign({}, d, JSON.parse(ls(k) || '{}')); } catch (e) { return d; }
  }
  async function api(path, method, body) {
    var h = { 'Content-Type': 'application/json' };
    var t = ls(TK);
    if (t) h.Authorization = 'Bearer ' + t;
    var r = await fetch(path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    var j = {};
    try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data: j };
  }
  // серверные данные объединяются с локальными (побеждает тот, где больше решено пазлов)
  function applyServer(u) {
    var T = jget('chessTrainer', { rating: 800, solved: 0, streak: 0, lastDaily: 0, seen: [] });
    if (u.puzzleSolved >= (T.solved || 0)) {
      T.rating = u.puzzleRating; T.solved = u.puzzleSolved; T.streak = u.streak; T.lastDaily = u.lastDaily;
    }
    ls('chessTrainer', JSON.stringify(T));
    var L = jget('chessLessons', { done: {} });
    L.done = Object.assign({}, L.done || {}, u.lessons || {});
    ls('chessLessons', JSON.stringify(L));
  }
  function doPush() {
    var T = jget('chessTrainer', {}), L = jget('chessLessons', { done: {} });
    api('/api/progress', 'POST', {
      puzzleRating: T.rating, puzzleSolved: T.solved, streak: T.streak, lastDaily: T.lastDaily, lessons: L.done
    }).catch(function () {});
  }
  var A = {
    token: function () { return ls(TK) || ''; },
    user: function () { try { return JSON.parse(ls(UK) || 'null'); } catch (e) { return null; } },
    api: api,
    status: async function () {
      try { var r = await api('/api/status'); return !!(r.data && r.data.accounts); } catch (e) { return false; }
    },
    auth: async function (kind, username, password) {
      var r = await api('/api/' + kind, 'POST', { username: username, password: password });
      if (!r.ok) return { error: (r.data && r.data.error) || 'Ошибка. Попробуй ещё раз.' };
      ls(TK, r.data.token); ls(UK, JSON.stringify(r.data.user));
      applyServer(r.data.user);
      A.push(true);
      return { user: r.data.user };
    },
    logout: function () { ls(TK, null); ls(UK, null); },
    refresh: async function () {
      if (!A.token()) return null;
      var r = await api('/api/me');
      if (r.status === 401) { A.logout(); return null; }
      if (!r.ok) return A.user();
      ls(UK, JSON.stringify(r.data.user));
      return r.data.user;
    },
    push: function (now) {
      if (!A.token()) return;
      clearTimeout(timer);
      timer = setTimeout(doPush, now ? 0 : 1200);
    }
  };
  window.Account = A;
})();
