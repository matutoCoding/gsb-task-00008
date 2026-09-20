/* 极简 canvas 折线/面积图, 支持 HiDPI */
(function (global) {
  'use strict';

  var PALETTE = ['#38b6a7', '#4f8cff', '#f0a93b', '#ef5f6b', '#a98bff', '#4cc38a', '#e07be0', '#6fd0e6'];

  function setup(canvas) {
    var dpr = global.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || canvas.parentElement.clientWidth;
    var cssH = parseInt(canvas.getAttribute('height'), 10) || 150;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.height = cssH + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  function drawGrid(ctx, w, h, pad, maxV, yFmt) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = '#8ba0b6';
    ctx.font = '10px sans-serif';
    ctx.lineWidth = 1;
    var rows = 4;
    for (var i = 0; i <= rows; i++) {
      var y = pad.top + (h - pad.top - pad.bottom) * i / rows;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      var val = maxV * (rows - i) / rows;
      ctx.fillText(yFmt ? yFmt(val) : String(Math.round(val)), 4, y + 3);
    }
  }

  function xLabels(ctx, w, h, pad, maxT, n) {
    ctx.fillStyle = '#8ba0b6';
    ctx.font = '10px sans-serif';
    for (var i = 0; i <= n; i++) {
      var tt = maxT * i / n;
      var x = pad.left + (w - pad.left - pad.right) * i / n;
      ctx.fillText(fmtHours(tt), x - 10, h - 5);
    }
  }
  function fmtHours(min) {
    var h = min / 60;
    return (h >= 10 ? Math.round(h) : h.toFixed(h % 1 === 0 ? 0 : 1)) + 'h';
  }

  function pathLine(ctx, grid, values, x0, x1, y0, y1, maxV, maxT) {
    ctx.beginPath();
    for (var i = 0; i < grid.length; i++) {
      var x = x0 + (x1 - x0) * (grid[i] / maxT);
      var y = y1 - (y1 - y0) * Math.min(1, values[i] / maxV);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }

  /* series: [{name, grid:[min], values:[], color?, fill?, dashed?}]
   * opts: {yFmt, maxY, threshold:{value,color,label}}
   */
  function multi(canvas, series, opts) {
    opts = opts || {};
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
    ctx.clearRect(0, 0, w, h);
    var pad = { left: 44, right: 12, top: 10, bottom: 20 };
    var maxT = 0, maxV = opts.maxY || 0;
    series.forEach(function (se) {
      if (se.grid.length) maxT = Math.max(maxT, se.grid[se.grid.length - 1]);
      if (!opts.maxY) se.values.forEach(function (v) { if (v > maxV) maxV = v; });
    });
    if (!isFinite(maxV) || maxV <= 0) maxV = 1;
    maxV *= 1.12;
    if (maxT <= 0) return;

    drawGrid(ctx, w, h, pad, maxV, opts.yFmt);
    xLabels(ctx, w, h, pad, maxT, 4);

    if (opts.threshold) {
      var ty = y0 = pad.top + (h - pad.top - pad.bottom) * (1 - opts.threshold.value / maxV);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = opts.threshold.color || '#f0a93b';
      ctx.beginPath(); ctx.moveTo(pad.left, ty); ctx.lineTo(w - pad.right, ty); ctx.stroke();
      ctx.setLineDash([]);
    }

    var x0 = pad.left, x1 = w - pad.right, yTop = pad.top, y1 = h - pad.bottom;
    series.forEach(function (se, idx) {
      var color = se.color || PALETTE[idx % PALETTE.length];
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.setLineDash(se.dashed ? [4, 4] : []);
      pathLine(ctx, se.grid, se.values, x0, x1, yTop, y1, maxV, maxT);
      ctx.stroke();
      if (se.fill) {
        ctx.lineTo(x1, y1); ctx.lineTo(x0, y1); ctx.closePath();
        ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
        ctx.beginPath();
        pathLine(ctx, se.grid, se.values, x0, x1, yTop, y1, maxV, maxT);
      }
      ctx.setLineDash([]);
    });

    // 图例
    if (opts.legend !== false) {
      var lx = pad.left + 6, ly = pad.top + 4;
      ctx.font = '10.5px sans-serif';
      series.forEach(function (se, idx) {
        var color = se.color || PALETTE[idx % PALETTE.length];
        var tw = ctx.measureText(se.name).width;
        if (lx + tw + 26 > x1) { lx = pad.left + 6; ly += 14; }
        ctx.fillStyle = color;
        ctx.fillRect(lx, ly - 7, 9, 3);
        ctx.fillStyle = '#a9bcd0';
        ctx.fillText(se.name, lx + 13, ly);
        lx += tw + 30;
      });
    }
  }

  global.Charts = { multi: multi, PALETTE: PALETTE };
})(typeof window !== 'undefined' ? window : globalThis);
