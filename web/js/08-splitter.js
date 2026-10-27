/* =============================================================
 * DataLab 前端 · 08-splitter.js
 * 栏宽 / 栏高拖拽调节（三栏宽度、底部窗口高度、表格与日志的宽度）
 *
 * 依赖：必须在 07-ui.js 之后加载，用 window 上的 el / h / toast / state。
 * 设计要点：
 *  - 布局尺寸全部写成 CSS 变量（见 style.css 里 .main / .bottom / .bottom-body），
 *    这里只改变量，不碰选择器，排版引擎自己去重算。
 *  - 拖动过程中每帧调用 G.layoutGeo()，否则多子图的占位框会停在旧位置。
 *  - 窄屏下 media query 把三栏拆成两栏 / 单栏，把手的坐标就失去意义了，
 *    所以用一个 matchMedia 判断直接隐身，避免出现"拖了没反应"。
 * ============================================================= */
(function (G) {
  'use strict';

  var KEY = 'datalab.layout';

  // 各方向的最小保留量（px）：再小里面的内容就没法用了
  var LEFT_MIN = 200, LEFT_MAX = 560;
  var RIGHT_MIN = 240, RIGHT_MAX = 600;
  var CENTER_MIN = 340;                 // 中栏（画布）再窄就没法看图了
  var BOTTOM_PCT_MAX = 0.72;            // 底部最多占整页 72%，把画布压没了就没意义
  var TBL_MIN = 220, LOG_MIN = 180;
  // 拖到比标题栏高不了多少时，直接算作"收起"，连标题栏下面那条空隙都不留
  var COLLAPSE_SLACK = 8;

  var main = null;
  var bottom = null;
  var bodyEl = null;
  var saved = null;
  // 窄屏时三栏被 media query 拆开，拖拽无意义
  var mqNarrow = null;

  function readStore() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : null;
    } catch (e) {
      return null;                      // 隐私模式 / JSON 损坏都当作没存过
    }
  }

  function writeStore() {
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch (e) { /* 忽略：存不下也不该影响拖拽 */ }
  }

  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  /* ------------------------------------------------------------
   * 把手本体的构造
   * ---------------------------------------------------------- */

  // axis: 'col' 拖宽度 | 'row' 拖高度
  function makeBar(cls, title, axis) {
    var bar = document.createElement('div');
    bar.className = 'resizer resizer-' + axis + ' ' + cls;
    bar.title = title + '（双击恢复默认）';
    bar.setAttribute('role', 'separator');
    bar.setAttribute('aria-orientation', axis === 'col' ? 'vertical' : 'horizontal');
    // grip 三个点，让用户一眼看出这里可以拖
    bar.appendChild(G.h('i', 'resizer-grip'));
    return bar;
  }

  function ensureBars() {
    if (!main || main.querySelector('.resizer')) return;
    main.appendChild(makeBar('resizer-left', '调整左栏宽度', 'col'));
    main.appendChild(makeBar('resizer-right', '调整右栏宽度', 'col'));
    // 底部整体高度的把手挂在 .main 的下边缘外：
    // .bottom 自己 overflow:hidden，放里面会被裁掉。
    main.appendChild(makeBar('resizer-bottom', '调整底部窗口高度', 'row'));
    if (bodyEl) bodyEl.appendChild(makeBar('resizer-table', '调整表格与日志的宽度', 'col'));
  }

  /* ------------------------------------------------------------
   * 尺寸换算与收敛
   * ---------------------------------------------------------- */

  function mainWidth() {
    return main ? main.clientWidth : 1200;
  }

  function clampLeft(px) {
    var w = mainWidth();
    var right = num(saved.right, 330);
    // 左 + 中 + 右 + 两道 10px gap 不能超过可用宽度
    var upper = Math.min(LEFT_MAX, w - CENTER_MIN - right - 20);
    return Math.round(Math.min(Math.max(px, LEFT_MIN), Math.max(LEFT_MIN, upper)));
  }

  function clampRight(px) {
    var w = mainWidth();
    var left = num(saved.left, 270);
    var upper = Math.min(RIGHT_MAX, w - CENTER_MIN - left - 20);
    return Math.round(Math.min(Math.max(px, RIGHT_MIN), Math.max(RIGHT_MIN, upper)));
  }

  // 拖到底要能只剩一条标题栏，所以下限必须按标题栏的实测高度算，
  // 不能写死一个 px —— 字号、padding、按钮换了高度都会变。
  function headHeight() {
    var head = bottom && bottom.querySelector('.bottom-head');
    var h = head ? head.offsetHeight : 0;
    return Math.max(20, Math.min(h || 28, 60));
  }

  function clampBottom(px) {
    var viewH = (document.documentElement && document.documentElement.clientHeight)
      || window.innerHeight || 900;
    var max = Math.round(viewH * BOTTOM_PCT_MAX);
    var min = headHeight();
    return Math.round(Math.min(Math.max(px, min), Math.max(min, max)));
  }

  /** 高度贴到标题栏就把底部真正收起来（挂 .collapsed），省掉标题栏下的空区。
   *  同时同步左下角那个「收起/展开」按钮的文案，别出现状态不一致。 */
  function syncCollapsed(px) {
    var app = document.getElementById('app');
    if (!app) return;
    var want = px != null && px <= headHeight() + COLLAPSE_SLACK;
    if (app.classList.contains('collapsed') === want) return;
    app.classList.toggle('collapsed', want);
    var btn = document.getElementById('btnToggleBottom');
    if (btn) btn.textContent = want ? '展开' : '收起';
  }

  function clampTable(px) {
    var w = bodyEl ? bodyEl.clientWidth : 800;
    var upper = Math.max(TBL_MIN, w - LOG_MIN);
    return Math.round(Math.min(Math.max(px, TBL_MIN), upper));
  }

  /* ------------------------------------------------------------
   * 应用：把已经收好的值写进 CSS 变量
   * ---------------------------------------------------------- */

  function applyAll() {
    if (!main) return;
    if (saved.left != null) main.style.setProperty('--col-left', saved.left + 'px');
    if (saved.right != null) main.style.setProperty('--col-right', saved.right + 'px');
    if (bottom && saved.bottom != null) {
      bottom.style.setProperty('--bottom-h', saved.bottom + 'px');
      // 高度既然由拖拽接管，就把 media query 里 21vh/40vh 的封顶撤掉，
      // 否则矮屏笔记本上刚拖出来又被按回去。
      bottom.style.setProperty('--bottom-max', 'none');
    }
    if (bodyEl && saved.table != null) {
      bodyEl.style.setProperty('--tbl-w', saved.table + 'px');
    }
  }

  // 窗口变小时把存下来的值重新收一遍，防止左栏把中栏挤没了
  function reflow() {
    if (!main) return;
    if (saved.left != null) saved.left = clampLeft(saved.left);
    if (saved.right != null) saved.right = clampRight(saved.right);
    if (saved.bottom != null) saved.bottom = clampBottom(saved.bottom);
    if (saved.table != null) saved.table = clampTable(saved.table);
    applyAll();
  }

  /* ------------------------------------------------------------
   * 拖拽过程
   * ---------------------------------------------------------- */

  function reflowGeo() {
    if (typeof G.layoutGeo === 'function') G.layoutGeo();
  }

  /**
   * @param {HTMLElement} bar 把手
   * @param {function(Event): number} measure 把 pointer 坐标换算成待写入的原始值
   * @param {function(number): number} clamp 收敛函数
   * @param {function(number)} apply 写回 saved 与页面
   */
  function bindDrag(bar, measure, clamp, apply, after) {
    var dragging = false;

    bar.addEventListener('pointerdown', function (e) {
      if (mqNarrow && mqNarrow.matches) return;   // 窄屏布局不是三栏，别拖
      dragging = true;
      bar.classList.add('is-active');
      document.body.classList.add('is-resizing');
      document.body.classList.add(bar.classList.contains('resizer-row')
        ? 'is-resizing-row' : 'is-resizing-col');
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* 不支持就用 window 事件 */ }
      e.preventDefault();
    });

    bar.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      apply(clamp(measure(e)));
      reflowGeo();
    });

    function finish(e) {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('is-active');
      document.body.classList.remove('is-resizing', 'is-resizing-row', 'is-resizing-col');
      try { bar.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      writeStore();
      reflowGeo();
      if (after) after();
    }
    bar.addEventListener('pointerup', finish);
    bar.addEventListener('pointercancel', finish);

    bar.addEventListener('dblclick', function (e) {
      e.preventDefault();
      bar.classList.remove('is-active');
      document.body.classList.remove('is-resizing', 'is-resizing-row', 'is-resizing-col');
      apply(null);                       // null = 恢复默认
      writeStore();
      reflowGeo();
      if (after) after();
      if (typeof G.toast === 'function') G.toast('已恢复默认栏宽', 'ok');
    });
  }

  function leftFromEvent(e) {
    // 左栏右边缘 = 指针相对 .main 左边，减去 gap 的一半
    return e.clientX - main.getBoundingClientRect().left - 5;
  }
  function rightFromEvent(e) {
    var r = main.getBoundingClientRect();
    return (r.right - e.clientX) - 5;
  }
  function bottomFromEvent(e) {
    // 底部高度 = 视口底/底层容器底 到 指针的距离
    var appRect = (document.getElementById('app') || document.body).getBoundingClientRect();
    return appRect.bottom - e.clientY - 5;
  }
  function tableFromEvent(e) {
    var r = bodyEl.getBoundingClientRect();
    return e.clientX - r.left;
  }

  /* ------------------------------------------------------------
   * 初始化
   * ---------------------------------------------------------- */

  function init() {
    main = document.querySelector('.main');
    bottom = document.querySelector('.bottom');
    bodyEl = document.querySelector('.bottom-body');
    if (!main) return;

    mqNarrow = window.matchMedia ? window.matchMedia('(max-width: 1180px)') : null;

    saved = readStore() || { left: null, right: null, bottom: null, table: null };
    ['left', 'right', 'bottom', 'table'].forEach(function (k) {
      if (saved[k] === undefined) saved[k] = null;
    });

    ensureBars();

    var barLeft = main.querySelector('.resizer-left');
    var barRight = main.querySelector('.resizer-right');
    var barBottom = main.querySelector('.resizer-bottom');
    var barTable = bodyEl ? bodyEl.querySelector('.resizer-table') : null;

    if (barLeft) {
      bindDrag(barLeft, leftFromEvent, clampLeft, function (v) {
        if (v == null) { saved.left = null; main.style.removeProperty('--col-left'); return; }
        saved.left = v;
        main.style.setProperty('--col-left', v + 'px');
      }, reflowGeo);
    }
    if (barRight) {
      bindDrag(barRight, rightFromEvent, clampRight, function (v) {
        if (v == null) { saved.right = null; main.style.removeProperty('--col-right'); return; }
        saved.right = v;
        main.style.setProperty('--col-right', v + 'px');
      }, reflowGeo);
    }
    if (barBottom) {
      bindDrag(barBottom, bottomFromEvent, clampBottom, function (v) {
        if (v == null) {
          saved.bottom = null;
          if (bottom) {
            bottom.style.removeProperty('--bottom-h');
            bottom.style.removeProperty('--bottom-max');
          }
          syncCollapsed(null);
          // 复位后按内容自然高度重来一次
          if (bottom && bottom.offsetHeight > 0) saved.bottom = clampBottom(bottom.offsetHeight);
          return;
        }
        saved.bottom = v;
        if (bottom) {
          bottom.style.setProperty('--bottom-h', v + 'px');
          bottom.style.setProperty('--bottom-max', 'none');
        }
        syncCollapsed(v);
      }, reflowGeo);
    }
    if (barTable) {
      bindDrag(barTable, tableFromEvent, clampTable, function (v) {
        if (v == null) { saved.table = null; bodyEl.style.removeProperty('--tbl-w'); return; }
        saved.table = v;
        bodyEl.style.setProperty('--tbl-w', v + 'px');
      });
    }

    // bottom 初始是 auto，先把它换成明确的 px，之后才能增量拖动
    if (bottom && saved.bottom == null && bottom.offsetHeight > 0) {
      saved.bottom = clampBottom(bottom.offsetHeight);
    }
    // table 列初始是 1.55fr，同样换成 px
    if (bodyEl && saved.table == null) {
      var first = bodyEl.querySelector('.table-section');
      if (first && first.offsetWidth > 0) saved.table = clampTable(first.offsetWidth);
    }

    applyAll();
    syncCollapsed(saved.bottom);

    // 左下角「收起/展开」按钮由 07-ui.js 处理 class，这里同步记录高度，
    // 否则下次 resize 重算时又会把窗口按回旧尺寸。
    var tbtn = document.getElementById('btnToggleBottom');
    if (tbtn) {
      tbtn.addEventListener('click', function () {
        // 让 07 的 handler 先切完 class 再读尺寸
        setTimeout(function () {
          var app = document.getElementById('app');
          if (!app || !bottom) return;
          if (app.classList.contains('collapsed')) {
            saved.bottom = headHeight();
          } else {
            var hPx = bottom.offsetHeight;
            // 从"收起"直接展开时不该只给到标题栏高度，给个能用的默认
            if (hPx <= headHeight() + COLLAPSE_SLACK) {
              var vh = (document.documentElement && document.documentElement.clientHeight)
                || window.innerHeight || 900;
              hPx = Math.round(Math.min(240, vh * 0.26));
            }
            saved.bottom = clampBottom(hPx);
            bottom.style.setProperty('--bottom-max', 'none');
          }
          applyAll();
          writeStore();
          reflowGeo();
        }, 0);
      });
    }

    var t = null;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(reflow, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  G.resetLayoutSizes = function () {
    saved = { left: null, right: null, bottom: null, table: null };
    if (main) { main.style.removeProperty('--col-left'); main.style.removeProperty('--col-right'); }
    if (bottom) { bottom.style.removeProperty('--bottom-h'); bottom.style.removeProperty('--bottom-max'); }
    if (bodyEl) bodyEl.style.removeProperty('--tbl-w');
    writeStore();
    reflowGeo();
  };
})(window);
