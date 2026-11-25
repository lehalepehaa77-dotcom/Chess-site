(function () {
  var root = document.documentElement;
  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  /* ---- цвет доски и тема ---- */
  var BOARDS = { green: ['#eeeed2', '#769656'], brown: ['#f0d9b5', '#b58863'], blue: ['#dee3e6', '#8ca2ad'] };
  var ORDER = ['green', 'brown', 'blue'];
  function applyBoard(name) {
    var b = BOARDS[name] || BOARDS.green;
    root.style.setProperty('--sq-l', b[0]);
    root.style.setProperty('--sq-d', b[1]);
  }
  function applyTheme(t) { if (t === 'dark' || t === 'light') root.setAttribute('data-theme', t); }
  var board = ls('chessBoard') || 'green';
  applyBoard(board);
  applyTheme(ls('chessTheme'));
  var soundOn = ls('chessSound') !== 'off';

  /* ---- звук хода ---- */
  var AC = window.AudioContext || window.webkitAudioContext, ctx = null;
  window.Sound = {
    move: function () {
      if (!soundOn || !AC) return;
      try {
        ctx = ctx || new AC();
        if (ctx.state === 'suspended') ctx.resume();
        var t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(240, t);
        o.frequency.exponentialRampToValueAtTime(110, t + 0.08);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.28, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.14);
      } catch (e) {}
    }
  };

  /* ---- верхняя панель ---- */
  function build() {
    if (document.querySelector('nav.site')) return;
    var path = location.pathname;
    var items = [['/', 'Играть'], ['/puzzles.html', 'Пазлы'], ['/lessons.html', 'Уроки'], ['/analyze.html', 'Анализ'], ['/leaders.html', 'Лидеры']];
    var user = null;
    try { user = JSON.parse(ls('chessAuthUser') || 'null'); } catch (e) {}
    var nav = document.createElement('nav');
    nav.className = 'site';
    var links = items.map(function (x) {
      var on = (x[0] === '/' ? (path === '/' || path === '/index.html') : path === x[0]);
      return '<a href="' + x[0] + '"' + (on ? ' class="on"' : '') + '>' + x[1] + '</a>';
    }).join('');
    var name = user && user.username ? String(user.username).replace(/[<>&"']/g, '') : '';
    var userLink = name
      ? '<a href="/profile.html?u=' + encodeURIComponent(name) + '">👤 ' + name + '</a>'
      : '<a href="/">Войти</a>';
    nav.innerHTML = '<a class="brand" href="/">♞ Шахматы</a><div class="links">' + links + '</div>' +
      '<div class="tools"><button id="nvBoard" title="Цвет доски">🎨</button>' +
      '<button id="nvSound" title="Звук">' + (soundOn ? '🔊' : '🔇') + '</button>' +
      '<button id="nvTheme" title="Светлая или тёмная тема">🌓</button>' + userLink + '</div>';
    document.body.insertBefore(nav, document.body.firstChild);
    document.getElementById('nvBoard').onclick = function () {
      board = ORDER[(ORDER.indexOf(board) + 1) % ORDER.length];
      ls('chessBoard', board); applyBoard(board);
    };
    document.getElementById('nvSound').onclick = function () {
      soundOn = !soundOn; ls('chessSound', soundOn ? 'on' : 'off');
      this.textContent = soundOn ? '🔊' : '🔇';
      if (soundOn) window.Sound.move();
    };
    document.getElementById('nvTheme').onclick = function () {
      var cur = root.getAttribute('data-theme');
      var dark = cur ? cur === 'dark' : (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
      var next = dark ? 'light' : 'dark';
      ls('chessTheme', next); applyTheme(next);
    };
  }
  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
