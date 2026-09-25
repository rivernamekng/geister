/* 描画とタップ入力。盤面の解釈は rules.js に任せ、ここは「見せ方」だけを持つ。 */
(function (global) {
  'use strict';
  var R = global.GeisterRules;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* おばけの絵。kind は 'blue' | 'red' | 'unknown'。 */
  function ghost(kind) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ghost ' + kind);
    svg.innerHTML =
      '<path fill="currentColor" d="M12 2.2c-3.9 0-7 3.1-7 7v9.9c0 .85.97 1.33 1.64.8l1.5-1.17 1.5 1.17c.36.28.87.28 1.23 0L12 18.9l1.13.88c.36.28.87.28 1.23 0l1.5-1.17 1.5 1.17c.67.53 1.64.05 1.64-.8V9.2c0-3.9-3.1-7-7-7z"/>' +
      (kind === 'unknown'
        ? '<text x="12" y="13.6" text-anchor="middle" font-size="8" font-weight="700" fill="#161a22" font-family="system-ui">?</text>'
        : '<circle cx="9.3" cy="10" r="1.35" fill="#161a22"/><circle cx="14.7" cy="10" r="1.35" fill="#161a22"/>');
    return svg;
  }

  // 盤の座標 → 画面の座標。perspective のプレイヤーが常に手前（下）になるよう180度回す。
  function toDisplay(r, c, persp) { return persp === 1 ? [5 - r, 5 - c] : [r, c]; }
  function fromDisplay(dr, dc, persp) { return persp === 1 ? [5 - dr, 5 - dc] : [dr, dc]; }

  /* vm: {state, perspective, reveal:[…色が見えるプレイヤー], selected:pieceId|null,
          moves:[…選択中の駒の合法手], zone:[[r,c]…], onTap(r,c)} */
  function board(vm) {
    var g = el('div', 'board');
    var destMap = {};
    (vm.moves || []).forEach(function (m) { if (!m.escape) destMap[R.idx(m.to[0], m.to[1])] = m; });
    var zoneMap = {};
    (vm.zone || []).forEach(function (p) { zoneMap[R.idx(p[0], p[1])] = true; });

    for (var dr = 0; dr < 6; dr++) {
      for (var dc = 0; dc < 6; dc++) {
        var rc = fromDisplay(dr, dc, vm.perspective), r = rc[0], c = rc[1];
        var cell = el('div', 'cell' + ((r + c) % 2 ? ' dark' : ''));
        if (R.isEscapeSquare(vm.perspective, r, c)) cell.classList.add('exit-mine');
        else if (R.isEscapeSquare(1 - vm.perspective, r, c)) cell.classList.add('exit-theirs');
        if (zoneMap[R.idx(r, c)]) cell.classList.add('zone');

        var p = R.pieceAt(vm.state, r, c);
        if (p) {
          var visible = (vm.reveal || []).indexOf(p.owner) >= 0;
          cell.appendChild(ghost(visible ? p.color : 'unknown'));
          if (p.owner === vm.perspective) cell.classList.add('mine');
          if (vm.selected === p.id) cell.classList.add('sel');
        }
        var m = destMap[R.idx(r, c)];
        if (m) {
          cell.classList.add('move');
          if (p) cell.classList.add('capture');
        }
        (function (rr, cc) {
          cell.addEventListener('click', function () { if (vm.onTap) vm.onTap(rr, cc); });
        })(r, c);
        g.appendChild(cell);
      }
    }
    return g;
  }

  /* 取った駒の表示。colors は色の配列。 */
  function tray(labelText, colors) {
    var wrap = el('div', 'tray');
    wrap.appendChild(el('span', 'label', labelText));
    var box = el('div', 'pieces');
    if (!colors.length) box.appendChild(el('span', 'none', 'まだ無し'));
    colors.forEach(function (c) { box.appendChild(ghost(c)); });
    wrap.appendChild(box);
    return wrap;
  }

  function button(text, cls, onClick) {
    var b = el('button', 'btn ' + (cls || ''), text);
    b.addEventListener('click', onClick);
    return b;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  global.GeisterUI = {
    el: el, ghost: ghost, board: board, tray: tray, button: button, clear: clear,
    toDisplay: toDisplay, fromDisplay: fromDisplay
  };
})(typeof window !== 'undefined' ? window : globalThis);
