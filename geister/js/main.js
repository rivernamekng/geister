/* 画面遷移と対局の進行。ルール判断は rules.js、描画は ui.js に任せる。 */
(function () {
  'use strict';
  var R = window.GeisterRules, AI = window.GeisterAI, U = window.GeisterUI;
  var screen = document.getElementById('screen');
  var statusEl = document.getElementById('status');

  var LEVEL_LABEL = { easy: 'やさしい', normal: 'ふつう', hard: 'つよい' };
  var REASON = {
    escape: '青おばけが脱出しました',
    took_all_blue: '相手の青おばけを4つ捕まえました',
    lost_all_red: '赤おばけを4つ取らせました'
  };

  var app = {
    view: 'menu',
    mode: null,          // 'cpu' | 'local' | 'online'
    level: 'normal',
    state: null,
    myPlayer: 0,         // この端末の担当（local では都度切り替わる）
    setupOwner: 0,
    setupColors: null,
    setups: [null, null],
    selected: null,
    moves: [],
    thinking: false,
    nextAfterCurtain: null,
    curtainText: ''
  };
  window.GeisterApp = app;

  /* ---------- 共通 ---------- */

  function go(view) { app.view = view; render(); }

  // この端末が今操作してよいプレイヤー。操作できないときは null。
  function controller() {
    if (!app.state || app.state.winner !== null) return null;
    if (app.mode === 'local') return app.state.turn;
    return app.state.turn === app.myPlayer ? app.myPlayer : null;
  }

  function perspective() {
    return app.mode === 'local' ? app.state.turn : app.myPlayer;
  }

  // 配置マスを「そのプレイヤーから見た並び」に直す。前列が上に来る。
  function setupDisplayOrder(owner) {
    return R.setupSquares(owner).slice().sort(function (a, b) {
      var da = U.toDisplay(a[0], a[1], owner), db = U.toDisplay(b[0], b[1], owner);
      return da[0] - db[0] || da[1] - db[1];
    });
  }

  /* ---------- メニュー ---------- */

  function viewMenu() {
    var c = U.el('div');
    var cpu = U.el('div', 'card');
    cpu.appendChild(U.el('h2', null, 'CPUと対戦'));
    var row = U.el('div', 'row');
    ['easy', 'normal', 'hard'].forEach(function (lv) {
      row.appendChild(U.button(LEVEL_LABEL[lv], 'small', function () {
        app.mode = 'cpu'; app.level = lv; app.myPlayer = 0;
        app.setups = [null, null];
        startSetup(0);
      }));
    });
    cpu.appendChild(row);
    c.appendChild(cpu);

    var other = U.el('div', 'card');
    other.appendChild(U.el('h2', null, '人と対戦'));
    other.appendChild(U.button('1台を交代で使って対戦', '', function () {
      app.mode = 'local'; app.setups = [null, null]; startSetup(0);
    }));
    var gap = U.el('div');
    gap.style.height = '10px';
    other.appendChild(gap);
    other.appendChild(U.button('オンラインで対戦', '', function () {
      if (window.GeisterOnline && window.GeisterOnline.available()) {
        app.mode = 'online';
        window.GeisterOnline.openLobby();
      } else {
        alert('オンライン対戦を使うには Firebase の設定が必要です。README.md の手順を参照してください。');
      }
    }));
    c.appendChild(other);

    c.appendChild(U.button('遊び方', 'ghost', function () { go('help'); }));
    return c;
  }

  function viewHelp() {
    var c = U.el('div');
    var card = U.el('div', 'card');
    card.appendChild(U.el('h2', null, '遊び方'));
    [
      '各自8体のおばけを持ちます。青が4体（良いおばけ）、赤が4体（悪いおばけ）。相手からは色が見えません。',
      '交代で、自分のおばけを縦か横に1マス動かします。相手のおばけがいるマスに入ると捕獲でき、そのとき色が公開されます。',
      '次のどれかを達成すると勝ちです。',
      '① 相手の青おばけを4体すべて捕まえる',
      '② 自分の赤おばけを4体すべて取らせる',
      '③ 自分の青おばけを、相手陣のいちばん奥の左右どちらかの角から盤の外へ脱出させる'
    ].forEach(function (t) { card.appendChild(U.el('p', 'muted', t)); });
    c.appendChild(card);
    c.appendChild(U.button('もどる', 'ghost', function () { go('menu'); }));
    return c;
  }

  /* ---------- 配置 ---------- */

  function startSetup(owner) {
    app.setupOwner = owner;
    app.setupColors = {};
    setupDisplayOrder(owner).forEach(function (p, i) {
      app.setupColors[R.idx(p[0], p[1])] = i < 4 ? R.BLUE : R.RED;
    });
    go('setup');
  }

  function setupCount(color) {
    var n = 0;
    for (var k in app.setupColors) if (app.setupColors[k] === color) n++;
    return n;
  }

  function viewSetup() {
    var owner = app.setupOwner;
    var c = U.el('div');
    var card = U.el('div', 'card');
    var who = app.mode === 'local' ? 'プレイヤー' + (owner + 1) + 'の配置' : 'おばけを配置';
    card.appendChild(U.el('h2', null, who));
    card.appendChild(U.el('p', 'muted', 'タップで青（良い）と赤（悪い）を切り替えます。上の列が前線です。'));

    var grid = U.el('div', 'setup-grid');
    setupDisplayOrder(owner).forEach(function (p) {
      var key = R.idx(p[0], p[1]);
      var cell = U.el('div', 'setup-cell');
      cell.appendChild(U.ghost(app.setupColors[key]));
      cell.addEventListener('click', function () {
        app.setupColors[key] = app.setupColors[key] === R.BLUE ? R.RED : R.BLUE;
        render();
      });
      grid.appendChild(cell);
    });
    card.appendChild(grid);

    var counts = U.el('div', 'counts');
    counts.appendChild(U.el('span', null, '青 ' + setupCount(R.BLUE) + ' / 4'));
    counts.appendChild(U.el('span', null, '赤 ' + setupCount(R.RED) + ' / 4'));
    card.appendChild(counts);
    c.appendChild(card);

    var row = U.el('div', 'row');
    row.appendChild(U.button('おまかせ', 'small', function () {
      var order = setupDisplayOrder(owner).slice().sort(function () { return Math.random() - 0.5; });
      order.forEach(function (p, i) { app.setupColors[R.idx(p[0], p[1])] = i < 4 ? R.BLUE : R.RED; });
      render();
    }));
    var ok = U.button('この配置で開始', 'primary small', function () { confirmSetup(owner); });
    ok.disabled = setupCount(R.BLUE) !== 4;
    row.appendChild(ok);
    c.appendChild(row);
    c.appendChild(U.button('メニューへ', 'ghost small', function () { go('menu'); }));
    return c;
  }

  function confirmSetup(owner) {
    app.setups[owner] = R.setupSquares(owner).map(function (p) {
      return { pos: p, color: app.setupColors[R.idx(p[0], p[1])] };
    });
    if (app.mode === 'cpu') {
      app.setups[1] = AI.chooseSetup(1);
      beginGame();
    } else if (app.mode === 'local') {
      if (owner === 0) curtain('プレイヤー2に渡してください', function () { startSetup(1); });
      else curtain('プレイヤー1の番です', beginGame);
    } else if (app.mode === 'online') {
      window.GeisterOnline.submitSetup(app.setups[owner]);
    }
  }

  function beginGame() {
    app.state = R.createState(app.setups[0], app.setups[1]);
    app.selected = null; app.moves = [];
    skipIfStuck();
    go('play');
  }

  /* ---------- カーテン（1台で交代するとき、相手に色を見せないため） ---------- */

  function curtain(text, next) {
    app.curtainText = text;
    app.nextAfterCurtain = next;
    go('curtain');
  }

  function viewCurtain() {
    var c = U.el('div', 'curtain');
    c.appendChild(U.el('div', 'big', app.curtainText));
    c.appendChild(U.el('div', 'muted', '相手に画面を見せないように渡してください'));
    c.appendChild(U.button('タップして続ける', 'primary', function () {
      var n = app.nextAfterCurtain;
      app.nextAfterCurtain = null;
      n();
    }));
    return c;
  }

  /* ---------- 対局 ---------- */

  function viewPlay() {
    var s = app.state, me = perspective(), opp = 1 - me;
    var c = U.el('div');

    c.appendChild(U.tray('相手が取った', s.captured[opp]));
    c.appendChild(U.board({
      state: s, perspective: me, reveal: [me],
      selected: app.selected, moves: app.moves,
      onTap: onTap
    }));
    c.appendChild(U.tray('自分が取った', s.captured[me]));

    var esc = app.moves.filter(function (m) { return m.escape; });
    if (esc.length) {
      c.appendChild(U.button('このおばけを脱出させる', 'primary', function () { play(esc[0]); }));
    }
    if (app.mode === 'online' && window.GeisterOnline) {
      var note = window.GeisterOnline.waitingNote();
      if (note) c.appendChild(U.el('div', 'muted', note));
    }
    c.appendChild(U.button('メニューへ', 'ghost small', function () {
      if (confirm('対局を中断してメニューに戻りますか？')) {
        if (app.mode === 'online' && window.GeisterOnline) window.GeisterOnline.leave();
        go('menu');
      }
    }));
    return c;
  }

  function onTap(r, c) {
    var ctl = controller();
    if (ctl === null || app.thinking) return;
    var s = app.state;
    var p = R.pieceAt(s, r, c);

    if (p && p.owner === ctl) {
      app.selected = p.id;
      app.moves = R.legalMoves(s, ctl).filter(function (m) { return m.pieceId === p.id; });
      render();
      return;
    }
    var chosen = app.moves.filter(function (m) {
      return !m.escape && m.to[0] === r && m.to[1] === c;
    })[0];
    if (chosen) { play(chosen); return; }
    app.selected = null; app.moves = [];
    render();
  }

  function play(move) {
    // オンラインでは盤を直接は動かさない。指し手を送り、
    // 送受信した手を並べ直した結果として盤が更新される（局面の出所を1つに保つ）。
    if (app.mode === 'online') {
      app.selected = null; app.moves = [];
      window.GeisterOnline.sendMove(move);
      render();
      return;
    }
    app.state = R.applyMove(app.state, move).state;
    app.selected = null; app.moves = [];
    afterMove();
  }

  // 動ける手が無い側は手番を渡す（挟まれて全駒が塞がれた場合の保険）。
  function skipIfStuck() {
    var guard = 0;
    while (app.state.winner === null &&
           R.legalMoves(app.state, app.state.turn).length === 0 && guard++ < 2) {
      app.state = R.cloneState(app.state);
      app.state.turn = 1 - app.state.turn;
    }
  }

  function afterMove() {
    skipIfStuck();
    if (app.state.winner !== null) { go('result'); return; }

    if (app.mode === 'cpu' && app.state.turn !== app.myPlayer) {
      app.thinking = true;
      go('play');
      setTimeout(function () {
        var mv = AI.chooseMove(app.state, app.state.turn, app.level);
        app.thinking = false;
        if (!mv) { go('result'); return; }
        app.state = R.applyMove(app.state, mv).state;
        afterMove();
      }, 260);
      return;
    }
    if (app.mode === 'local') {
      curtain('プレイヤー' + (app.state.turn + 1) + 'の番です', function () { go('play'); });
      return;
    }
    go('play');
  }

  /* ---------- 結果 ---------- */

  function viewResult() {
    var s = app.state, c = U.el('div', 'result');
    var head = U.el('div', 'head');
    if (app.mode === 'local') {
      head.textContent = 'プレイヤー' + (s.winner + 1) + 'の勝ち';
      head.classList.add('win');
    } else {
      var won = s.winner === app.myPlayer;
      head.textContent = won ? 'あなたの勝ち' : 'あなたの負け';
      head.classList.add(won ? 'win' : 'lose');
    }
    c.appendChild(head);
    c.appendChild(U.el('div', 'muted', REASON[s.reason] || ''));
    if (app.mode === 'online' && window.GeisterOnline) {
      var warn = window.GeisterOnline.mismatchNote();
      if (warn) c.appendChild(U.el('div', 'err', warn));
    }

    var rev = U.el('div', 'reveal');
    [0, 1].forEach(function (p) {
      var side = U.el('div', 'side');
      side.appendChild(U.el('div', null,
        app.mode === 'local' ? 'プレイヤー' + (p + 1) : (p === app.myPlayer ? 'あなた' : '相手')));
      var box = U.el('div', 'pieces');
      s.pieces.filter(function (pc) { return pc.owner === p; })
        .forEach(function (pc) { box.appendChild(U.ghost(pc.color)); });
      side.appendChild(box);
      rev.appendChild(side);
    });
    c.appendChild(rev);

    var again = U.el('div', 'row');
    again.style.marginTop = '16px';
    if (app.mode !== 'online') {
      again.appendChild(U.button('もう一度', 'primary small', function () {
        app.setups = [null, null];
        startSetup(0);
      }));
    }
    again.appendChild(U.button('メニューへ', 'small', function () {
      if (app.mode === 'online' && window.GeisterOnline) window.GeisterOnline.leave();
      go('menu');
    }));
    c.appendChild(again);
    return c;
  }

  /* ---------- 描画 ---------- */

  function statusText() {
    if (app.view === 'play') {
      if (app.thinking) return 'CPUが考え中…';
      if (app.mode === 'cpu') {
        return (app.state.turn === app.myPlayer ? 'あなたの番' : '相手の番') + ' / ' + LEVEL_LABEL[app.level];
      }
      if (app.mode === 'local') return 'プレイヤー' + (app.state.turn + 1) + 'の番';
      return app.state.turn === app.myPlayer ? 'あなたの番' : '相手の番';
    }
    if (app.view === 'setup') return '配置';
    return '';
  }

  function render() {
    U.clear(screen);
    var node;
    switch (app.view) {
      case 'menu': node = viewMenu(); break;
      case 'help': node = viewHelp(); break;
      case 'setup': node = viewSetup(); break;
      case 'curtain': node = viewCurtain(); break;
      case 'play': node = viewPlay(); break;
      case 'result': node = viewResult(); break;
      default:
        node = (window.GeisterOnline && window.GeisterOnline.renderView)
          ? window.GeisterOnline.renderView(app.view)
          : U.el('div');
    }
    screen.appendChild(node);
    statusEl.textContent = statusText();
  }

  // オンライン側から呼ぶための入口
  app.go = go;
  app.render = render;
  app.beginGame = beginGame;
  app.startSetup = startSetup;
  app.curtain = curtain;
  app.afterMove = afterMove;
  app.skipIfStuck = skipIfStuck;

  render();
})();
