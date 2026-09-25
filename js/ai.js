/* ガイスターのCPU。rules.js のみに依存する。
   相手の駒色は見えない前提で、「相手の色を確率的に仮定した盤面」を何通りも作り、
   それぞれを深さ優先で読んで平均点の最も高い手を選ぶ（determinization）。
   探索前に必ず相手の色を引き直すので、局面が持つ本当の色は結果に影響しない。 */
(function (global) {
  'use strict';
  var R = global.GeisterRules;

  var LEVELS = {
    easy:   { samples: 2, depth: 2, noise: 40 },
    normal: { samples: 6, depth: 4, noise: 10 },
    hard:   { samples: 8, depth: 5, noise: 0 }
  };

  var WIN = 100000;
  // 勝利条件への進捗（4つ揃うと決着）。終盤ほど1つの差が重い。
  var PROG = [0, 18, 42, 78, WIN];

  function escDist(owner, pos) {
    return Math.min.apply(null, R.ESCAPE[owner].map(function (e) {
      return Math.abs(e[0] - pos[0]) + Math.abs(e[1] - pos[1]);
    }));
  }

  function escapeScore(s, p) {
    var t = 0;
    R.alivePieces(s, p).forEach(function (pc) {
      if (pc.color !== R.BLUE) return;
      var d = escDist(p, pc.pos);
      t += d === 0 ? 110 : Math.max(0, 46 - 7 * d);
    });
    return t;
  }

  /* me から見た評価値。色が確定した盤面にだけ使う。 */
  function evaluate(s, me) {
    if (s.winner !== null) {
      return s.winner === me ? WIN - s.moveCount : -WIN + s.moveCount;
    }
    var opp = 1 - me, sc = 0;
    sc += PROG[R.countColor(s.captured[me], R.BLUE)];   // 相手の青を取る = 自分の勝ちに近づく
    sc += PROG[R.countColor(s.captured[opp], R.RED)];   // 自分の赤を取らせる = 自分の勝ちに近づく
    sc -= PROG[R.countColor(s.captured[me], R.RED)];    // 相手の赤を取る = 自分の負けに近づく
    sc -= PROG[R.countColor(s.captured[opp], R.BLUE)];  // 自分の青を取られる = 自分の負けに近づく
    sc += escapeScore(s, me) - escapeScore(s, opp);
    return sc;
  }

  // 取る手・脱出手を先に読むと枝刈りが効く。
  function order(moves, s) {
    return moves.slice().sort(function (a, b) { return rank(b, s) - rank(a, s); });
  }
  function rank(m, s) {
    if (m.escape) return 3;
    return R.pieceAt(s, m.to[0], m.to[1]) ? 2 : 0;
  }

  function search(s, depth, alpha, beta, me) {
    if (s.winner !== null || depth === 0) return evaluate(s, me);
    var moves = R.legalMoves(s, s.turn);
    if (!moves.length) return evaluate(s, me);
    moves = order(moves, s);
    var maximizing = s.turn === me, best = maximizing ? -Infinity : Infinity;
    for (var i = 0; i < moves.length; i++) {
      var v = search(R.applyMoveFast(s, moves[i]).state, depth - 1, alpha, beta, me);
      if (maximizing) {
        if (v > best) best = v;
        if (best > alpha) alpha = best;
      } else {
        if (v < best) best = v;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break;
    }
    return best;
  }

  /* 相手の各駒が青である見込み。位置だけから推定し、本当の色は見ない。
     角（相手の脱出口）へ向かう駒は青らしく、こちらへ迫る駒は赤らしい。 */
  function blueWeights(s, opp) {
    var alive = R.alivePieces(s, opp), out = {};
    alive.forEach(function (pc) {
      var w = 0.5;
      w += (6 - escDist(opp, pc.pos)) * 0.05;
      var touching = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(function (d) {
        var r = pc.pos[0] + d[0], c = pc.pos[1] + d[1];
        if (!R.inBounds(r, c)) return false;
        var t = R.pieceAt(s, r, c);
        return t && t.owner !== opp;
      });
      if (touching) w -= 0.15;
      out[pc.id] = Math.min(0.92, Math.max(0.08, w));
    });
    return out;
  }

  function sampleBlues(ids, weights, k, rng) {
    var pool = ids.slice(), w = pool.map(function (id) { return weights[id]; }), chosen = [];
    while (chosen.length < k && pool.length) {
      var tot = w.reduce(function (a, b) { return a + b; }, 0);
      var x = rng() * tot, acc = 0, pick = w.length - 1;
      for (var i = 0; i < w.length; i++) { acc += w[i]; if (x <= acc) { pick = i; break; } }
      chosen.push(pool[pick]);
      pool.splice(pick, 1); w.splice(pick, 1);
    }
    return chosen;
  }

  /* 相手の生存駒に色を割り振った盤面を1つ作る。 */
  function determinize(s, me, weights, rng) {
    var opp = 1 - me;
    var remainingBlue = 4 - R.countColor(s.captured[me], R.BLUE);
    var alive = R.alivePieces(s, opp).map(function (p) { return p.id; });
    var blues = sampleBlues(alive, weights, remainingBlue, rng);
    var ns = R.cloneState(s);
    alive.forEach(function (id) {
      ns.pieces[id].color = blues.indexOf(id) >= 0 ? R.BLUE : R.RED;
    });
    return ns;
  }

  function chooseMove(state, me, level, rng) {
    rng = rng || Math.random;
    var cfg = LEVELS[level] || LEVELS.normal;
    var moves = R.legalMoves(state, me);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];

    var weights = blueWeights(state, 1 - me);
    var totals = moves.map(function () { return 0; });
    for (var n = 0; n < cfg.samples; n++) {
      var d = determinize(state, me, weights, rng);
      for (var i = 0; i < moves.length; i++) {
        totals[i] += search(R.applyMoveFast(d, moves[i]).state,
                            cfg.depth - 1, -Infinity, Infinity, me);
      }
    }
    var bestIdx = 0, bestVal = -Infinity;
    for (var j = 0; j < moves.length; j++) {
      var v = totals[j] / cfg.samples + (cfg.noise ? (rng() - 0.5) * cfg.noise : 0);
      if (v > bestVal) { bestVal = v; bestIdx = j; }
    }
    return moves[bestIdx];
  }

  /* 初期配置を決める。青は前に出しやすい位置、赤は脱出口の守りに置く。 */
  function chooseSetup(owner, rng) {
    rng = rng || Math.random;
    var sq = R.setupSquares(owner);
    var shuffled = sq.slice().sort(function () { return rng() - 0.5; });
    var blues = shuffled.slice(0, 4);
    return sq.map(function (p) {
      var isBlue = blues.some(function (b) { return b[0] === p[0] && b[1] === p[1]; });
      return { pos: p, color: isBlue ? R.BLUE : R.RED };
    });
  }

  global.GeisterAI = {
    LEVELS: LEVELS,
    chooseMove: chooseMove,
    chooseSetup: chooseSetup,
    blueWeights: blueWeights,
    evaluate: evaluate
  };
})(typeof window !== 'undefined' ? window : globalThis);
