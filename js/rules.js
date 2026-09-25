/* ガイスター ルールエンジン（純粋関数のみ。DOM・通信には一切依存しない） */
(function (global) {
  'use strict';

  var SIZE = 6;
  var BLUE = 'blue';   // 青 = 良いおばけ
  var RED = 'red';     // 赤 = 悪いおばけ
  var UNKNOWN = 'unknown';  // オンライン対戦で、まだ明かされていない相手の駒

  // 手前(下)が player 0、奥(上)が player 1。
  // player 0 は row を減らす向きに進み、相手陣最奥 row 0 の両角から脱出する。
  var ESCAPE = [
    [[0, 0], [0, 5]],
    [[5, 0], [5, 5]]
  ];

  // 初期配置できるマス（自陣手前2行 × 中央4列 = 8マス）
  var SETUP_ROWS = [[4, 5], [0, 1]];
  var SETUP_COLS = [1, 2, 3, 4];

  function idx(r, c) { return r * SIZE + c; }
  function inBounds(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

  function setupSquares(owner) {
    var out = [];
    SETUP_ROWS[owner].forEach(function (r) {
      SETUP_COLS.forEach(function (c) { out.push([r, c]); });
    });
    return out;
  }

  function isEscapeSquare(owner, r, c) {
    return ESCAPE[owner].some(function (p) { return p[0] === r && p[1] === c; });
  }

  /* setup0 / setup1: [{pos:[r,c], color:'blue'|'red'} x8]。青4・赤4で自陣8マスを埋めること。 */
  function createState(setup0, setup1) {
    var board = new Array(SIZE * SIZE).fill(null);
    var pieces = [];
    [setup0, setup1].forEach(function (setup, owner) {
      validateSetup(setup, owner);
      setup.forEach(function (s, i) {
        var id = owner * 8 + i;
        pieces[id] = {
          id: id, owner: owner, color: s.color,
          pos: [s.pos[0], s.pos[1]], captured: false, escaped: false
        };
        board[idx(s.pos[0], s.pos[1])] = id;
      });
    });
    return {
      board: board,
      pieces: pieces,
      turn: 0,
      winner: null,
      reason: null,
      captured: [[], []], // captured[p] = p が取った相手駒の色の配列
      moveCount: 0
    };
  }

  function validateSetup(setup, owner) {
    if (!setup || setup.length !== 8) throw new Error('配置は8駒必要です');
    var hidden = setup.some(function (s) { return s.color === UNKNOWN; });
    var blues = setup.filter(function (s) { return s.color === BLUE; }).length;
    // 色を伏せた側は枚数を検証できない（相手の配置は見えないため）。
    if (!hidden && blues !== 4) throw new Error('青は4駒必要です');
    var allowed = setupSquares(owner).map(function (p) { return idx(p[0], p[1]); });
    var seen = {};
    setup.forEach(function (s) {
      var k = idx(s.pos[0], s.pos[1]);
      if (allowed.indexOf(k) < 0) throw new Error('自陣の配置可能マスではありません');
      if (seen[k]) throw new Error('同じマスに2駒あります');
      seen[k] = true;
    });
  }

  /* オンライン対戦用。自分の配置だけ本物の色を入れ、相手の8駒は色を伏せて並べる。
     初期位置は自陣8マスと決まっているので、相手の秘密を知らなくても盤は作れる。 */
  function createHiddenState(mySetup, me) {
    var opp = 1 - me;
    var hidden = setupSquares(opp).map(function (p) { return { pos: p, color: UNKNOWN }; });
    return me === 0 ? createState(mySetup, hidden) : createState(hidden, mySetup);
  }

  function cloneState(s) {
    return {
      board: s.board.slice(),
      pieces: s.pieces.map(function (p) {
        return { id: p.id, owner: p.owner, color: p.color, pos: p.pos ? p.pos.slice() : null,
                 captured: p.captured, escaped: p.escaped };
      }),
      turn: s.turn,
      winner: s.winner,
      reason: s.reason,
      captured: [s.captured[0].slice(), s.captured[1].slice()],
      moveCount: s.moveCount
    };
  }

  function pieceAt(s, r, c) {
    var id = s.board[idx(r, c)];
    return id === null ? null : s.pieces[id];
  }

  /* 手番プレイヤーの合法手。脱出は青駒のみ（自分の色は自分だけが知っている）。 */
  function legalMoves(s, player) {
    if (s.winner !== null) return [];
    if (player === undefined) player = s.turn;
    var moves = [];
    s.pieces.forEach(function (p) {
      if (p.owner !== player || p.captured || p.escaped) return;
      var r = p.pos[0], c = p.pos[1];
      [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function (d) {
        var nr = r + d[0], nc = c + d[1];
        if (!inBounds(nr, nc)) return;
        var t = pieceAt(s, nr, nc);
        if (t && t.owner === player) return;
        moves.push({ pieceId: p.id, from: [r, c], to: [nr, nc], escape: false });
      });
      if (p.color === BLUE && isEscapeSquare(player, r, c)) {
        moves.push({ pieceId: p.id, from: [r, c], to: null, escape: true });
      }
    });
    return moves;
  }

  // from も比較する。古い手や取り違えた手が通ると盤面が壊れるため。
  function sameMove(a, b) {
    return a.pieceId === b.pieceId && !!a.escape === !!b.escape &&
      a.from[0] === b.from[0] && a.from[1] === b.from[1] &&
      (a.escape || (a.to[0] === b.to[0] && a.to[1] === b.to[1]));
  }

  /* 指し手を適用して新しい局面を返す。捕獲した駒の色はここで公開される。 */
  function applyMove(s, move) {
    var legal = legalMoves(s, s.turn);
    if (!legal.some(function (m) { return sameMove(m, move); })) {
      throw new Error('不正な手です');
    }
    return applyMoveFast(s, move);
  }

  /* 合法性を検査しない版。合法手リストから取った手にだけ使うこと（探索用）。 */
  function applyMoveFast(s, move) {
    var ns = cloneState(s);
    var p = ns.pieces[move.pieceId];
    var mover = ns.turn;
    ns.board[idx(p.pos[0], p.pos[1])] = null;

    var capturedColor = null;
    if (move.escape) {
      p.escaped = true;
      p.pos = null;
    } else {
      var target = pieceAt(ns, move.to[0], move.to[1]);
      if (target) {
        capturedColor = target.color;
        target.captured = true;
        target.pos = null;
        ns.captured[mover].push(capturedColor);
      }
      p.pos = [move.to[0], move.to[1]];
      ns.board[idx(move.to[0], move.to[1])] = p.id;
    }

    ns.moveCount += 1;
    applyWinCheck(ns, mover, move.escape);
    if (ns.winner === null) ns.turn = 1 - mover;
    return { state: ns, capturedColor: capturedColor };
  }

  function countColor(list, color) {
    return list.filter(function (x) { return x === color; }).length;
  }

  function applyWinCheck(s, mover, escaped) {
    if (escaped) { s.winner = mover; s.reason = 'escape'; return; }
    // 相手の青を4つ全部取った → 取った側の勝ち
    if (countColor(s.captured[mover], BLUE) === 4) { s.winner = mover; s.reason = 'took_all_blue'; return; }
    // 自分の赤を4つ全部取らせた → 取らせた側の勝ち
    if (countColor(s.captured[mover], RED) === 4) { s.winner = 1 - mover; s.reason = 'lost_all_red'; return; }
  }

  function alivePieces(s, owner) {
    return s.pieces.filter(function (p) {
      return p.owner === owner && !p.captured && !p.escaped;
    });
  }

  global.GeisterRules = {
    SIZE: SIZE, BLUE: BLUE, RED: RED, UNKNOWN: UNKNOWN, ESCAPE: ESCAPE,
    idx: idx, inBounds: inBounds,
    setupSquares: setupSquares, isEscapeSquare: isEscapeSquare,
    createState: createState, createHiddenState: createHiddenState,
    cloneState: cloneState, pieceAt: pieceAt,
    legalMoves: legalMoves, applyMove: applyMove, applyMoveFast: applyMoveFast,
    sameMove: sameMove,
    alivePieces: alivePieces, countColor: countColor
  };
})(typeof window !== 'undefined' ? window : globalThis);
