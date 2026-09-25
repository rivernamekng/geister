/* オンライン対戦。Firebase Realtime Database を「指し手の共有ノート」としてだけ使う。
 *
 * 秘密の守り方: 自分の駒の色はこの端末から出さない。共有するのは指し手の列と、
 * 捕獲されたときに持ち主が明かす1駒ぶんの色だけ。盤面は両者が同じ手順を
 * 並べ直して復元するので、通信を覗いても相手の伏せた駒の色は分からない。
 */
(function () {
  'use strict';
  var R = window.GeisterRules, U = window.GeisterUI;
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字は外す

  var st = {
    loading: false, ready: false, db: null, uid: null,
    code: null, role: null,           // role: 0 = 部屋を作った側, 1 = 参加した側
    mySetup: null,
    room: {},                          // Firebase から受け取った部屋の中身
    ref: null,
    error: '',
    joinCode: '',
    askedSetup: false,
    blockedOn: null,                   // 相手の色公開待ちの駒
    mismatch: false
  };

  function app() { return window.GeisterApp; }

  function config() { return window.GeisterFirebaseConfig; }

  function available() {
    var c = config();
    return !!(c && c.apiKey && c.databaseURL && c.apiKey.indexOf('ここに') < 0);
  }

  /* ---------- SDK の読み込みと接続 ---------- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('読み込みに失敗: ' + src)); };
      document.head.appendChild(s);
    });
  }

  function loadSdk() {
    // すでに用意されていれば読み込まない（テストで差し替えるため、また二重読み込みを避けるため）
    if (window.firebase) return Promise.resolve();
    return loadScript(SDK + 'firebase-app-compat.js')
      .then(function () { return loadScript(SDK + 'firebase-auth-compat.js'); })
      .then(function () { return loadScript(SDK + 'firebase-database-compat.js'); });
  }

  function connect() {
    if (st.ready) return Promise.resolve();
    if (st.loading) return st.loading;
    st.loading = loadSdk()
      .then(function () {
        if (!window.firebase.apps.length) window.firebase.initializeApp(config());
        return window.firebase.auth().signInAnonymously();
      })
      .then(function (cred) {
        st.uid = cred.user.uid;
        st.db = window.firebase.database();
        st.ready = true;
      });
    return st.loading;
  }

  function roomRef(path) {
    return st.db.ref('rooms/' + st.code + (path ? '/' + path : ''));
  }

  function makeCode() {
    var s = '';
    for (var i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  function fail(e) {
    st.error = (e && e.message) || String(e);
    app().render();
  }

  /* ---------- 部屋 ---------- */

  function openLobby() {
    st.error = '';
    app().mode = 'online';
    app().go('online-lobby');
    connect().then(function () { app().render(); }, fail);
  }

  function createRoom() {
    st.error = '';
    connect().then(function () {
      st.code = makeCode();
      st.role = 0;
      return roomRef('meta').set({ host: st.uid, createdAt: Date.now() });
    }).then(function () {
      restoreSetup();
      watch();
      app().myPlayer = 0;
      app().go('online-wait');
    }).catch(fail);
  }

  function joinRoom(code) {
    st.error = '';
    code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) { st.error = '6文字のコードを入力してください'; app().render(); return; }
    connect().then(function () {
      st.code = code;
      return roomRef('meta').get();
    }).then(function (snap) {
      var meta = snap.val();
      if (!meta) throw new Error('その部屋は見つかりません');
      if (meta.host === st.uid) { st.role = 0; return null; }
      if (meta.guest === st.uid) { st.role = 1; return null; }
      if (meta.guest) throw new Error('その部屋はもう埋まっています');
      if (meta.left) throw new Error('その部屋は閉じられています');
      st.role = 1;
      return roomRef('meta/guest').set(st.uid);
    }).then(function () {
      restoreSetup();
      watch();
      app().myPlayer = st.role;
      app().go('online-wait');
    }).catch(fail);
  }

  function watch() {
    if (st.ref) st.ref.off();
    st.ref = roomRef();
    st.ref.on('value', function (snap) {
      st.room = snap.val() || {};
      sync();
    }, fail);
  }

  function leave() {
    // 再戦を待っている相手に、もう戻らないことを知らせる
    if (st.db && st.code && st.role !== null) {
      roomRef('meta/left/' + st.role).set(true).catch(function () {});
    }
    if (st.ref) { st.ref.off(); st.ref = null; }
    st.code = null; st.role = null; st.mySetup = null;
    st.room = {}; st.askedSetup = false; st.blockedOn = null; st.mismatch = false;
  }

  /* ---------- 自分の配置（この端末の中だけに置く） ---------- */

  function setupKey() { return 'geister.setup.' + st.code; }

  function restoreSetup() {
    try {
      var raw = localStorage.getItem(setupKey());
      if (raw) st.mySetup = JSON.parse(raw);
    } catch (e) { /* 使えない端末もあるので無視 */ }
  }

  function submitSetup(setup) {
    st.mySetup = setup;
    try { localStorage.setItem(setupKey(), JSON.stringify(setup)); } catch (e) { /* 無視 */ }
    roomRef('ready/' + st.role).set(true).catch(fail);
    app().go('online-setupwait');
  }

  /* ---------- 指し手 ---------- */

  function moveList() {
    var m = st.room.moves || {};
    return Object.keys(m).map(Number).sort(function (a, b) { return a - b; })
      .map(function (k) { return m[k]; });
  }

  function sendMove(move) {
    var n = moveList().length;
    roomRef('moves/' + n).set({
      pieceId: move.pieceId,
      to: move.escape ? null : move.to,
      escape: !!move.escape
    }).catch(fail);
  }

  /* 共有された手を順に並べ直して盤面を作る。
     相手の駒を取る手は、その色が公開されるまで進めない。
     Firebase には触らない純粋な処理なので、そのままテストできる。
     戻り値の blockedOn は「誰かの色公開待ちで止まった駒」。 */
  function replayFrom(mySetup, role, moves, reveals) {
    var s = R.createHiddenState(mySetup, role);
    var blockedOn = null;
    reveals = reveals || {};

    for (var i = 0; i < moves.length; i++) {
      if (s.winner !== null) break;
      var m = moves[i];
      var piece = s.pieces[m.pieceId];
      if (!piece || piece.captured || piece.escaped || piece.owner !== s.turn) break;

      if (m.escape) {
        piece.color = R.BLUE; // 脱出できたのだから青だと分かる
      } else {
        var target = R.pieceAt(s, m.to[0], m.to[1]);
        if (target && target.owner !== piece.owner && target.color === R.UNKNOWN) {
          var rev = reveals[target.id];
          if (!rev) { blockedOn = target; break; }
          target.color = rev;
        }
      }
      s = R.applyMoveFast(s, {
        pieceId: m.pieceId, from: piece.pos, to: m.escape ? null : m.to, escape: !!m.escape
      }).state;
    }
    return { state: s, blockedOn: blockedOn };
  }

  function replay() {
    var out = replayFrom(st.mySetup, st.role, moveList(), st.room.reveals);
    st.blockedOn = out.blockedOn;
    return out.state;
  }

  /* 取られた自分の駒の色を公開する。
     自分の端末は自分の色を知っていて待ちが起きないので、
     「止まったとき」ではなく「取られたとき」を合図にしないと相手が永久に待つ。 */
  function publishMyReveals(s) {
    var reveals = st.room.reveals || {};
    s.pieces.forEach(function (p) {
      if (p.owner !== st.role || !p.captured) return;
      if (reveals[p.id]) return;
      var mine = st.mySetup[p.id - st.role * 8];
      if (mine) roomRef('reveals/' + p.id).set(mine.color).catch(fail);
    });
  }

  function publishFinal() {
    if (!st.mySetup) return;
    if (st.room.final && st.room.final[st.role]) return;
    roomRef('final/' + st.role).set(st.mySetup.map(function (x) { return x.color; })).catch(fail);
  }

  // 終局後、相手の配置を受け取って結果画面で全部見せる。
  // 途中で明かされた色と食い違っていたら申告が正しくない。
  function applyFinal(s) {
    var fin = st.room.final || {};
    var other = fin[1 - st.role];
    if (!other) return false;
    var reveals = st.room.reveals || {};
    for (var i = 0; i < 8; i++) {
      var id = (1 - st.role) * 8 + i;
      var declared = other[i];
      if (reveals[id] && reveals[id] !== declared) st.mismatch = true;
      s.pieces[id].color = declared;
    }
    return true;
  }

  /* ---------- 再戦 ----------
     同じ部屋は使い回さず、新しい部屋を作って二人で移る。
     先攻は部屋の host（role 0）なので、先攻後攻の交代は host と guest を入れ替えて作るだけで済む。
     書き込むのは meta の下だけなので、データベースのルールは変えなくてよい。 */

  function requestRematch(swap) {
    roomRef('meta/rematch').set({ by: st.role, swap: !!swap }).catch(fail);
  }

  function cancelRematch() {
    roomRef('meta/rematch').set(null).catch(fail);
  }

  function acceptRematch() {
    var meta = st.room.meta || {}, req = meta.rematch;
    if (!req || meta.next) return;
    var code = makeCode();
    st.db.ref('rooms/' + code + '/meta').set({
      host: req.swap ? meta.guest : meta.host,
      guest: req.swap ? meta.host : meta.guest,
      createdAt: Date.now()
    }).then(function () {
      return roomRef('meta/next').set(code);  // これを見て二人とも新しい部屋へ移る
    }).catch(fail);
  }

  function switchRoom(code) {
    if (st.ref) { st.ref.off(); st.ref = null; }
    st.code = code;
    st.role = null;  // 新しい部屋の meta を見て決める
    st.mySetup = null; st.room = {};
    st.askedSetup = false; st.blockedOn = null; st.mismatch = false;
    restoreSetup();
    watch();
  }

  function youAre(role) { return role === 0 ? '先攻' : '後攻'; }

  function rematchView() {
    var box = U.el('div', 'card rematch');
    var meta = st.room.meta || {}, req = meta.rematch, left = meta.left || {};

    if (left[1 - st.role]) {
      box.appendChild(U.el('p', 'muted', '相手は退出しました'));
      return box;
    }
    if (meta.next) {
      box.appendChild(U.el('p', 'muted', '次の対局を準備しています…'));
      return box;
    }
    if (!req) {
      box.appendChild(U.el('h2', null, 'もう一戦する？'));
      var row = U.el('div', 'row');
      row.appendChild(U.button('再戦する', 'primary small', function () { requestRematch(false); }));
      row.appendChild(U.button('先攻後攻を交代して再戦', 'small', function () { requestRematch(true); }));
      box.appendChild(row);
      box.appendChild(U.el('p', 'muted', '今回あなたは' + youAre(st.role) + 'でした'));
    } else if (req.by === st.role) {
      box.appendChild(U.el('h2', null, req.swap ? '先攻後攻を交代して再戦を申し込みました' : '再戦を申し込みました'));
      box.appendChild(U.el('p', 'muted', '相手の返事を待っています…'));
      box.appendChild(U.button('取り消す', 'ghost small', cancelRematch));
    } else {
      var next = req.swap ? 1 - st.role : st.role;
      box.appendChild(U.el('h2', null, '相手が再戦を申し込んでいます'));
      box.appendChild(U.el('p', 'muted',
        (req.swap ? '先攻後攻を交代します。' : '先攻後攻はそのままです。') + '次はあなたが' + youAre(next) + 'です'));
      box.appendChild(U.button('受けて始める', 'primary', acceptRematch));
    }
    return box;
  }

  /* ---------- 進行 ---------- */

  function sync() {
    var a = app();
    if (a.mode !== 'online' || !st.code) return;
    var meta = st.room.meta || {};
    var ready = st.room.ready || {};

    if (meta.next && meta.next !== st.code) { switchRoom(meta.next); return; }
    if (st.role === null) {
      if (meta.host && meta.host === st.uid) st.role = 0;
      else if (meta.guest && meta.guest === st.uid) st.role = 1;
      else return;
      a.myPlayer = st.role;
    }

    if (!meta.host || !meta.guest) { a.go('online-wait'); return; }

    if (!st.mySetup) {
      if (!st.askedSetup) { st.askedSetup = true; a.myPlayer = st.role; a.startSetup(st.role); }
      return;
    }
    if (!ready[1 - st.role]) { a.go('online-setupwait'); return; }

    var s = replay();
    publishMyReveals(s);

    if (s.winner !== null) {
      publishFinal();
      applyFinal(s);
      a.setState(s);
      a.go('result');
      return;
    }
    a.setState(s);
    if (a.view !== 'play') {
      a.selected = null; a.moves = [];
      if (s.moveCount === 0) a.sound.play('start');
    }
    a.go('play');
  }

  /* ---------- 画面 ---------- */

  function shareUrl() {
    return location.origin + location.pathname + '?room=' + st.code;
  }

  function renderView(view) {
    if (view === 'online-lobby') return viewLobby();
    if (view === 'online-wait') return viewWait();
    if (view === 'online-setupwait') return viewSetupWait();
    return U.el('div');
  }

  function viewLobby() {
    var c = U.el('div');
    var card = U.el('div', 'card');
    card.appendChild(U.el('h2', null, 'オンライン対戦'));
    card.appendChild(U.el('p', 'muted', '部屋を作ってURLを送るか、相手のコードを入れて参加します。'));
    card.appendChild(U.button('部屋を作る', 'primary', createRoom));
    c.appendChild(card);

    var join = U.el('div', 'card');
    join.appendChild(U.el('h2', null, 'コードで参加'));
    var input = U.el('input', 'text');
    input.setAttribute('maxlength', '6');
    input.setAttribute('placeholder', 'ABC123');
    input.setAttribute('autocapitalize', 'characters');
    input.value = st.joinCode || '';
    input.addEventListener('input', function () { st.joinCode = input.value; });
    join.appendChild(input);
    var gap = U.el('div'); gap.style.height = '10px'; join.appendChild(gap);
    join.appendChild(U.button('参加する', '', function () { joinRoom(input.value); }));
    c.appendChild(join);

    if (st.error) c.appendChild(U.el('div', 'err', st.error));
    c.appendChild(U.button('メニューへ', 'ghost small', function () { leave(); app().go('menu'); }));
    return c;
  }

  function viewWait() {
    var c = U.el('div');
    var card = U.el('div', 'card');
    card.appendChild(U.el('h2', null, '相手を待っています'));
    card.appendChild(U.el('div', 'code', st.code || '……'));
    card.appendChild(U.el('p', 'muted', 'このコード、またはURLを相手に送ってください。'));
    card.appendChild(U.button('URLをコピー', '', function () {
      var url = shareUrl();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { alert('コピーしました\n' + url); },
                                                function () { prompt('このURLを送ってください', url); });
      } else {
        prompt('このURLを送ってください', url);
      }
    }));
    c.appendChild(card);
    if (st.error) c.appendChild(U.el('div', 'err', st.error));
    c.appendChild(U.button('やめる', 'ghost small', function () { leave(); app().go('menu'); }));
    return c;
  }

  function viewSetupWait() {
    var c = U.el('div', 'curtain');
    c.appendChild(U.el('div', 'big', '相手の配置を待っています'));
    c.appendChild(U.el('div', 'muted', 'コード ' + (st.code || '')));
    c.appendChild(U.button('やめる', 'ghost small', function () { leave(); app().go('menu'); }));
    return c;
  }

  /* 相手の色公開待ちのときに、対局画面へ添える一言。 */
  function waitingNote() {
    if (st.blockedOn && st.blockedOn.owner !== st.role) return '相手の応答を待っています…';
    return '';
  }

  function mismatchNote() { return st.mismatch ? '※ 対局中に公開された色と、最後の申告が食い違っています' : ''; }

  window.GeisterOnline = {
    available: available,
    openLobby: openLobby,
    submitSetup: submitSetup,
    sendMove: sendMove,
    leave: leave,
    renderView: renderView,
    replayFrom: replayFrom,
    waitingNote: waitingNote,
    mismatchNote: mismatchNote,
    rematchView: rematchView,
    requestRematch: requestRematch,
    acceptRematch: acceptRematch,
    state: st
  };

  // URL に ?room=XXXXXX が付いていたら、そのまま参加画面へ。
  var param = (location.search.match(/[?&]room=([A-Za-z0-9]{6})/) || [])[1];
  if (param) {
    st.joinCode = param.toUpperCase();
    setTimeout(function () {
      if (!available()) return;
      openLobby();
    }, 0);
  }
})();
