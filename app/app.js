/* 岸桥–集卡协同作业估算 —— 页面逻辑
 * 关键原则:
 *  1. 任何条件改动 -> 标记结果过期, 旧结论作废, 必须重算;
 *  2. 抽车/分车是全局网络仿真, 连带变慢一起算;
 *  3. 实际进度用于"修正后续"而非重来: 更新剩余箱 + 校准岸桥效率系数;
 *  4. 全部条件存 localStorage, 关页面再打开自动恢复。
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var STORE_KEY = 'quay_truck_estimator_v1';

  // ---------------- 默认场景 ----------------
  function uid(p) { return p + '_' + Math.random().toString(36).slice(2, 8); }

  function defaultState() {
    return {
      weather: 1.0,
      travelToYardMin: 8,
      travelBackMin: 8,
      lines: [
        line('L-1', '1号作业线', 'YA', 420, 25, 6, false),
        line('L-2', '2号作业线', 'YA', 380, 25, 6, false),
        line('L-3', '3号作业线', 'YB', 350, 22, 5, false),
        line('L-4', '4号作业线', 'YB', 300, 22, 5, false)
      ],
      yards: [
        { id: 'YA', name: 'A区堆场', rate: 55, capacity: 6 },
        { id: 'YB', name: 'B区堆场', rate: 50, capacity: 6 }
      ],
      cache: null,          // {fingerprint, at, result}
      history: [],          // [{label, at, fp}]
      seq: 1
    };
    function line(id, name, yardId, remaining, craneRate, trucks, down) {
      return {
        id: id, name: name, yardId: yardId, remaining: remaining,
        craneRate: craneRate, trucks: trucks, down: down,
        calib: null,         // {factor, at, detail}
        calibSig: null       // 校准时的配置指纹(车数/天气/堆场), 变化则系数置灰
      };
    }
  }

  var state = loadState();

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.lines && s.yards) return s;
      }
    } catch (e) { /* 损坏则回默认 */ }
    return defaultState();
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // ---------------- 模型构建 / 指纹 / 过期判断 ----------------
  function totalTrucks() {
    return state.lines.reduce(function (a, l) { return a + (l.down ? 0 : l.trucks | 0); }, 0);
  }
  function effectiveRate(ln) {
    var base = ln.craneRate * state.weather;
    if (ln.calib && ln.calibSig === calibBasisFp()) base *= ln.calib.factor;
    return base;
  }
  function calibBasisFp() {
    return hashStr(JSON.stringify({
      w: +state.weather.toFixed(3),
      t: [state.travelToYardMin, state.travelBackMin],
      l: state.lines.map(function (l) { return [l.id, l.trucks, l.down, l.yardId]; }),
      y: state.yards.map(function (y) { return [y.id, y.rate, y.capacity]; })
    }));
  }
  // 天气差时视线受限、车速放慢: 运输时间按 (1/w)^0.4 温和放大
  function travelFactor() { return Math.pow(1 / Math.max(0.3, state.weather), 0.4); }
  function buildModel() {
    var tf = travelFactor();
    return {
      travelToYardMin: +state.travelToYardMin * tf,
      travelBackMin: +state.travelBackMin * tf,
      lines: state.lines.map(function (l) {
        return {
          id: l.id, remaining: Math.max(0, +l.remaining),
          effectiveCraneRate: effectiveRate(l),
          down: !!l.down, yardId: l.yardId, trucks: +l.trucks | 0
        };
      }),
      yards: (function () {
        var o = {};
        state.yards.forEach(function (y) { o[y.id] = { rate: +y.rate, capacity: +y.capacity }; });
        return o;
      })()
    };
  }
  function fingerprint() {
    return hashStr(JSON.stringify({
      w: +state.weather.toFixed(3),
      t: [+state.travelToYardMin, +state.travelBackMin],
      l: state.lines.map(function (l) {
        return [l.id, l.remaining.toFixed(1), l.craneRate, l.trucks, l.down, l.yardId,
          l.calib && l.calibSig === calibBasisFp() ? +l.calib.factor.toFixed(3) : null];
      }),
      y: state.yards.map(function (y) { return [y.id, y.rate, y.capacity]; })
    }));
  }
  function hashStr(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return 'h' + (h >>> 0).toString(36) + str.length.toString(36);
  }
  var currentFp = fingerprint();

  function isStale() { return !state.cache || state.cache.fingerprint !== currentFp; }

  function markChanged() {
    currentFp = fingerprint();
    saveState();
    updateStaleBar();
  }
  function updateStaleBar() {
    $('staleBar').classList.toggle('hidden', !isStale());
    $('btnRecalc').textContent = isStale() ? '重新估算 *' : '重新估算';
  }

  // ---------------- 异步分块估算(不卡页面) ----------------
  var calcToken = 0;
  function runEstimate(opts, done) {
    var model = buildModel();
    var reps = opts && opts.reps || 40;
    var horizon = SIM.adaptiveHorizon(model);
    var token = ++calcToken;
    $('calcBar').classList.remove('hidden');
    $('staleBar').classList.add('hidden');

    // 复用 estimate 内部循环会同步跑完; 这里手动按副本分块
    var runs = [], idx = 0;
    var baseSeed = 20260921;
    function chunk() {
      if (token !== calcToken) return;
      var t0 = performance.now();
      while (idx < reps && performance.now() - t0 < 40) {
        runs.push(SIM.oneRun(model, { seed: baseSeed + idx * 7919, horizonMin: horizon, sampleEveryMin: 15 }));
        idx++;
      }
      $('calcText').textContent = '仿真计算中… ' + Math.round(100 * idx / reps) + '%';
      if (idx < reps) { setTimeout(chunk, 0); return; }

      var result = aggregate(model, runs, horizon);
      if (token !== calcToken) return;
      $('calcBar').classList.add('hidden');
      if (done) done(result);
    }
    chunk();
  }

  function avg(values) { return values.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, values.length); }
  function quant(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    return {
      p10: s[Math.round(0.1 * (s.length - 1))],
      p50: s[Math.round(0.5 * (s.length - 1))],
      p90: s[Math.round(0.9 * (s.length - 1))]
    };
  }
  function avgCurve(runs, get) {
    var grid = runs[0].samples.map(function (s) { return s.t; });
    var values = grid.map(function (_, gi) {
      return avg(runs.map(function (r) { var s = r.samples[gi]; return s ? get(s) : 0; }));
    });
    return { grid: grid, values: values };
  }

  function aggregate(model, runs, horizon) {
    var perLine = {}, perYard = {};
    model.lines.forEach(function (ln, ix) {
      var fin = runs.map(function (r) { return r.perLine[ix].finishMin; }).filter(function (v) { return v != null; });
      perLine[ln.id] = {
        finish: fin.length ? quant(fin) : null,
        unfinishedFrac: (runs.length - fin.length) / runs.length,
        craneUtil: avg(runs.map(function (r) { return r.perLine[ix].craneUtil; })),
        starvation: avg(runs.map(function (r) { return r.perLine[ix].starvation; })),
        shoreWaitPerBox: avg(runs.map(function (r) { return r.perLine[ix].shoreWaitPerBox; })),
        shoreAvgQLen: avg(runs.map(function (r) { return r.perLine[ix].shoreAvgQLen; }))
      };
    });
    var yardIds = Object.keys(model.yards);
    yardIds.forEach(function (yid, yi) {
      perYard[yid] = {
        util: avg(runs.map(function (r) { return r.yards[yi].util; })),
        avgQLen: avg(runs.map(function (r) { return r.yards[yi].avgQLen; })),
        waitPerBox: avg(runs.map(function (r) { return r.yards[yi].waitPerBox; }))
      };
    });
    var shore = {}, yardQ = {}, yardBusy = {};
    model.lines.forEach(function (ln) {
      shore[ln.id] = avgCurve(runs, function (s) { return s.shoreQ[ln.id]; });
    });
    yardIds.forEach(function (yid) {
      yardQ[yid] = avgCurve(runs, function (s) { return s.yardN[yid]; });
      yardBusy[yid] = avgCurve(runs, function (s) { return s.yardBusy[yid]; });
    });
    var glob = runs.map(function (r) {
      var mx = 0, ok = true;
      r.perLine.forEach(function (pl) {
        if (pl.finishMin == null) ok = false; else if (pl.finishMin > mx) mx = pl.finishMin;
      });
      return ok ? mx : null;
    }).filter(function (v) { return v != null; });

    return {
      at: Date.now(), reps: runs.length, horizonMin: horizon,
      perLine: perLine, perYard: perYard,
      curves: {
        total: avgCurve(runs, function (s) { return s.deliveredTotal; }),
        shore: shore, yardQ: yardQ, yardBusy: yardBusy
      },
      globalFinish: glob.length ? quant(glob) : null,
      globalUnfinished: (runs.length - glob.length) / runs.length
    };
  }

  // ---------------- 渲染 ----------------
  function colorFor(level) { return level >= 2 ? 'bad' : level === 1 ? 'warn' : 'good'; }
  function fmtH(min) {
    if (min == null || !isFinite(min)) return '–';
    var h = min / 60;
    if (h >= 200) return '>' + Math.round(h) + 'h';
    return h >= 10 ? Math.round(h) + 'h' : h.toFixed(1) + 'h';
  }
  function rngText(q) {
    if (!q) return '窗口内估不完';
    return fmtH(q.p10) + '–' + fmtH(q.p90);
  }

  function renderLines() {
    var box = $('lineList');
    box.innerHTML = '';
    var r = state.cache && state.cache.fingerprint === currentFp ? state.cache.result : null;
    state.lines.forEach(function (ln, idx) {
      var card = document.createElement('div');
      card.className = 'line-card' + (ln.down ? ' down' : '');
      var pr = r ? r.perLine[ln.id] : null;
      var eff = effectiveRate(ln);
      var starLvl = pr ? (pr.starvation >= 0.35 ? 2 : pr.starvation >= 0.18 ? 1 : 0) : 0;
      var shoreLvl = pr ? (pr.shoreWaitPerBox >= 10 ? 2 : pr.shoreWaitPerBox >= 5 ? 1 : 0) : 0;
      var donePct = 0;
      card.innerHTML =
        '<div class="lc-head"><div class="lc-name"><span class="dot ' + (ln.down ? 'off' : '') + '"></span>' +
        '<span class="ed-name">' + esc(ln.name) + '</span>' +
        '<span class="lc-tag">' + esc(ln.yardId) + '区</span>' +
        (ln.calib ? '<span class="lc-tag" title="已按实际数据修正过">已修正</span>' : '') +
        '</div>' +
        '<button class="small" data-act="toggle">'+(ln.down?'恢复':'故障')+'</button></div>' +
        '<div class="lc-grid">' +
        fld('岸桥速度 箱/h', 'crane', ln.craneRate, ln.down) +
        fld('剩余箱量', 'rem', ln.remaining, ln.down) +
        fld('可用集卡 台', 'truck', ln.trucks, ln.down) +
        '<div class="field"><label>所属堆场</label>' +
        '<select data-f="yardId" ' + (ln.down ? 'disabled' : '') + '>' +
        state.yards.map(function (y) {
          return '<option value="' + y.id + '"' + (y.id === ln.yardId ? ' selected' : '') + '>' + esc(y.name) + '</option>';
        }).join('') + '</select></div></div>' +
        '<div class="lc-bar"><i style="width:' + donePct + '%"></i></div>' +
        '<div class="lc-result">' +
        metric('完工用时(中位)', pr ? fmtH(pr.finish && pr.finish.p50) : '—') +
        metric('可能区间', pr ? rngText(pr.finish) : '—') +
        metric('岸桥利用率', pr ? Math.round(pr.craneUtil * 100) + '%' : '—',
          pr ? colorFor(pr.craneUtil < 0.55 ? 2 : pr.craneUtil < 0.8 ? 1 : 0) : '') +
        metric('岸桥等车', pr ? Math.round(pr.starvation * 100) + '%' : '—',
          pr ? colorFor(starLvl) : '') +
        metric('岸边等待/箱', pr ? pr.shoreWaitPerBox.toFixed(1) + ' 分' : '—',
          pr ? colorFor(shoreLvl) : '') +
        metric('岸边均车数', pr ? pr.shoreAvgQLen.toFixed(1) : '—',
          pr ? colorFor(shoreLvl) : '') +
        '</div>' +
        '<div class="lc-actions">' +
        '<button class="small" data-act="calib">填报实际进度</button>' +
        '<button class="small" data-act="rename">改名</button>' +
        '<button class="small danger-link" data-act="del" ' + (state.lines.length <= 1 ? 'disabled' : '') + '>删线</button>' +
        '</div>' +
        (eff !== ln.craneRate ? '<div class="tag-row"><span class="tag warn">有效速度 ' + eff.toFixed(1) + ' 箱/h（天气/修正后）</span></div>' : '') +
        (ln.down ? '<div class="tag-row"><span class="tag bad">岸桥停用中，' + ln.trucks + ' 台车待分流</span></div>' : '');

      card.querySelectorAll('[data-f]').forEach(function (el) {
        el.addEventListener('change', function () {
          var f = el.getAttribute('data-f');
          if (f === 'yardId') { ln.yardId = el.value; }
          else {
            var v = parseFloat(el.value);
            if (!isFinite(v) || v < 0) v = 0;
            if (f === 'crane') ln.craneRate = Math.max(1, v);
            if (f === 'rem') ln.remaining = v;
            if (f === 'truck') ln.trucks = Math.max(0, Math.round(v));
          }
          markChanged(); renderAll();
        });
      });
      card.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          if (act === 'toggle') toggleBreakdown(ln);
          if (act === 'calib') openCalib(ln);
          if (act === 'rename') renameLine(ln);
          if (act === 'del') { state.lines.splice(state.lines.indexOf(ln), 1); markChanged(); renderAll(); }
        });
      });
      box.appendChild(card);
    });
  }

  function fld(label, key, val, disabled) {
    return '<div class="field"><label>' + label + '</label>' +
      '<input type="number" min="0" step="any" value="' + val + '" data-f="' + key + '"' +
      (disabled ? ' disabled' : '') + '></div>';
  }
  function metric(k, v, cls) {
    return '<div class="metric"><span class="k">' + k + '</span><span class="v ' + (cls || '') + '">' + v + '</span></div>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }

  function renderYards() {
    var box = $('yardList');
    box.innerHTML = '';
    var r = state.cache && state.cache.fingerprint === currentFp ? state.cache.result : null;
    state.yards.forEach(function (yd) {
      var pr = r ? r.perYard[yd.id] : null;
      var card = document.createElement('div');
      card.className = 'yard-card';
      var lvl = pr ? (pr.util >= 0.9 || pr.avgQLen >= yd.capacity ? 2 : pr.util >= 0.75 || pr.avgQLen >= yd.capacity * 0.5 ? 1 : 0) : 0;
      card.innerHTML =
        '<div class="yard-head"><span>' + esc(yd.name) + '</span>' +
        '<span class="v ' + (pr ? colorFor(lvl) : '') + '">' + (pr ? Math.round(pr.util * 100) + '% 占用' : '—') + '</span></div>' +
        '<div class="lc-grid">' +
        '<div class="field"><label>卸箱速度 箱/h</label><input type="number" value="' + yd.rate + '" data-yf="rate" min="1"></div>' +
        '<div class="field"><label>并行设备 台</label><input type="number" value="' + yd.capacity + '" data-yf="cap" min="1"></div>' +
        '</div>' +
        '<div class="lc-result">' +
        metric('在场均车数', pr ? pr.avgQLen.toFixed(1) + ' / ' + yd.capacity : '—', pr ? colorFor(lvl) : '') +
        metric('堆场等待/箱', pr ? pr.waitPerBox.toFixed(1) + ' 分' : '—', pr ? colorFor(lvl) : '') +
        '</div>';
      card.querySelectorAll('[data-yf]').forEach(function (el) {
        el.addEventListener('change', function () {
          var v = Math.max(1, parseFloat(el.value) || 1);
          if (el.getAttribute('data-yf') === 'rate') yd.rate = v; else yd.capacity = Math.round(v);
          markChanged(); renderAll();
        });
      });
      box.appendChild(card);
    });

    // 高级参数面板
    var adv = $('advPanel');
    adv.innerHTML =
      '<div class="adv-row"><div class="field"><label>去程运输(分/趟)</label><input id="advGo" type="number" value="' + state.travelToYardMin + '" min="1"></div>' +
      '<div class="field"><label>返程运输(分/趟)</label><input id="advBack" type="number" value="' + state.travelBackMin + '" min="1"></div></div>' +
      (() => { var tff = travelFactor(); return '<div class="tag-row"><span class="tag">当前天气下实际单程约 ' +
        (state.travelToYardMin * tff).toFixed(1) + ' / ' + (state.travelBackMin * tff).toFixed(1) + ' 分钟</span></div>'; })();
    $('advGo').addEventListener('change', function (e) {
      state.travelToYardMin = Math.max(0.5, +e.target.value || 8); markChanged(); renderCharts();
    });
    $('advBack').addEventListener('change', function (e) {
      state.travelBackMin = Math.max(0.5, +e.target.value || 8); markChanged(); renderCharts();
    });
  }

  function renderKpis() {
    var r = state.cache && state.cache.fingerprint === currentFp ? state.cache.result : null;
    var active = state.lines.filter(function (l) { return !l.down; });
    $('kpiTrucks').textContent = totalTrucks() + ' 台';
    var downTrucks = state.lines.filter(function (l) { return l.down; }).reduce(function (a, l) { return a + l.trucks; }, 0);
    $('kpiTrucksSub').textContent = active.length + ' 条作业线' + (downTrucks ? '；故障线挂起 ' + downTrucks + ' 台未分' : '');

    if (!r) {
      ['kpiStarve', 'kpiShore', 'kpiYard', 'kpiFinish'].forEach(function (id) {
        $(id).textContent = '–'; $(id).className = 'strip-val';
      });
      $('kpiStarveSub').textContent = $('kpiShoreSub').textContent = $('kpiYardSub').textContent = $('kpiFinishSub').textContent = '';
      $('kpiVersion').textContent = isStale() ? '条件已改·待重算' : '未估算';
      return;
    }

    // 车太少: 饥饿率最高的线
    var worst = active.map(function (l) { return { l: l, p: r.perLine[l.id] }; })
      .filter(function (x) { return x.p; })
      .sort(function (a, b) { return b.p.starvation - a.p.starvation; })[0];
    if (worst) {
      var sl = worst.p.starvation >= 0.35 ? 2 : worst.p.starvation >= 0.18 ? 1 : 0;
      $('kpiStarve').textContent = worst.l.name;
      $('kpiStarve').className = 'strip-val ' + colorFor(sl);
      $('kpiStarveSub').textContent = '岸桥 ' + Math.round(worst.p.starvation * 100) + '% 时间在等车，车最先不够';
    }
    // 岸边等待最高
    var ws = active.map(function (l) { return { l: l, p: r.perLine[l.id] }; })
      .sort(function (a, b) { return b.p.shoreWaitPerBox - a.p.shoreWaitPerBox; })[0];
    var wl = ws.p.shoreWaitPerBox >= 10 ? 2 : ws.p.shoreWaitPerBox >= 5 ? 1 : 0;
    $('kpiShore').textContent = ws.p.shoreWaitPerBox.toFixed(1) + ' 分/箱';
    $('kpiShore').className = 'strip-val ' + colorFor(wl);
    $('kpiShoreSub').textContent = ws.l.name + ' 最严重（岸前约 ' + ws.p.shoreAvgQLen.toFixed(1) + ' 台车）';

    // 堆场最堵
    var yy = state.yards.map(function (y) { return { y: y, p: r.perYard[y.id] }; })
      .sort(function (a, b) { return b.p.avgQLen - a.p.avgQLen; })[0];
    var yl = yy.p.util >= 0.9 || yy.p.avgQLen >= yy.y.capacity ? 2 : yy.p.util >= 0.75 ? 1 : 0;
    $('kpiYard').textContent = yy.y.name;
    $('kpiYard').className = 'strip-val ' + colorFor(yl);
    $('kpiYardSub').textContent = Math.round(yy.p.util * 100) + '% 占用，场均 ' + yy.p.avgQLen.toFixed(1) + ' 车等待';

    // 整体完工
    if (r.globalFinish) {
      var remainBoxes = state.lines.reduce(function (a, l) { return a + +l.remaining; }, 0);
      $('kpiFinish').textContent = fmtH(r.globalFinish.p50);
      $('kpiFinish').className = 'strip-val';
      $('kpiFinishSub').textContent = '区间 ' + fmtH(r.globalFinish.p10) + '–' + fmtH(r.globalFinish.p90) +
        '，剩余约 ' + Math.round(remainBoxes) + ' 箱';
    } else {
      $('kpiFinish').textContent = '>' + fmtH(r.horizonMin);
      $('kpiFinish').className = 'strip-val bad';
      $('kpiFinishSub').textContent = '观察窗内无法完工';
    }
    var d = new Date(r.at);
    $('kpiVersion').textContent = 'v' + state.seq + ' · ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) +
      ':' + ('0' + d.getSeconds()).slice(-2) + ' · ' + r.reps + ' 次模拟';
  }

  // ---------------- 图表 ----------------
  function renderCharts() {
    var r = state.cache && state.cache.fingerprint === currentFp ? state.cache.result : null;
    var colors = Charts.PALETTE;
    if (r) {
      var totalTarget = state.lines.reduce(function (a, l) { return a + +l.remaining; }, 0);
      Charts.multi($('totalChart'), [{
        name: '累计落地箱量', grid: r.curves.total.grid, values: r.curves.total.values,
        color: '#38b6a7', fill: true
      }], {
        maxY: Math.max(totalTarget, 1),
        yFmt: function (v) { return Math.round(v); }
      });
      Charts.multi($('shoreChart'),
        state.lines.map(function (l, i) {
          var c = r.curves.shore[l.id];
          return { name: l.name, grid: c.grid, values: c.values, color: colors[i % colors.length] };
        }), { yFmt: function (v) { return v.toFixed(0); }, threshold: { value: 6, color: '#ef5f6b' } });

      Charts.multi($('yardChart'),
        state.yards.map(function (y, i) {
          var c = r.curves.yardQ[y.id];
          return { name: y.name + '(在场车数)', grid: c.grid, values: c.values, color: colors[i % colors.length] };
        }).concat(state.yards.map(function (y, i) {
          var c = r.curves.yardBusy[y.id];
          return { name: y.name + '(忙)', grid: c.grid, values: c.values, color: colors[i % colors.length], dashed: true };
        })), { yFmt: function (v) { return v.toFixed(0); }, threshold: { value: 0, color: '#0000' } });
    } else {
      [$('totalChart'), $('shoreChart'), $('yardChart')].forEach(function (cv) {
        Charts.multi(cv, [], {});
      });
    }

    // ETA 列表
    var eta = $('lineEtaList');
    eta.innerHTML = '';
    if (r) {
      state.lines.forEach(function (l, i) {
        var p = r.perLine[l.id];
        var row = document.createElement('div');
        row.className = 'eta-row';
        row.innerHTML = '<span class="nm"><span class="dot ' + (l.down ? 'off' : '') + '" style="background:' +
          (l.down ? '#667' : colors[i % colors.length]) + '"></span>' + esc(l.name) +
          (l.down ? '（停用）' : '') + '</span>' +
          '<span class="tm">' + (p.finish ? fmtH(p.finish.p50) : '窗口内估不完') +
          '<span class="rng">' + (p.finish ? fmtH(p.finish.p10) + '–' + fmtH(p.finish.p90) : '') + '</span></span>';
        eta.appendChild(row);
      });
    }
  }

  function renderAll() {
    renderLines(); renderYards(); renderKpis(); renderCharts();
  }

  // ---------------- 方案评估工具 ----------------
  function cloneLines() { return state.lines.map(function (l) { return Object.assign({}, l); }); }
  function scenarioModel(lines) {
    var tf2 = travelFactor();
    return {
      travelToYardMin: +state.travelToYardMin * tf2,
      travelBackMin: +state.travelBackMin * tf2,
      lines: lines.filter(function (l) { return !l.down; }).map(function (l) {
        var base = l.craneRate * state.weather;
        if (l.calib) base *= l.calib.factor;
        return { id: l.id, remaining: +l.remaining, effectiveCraneRate: base,
          down: false, yardId: l.yardId, trucks: +l.trucks | 0 };
      }),
      yards: (function () {
        var o = {}; state.yards.forEach(function (y) { o[y.id] = { rate: +y.rate, capacity: +y.capacity }; }); return o;
      })()
    };
  }
  function evalScenario(lines, reps) {
    return SIM.estimate(scenarioModel(lines), { reps: reps || 16 });
  }
  function globalP50(res) { return res.globalFinish ? res.globalFinish.p50 : null; }
  function lineP50(res, id) {
    var p = res.perLine[id];
    return p && p.finish ? p.finish.p50 : null;
  }

  // ---------------- 通用弹窗 ----------------
  function openModal(html, wide) {
    var root = $('modalRoot');
    root.innerHTML = '<div class="modal-mask"><div class="modal' + (wide ? ' wide' : '') + '">' + html + '</div></div>';
    root.querySelector('.modal-mask').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });
    return root.querySelector('.modal');
  }
  function closeModal() { $('modalRoot').innerHTML = ''; }

  // ---------------- 岸桥故障 / 恢复分车 ----------------
  function toggleBreakdown(ln) {
    if (!ln.down) {
      ln.down = true;
      markChanged(); renderAll();
      openBreakdownPlan(ln);   // 立即提示分车
    } else {
      ln.down = false;
      markChanged(); renderAll();
    }
  }

  function openBreakdownPlan(downLine) {
    var others = state.lines.filter(function (l) { return l.id !== downLine.id && !l.down; });
    var free = +downLine.trucks | 0;
    var m = openModal(
      '<h3>' + esc(downLine.name) + ' 岸桥故障 —— ' + free + ' 台集卡分流</h3>' +
      '<div class="m-sub">分过去的车会让接收线岸边更挤、堆场更堵，拖慢其它线。每个方案都按<strong>全网</strong>重算。</div>' +
      '<div id="planBox"><div class="calc-bar" style="display:flex;gap:9px"><div class="spinner"></div>评估分流方案…</div></div>' +
      '<div class="modal-foot"><button id="mCancel">暂不分车（保留在故障线）</button></div>', true);

    m.querySelector('#mCancel').onclick = function () { closeModal(); };

    setTimeout(function () {
      var plans = breakdownPlans(downLine, others, free);
      var box = m.querySelector('#planBox');
      box.innerHTML = plans.map(function (p, i) {
        return planHtml(p, i, function () {
          applyAlloc(downLine, p.alloc, true);
          closeModal();
        });
      }).join('');
      box.querySelectorAll('.plan').forEach(function (el, i) {
        el.onclick = function () {
          var alloc = plans[i].alloc;
          state.lines.forEach(function (l) { if (alloc[l.id]) l.trucks += alloc[l.id]; });
          downLine.trucks = 0;
          closeModal(); markChanged(); renderAll(); doRecalc();
        };
      });
    }, 30);
  }



  // 边际增益: 给某线 +1 车, 观察窗内全网吞吐总增量(箱/h), 含堆场联动
  function marginalGain(baseLines, addId, horizonMin) {
    var a = baseLines.map(function (l) { return Object.assign({}, l); });
    var b = baseLines.map(function (l) { return Object.assign({}, l, { trucks: l.trucks + (l.id === addId ? 1 : 0) }); });
    var ta = throughputOf(a, horizonMin), tb = throughputOf(b, horizonMin);
    var ga = 0, gb = 0;
    Object.keys(ta).forEach(function (k) { ga += ta[k]; });
    Object.keys(tb).forEach(function (k) { gb += tb[k]; });
    return { gain: gb - ga, tb: tb };
  }
  function throughputOf(lines, horizonMin) {
    var maxRem = lines.reduce(function (a, l) { return Math.max(a, +l.remaining); }, 0);
    var h = horizonMin || Math.min(180, Math.max(60, maxRem / 30 * 60 + 30));
    var model = scenarioModel(lines);
    // 强制观察窗足够短: 每线剩余量缩放到观察窗
    model.lines.forEach(function (l) { l.remaining = 1e6; });
    return SIM.throughputMap(model, h, 10);
  }

  // 贪心: 每台车分给当前边际增益最大的线
  function greedyAlloc(baseLines, free, candidates) {
    var work = baseLines.map(function (l) { return Object.assign({}, l); });
    var alloc = {}; candidates.forEach(function (l) { alloc[l.id] = 0; });
    var h = (function () {
      var maxRem = work.reduce(function (a, l) { return Math.max(a, +l.remaining); }, 0);
      return Math.min(180, Math.max(60, maxRem / 30 * 60 + 30));
    })();
    for (var i = 0; i < free; i++) {
      var best = null, bestGain = -1e9;
      candidates.forEach(function (l) {
        var g = marginalGain(work, l.id, h).gain;
        if (g > bestGain) { bestGain = g; best = l; }
      });
      if (!best || bestGain <= 0.001) {
        // 再加车已无收益 -> 给当前车最少的线, 别都堆着
        best = candidates.slice().sort(function (a, b) { return a.trucks - b.trucks; })[0];
      }
      work.forEach(function (l) { if (l.id === best.id) l.trucks++; });
      alloc[best.id]++;
    }
    return alloc;
  }

  function evenAlloc(free, candidates) {
    var alloc = {}; candidates.forEach(function (l) { alloc[l.id] = 0; });
    var order = candidates.slice().sort(function (a, b) { return a.trucks - b.trucks; });
    for (var i = 0; i < free; i++) {
      var c = order[i % order.length];
      alloc[c.id]++;
      order.sort(function (a, b) { return (a.trucks + alloc[a.id]) - (b.trucks + alloc[b.id]); });
    }
    return alloc;
  }

  function breakdownPlans(downLine, others, free) {
    var base = state.lines.filter(function (l) { return l.id !== downLine.id && !l.down; });
    var baseRes = evalScenario(base, 16);
    var baseGlobal = globalP50(baseRes);

    // 方案1 贪心保吞吐
    var alloc1 = greedyAlloc(base, free, others);
    // 方案2 平均分
    var alloc2 = evenAlloc(free, others);
    // 方案3 集中给饥饿最重的一条
    var hungry = others.map(function (l) {
      return { l: l, s: baseRes.perLine[l.id] ? baseRes.perLine[l.id].starvation : 0 };
    }).sort(function (a, b) { return b.s - a.s; })[0].l;
    var alloc3 = {}; others.forEach(function (l) { alloc3[l.id] = 0; }); alloc3[hungry.id] = free;

    return [planDef('按效率贪心分流（推荐总吞吐最大）', '每台车都分给“再添一台车、全网多干最多箱”的线，自动避开已经堵死的线。',
        alloc1, base, baseRes, baseGlobal, true),
      planDef('平均摊到各线', '不偏不倚按车数摊平，好处是简单公平，代价是总吞吐通常略低。',
        alloc2, base, baseRes, baseGlobal, false),
      planDef('集中补最缺车的线（' + esc(hungry.name) + '）', '优先抢救岸桥等车最久的线，但接收线岸边排队会明显变长。',
        alloc3, base, baseRes, baseGlobal, false)];
  }

  function planDef(title, desc, alloc, baseLines, baseRes, baseGlobal, recommend) {
    var afterLines = baseLines.map(function (l) { return Object.assign({}, l, { trucks: l.trucks + (alloc[l.id] || 0) }); });
    var res = evalScenario(afterLines, 16);
    return {
      title: title, desc: desc, alloc: alloc, res: res, baseRes: baseRes,
      recommend: recommend
    };
  }

  function allocSummary(alloc) {
    return state.lines.filter(function (l) { return alloc[l.id]; })
      .map(function (l) { return esc(l.name) + ' +' + alloc[l.id]; }).join('，') || '不抽/不分';
  }

  function planHtml(p, idx, onClick) {
    var rows = state.lines.filter(function (l) { return !l.down; }).map(function (l) {
      var add = p.alloc[l.id] || 0;
      var before = p.baseRes.perLine[l.id] ? lineP50(p.baseRes, l.id) : null;
      var after = lineP50(p.res, l.id);
      var delta = (before != null && after != null) ? (after - before) : null;
      var dTxt = delta == null ? '—' : (Math.abs(delta) < 3 ? '±0' : (delta > 0 ? '+' + fmtH(delta) : '−' + fmtH(-delta)));
      var dCls = delta == null ? '' : delta > 3 ? 'bad' : delta < -3 ? 'good' : '';
      return '<tr><td>' + esc(l.name) + '</td><td>' + l.trucks + ' → ' + (l.trucks + add) +
        '</td><td>' + (before != null ? fmtH(before) : '—') + '</td><td>' + (after != null ? fmtH(after) : '估不完') +
        '</td><td class="' + dCls + '">' + dTxt + '</td></tr>';
    }).join('');
    var bg = p.baseGlobal, ag = globalP50(p.res);
    var gDelta = (bg != null && ag != null) ? (ag - bg) : null;
    var gTxt = gDelta == null ? (ag != null ? fmtH(ag) : '估不完') : fmtH(ag) +
      '（' + (Math.abs(gDelta) < 3 ? '基本不变' : (gDelta > 0 ? '慢 ' + fmtH(gDelta) : '快 ' + fmtH(-gDelta))) + '）';
    return '<div class="plan' + (p.recommend ? ' recommend' : '') + '" data-i="' + idx + '">' +
      '<h4>方案 ' + (idx + 1) + '：' + p.title + (p.recommend ? '<span class="badge">推荐</span>' : '') + '</h4>' +
      '<div class="desc">' + p.desc + '</div>' +
      '<table><tr><th>作业线</th><th>集卡(台)</th><th>原完工</th><th>方案后完工</th><th>变化</th></tr>' + rows + '</table>' +
      '<div class="desc" style="margin-top:7px">分车：' + allocSummary(p.alloc) +
      '；<b>全网全部完工 ' + gTxt + '</b>。点击卡片采用此方案。</div></div>';
  }

  // ---------------- 集卡下班 / 车辆数变化 ----------------
  function openOffDuty() {
    var cur = totalTrucks();
    var m = openModal(
      '<h3>集卡下班 —— 调整在用车辆总数</h3>' +
      '<div class="m-sub">车辆变少后各方案按全网重算：被撤车的线会先饿肚子，多余车撤回车队。当前在网 <b>' + cur + '</b> 台。</div>' +
      '<div class="form-grid"><div class="field"><label>下班/变化后在网总数（台）</label>' +
      '<input id="newTotal" type="number" min="0" value="' + Math.max(0, cur - 4) + '"></div></div>' +
      '<div id="planBox" style="margin-top:12px"><div class="m-sub">改数字后点“评估”。</div></div>' +
      '<div class="modal-foot"><button id="mEval" class="primary">评估方案</button><button id="mCancel">取消</button></div>', true);
    m.querySelector('#mCancel').onclick = closeModal;
    m.querySelector('#mEval').onclick = function () {
      var target = Math.max(0, parseInt(m.querySelector('#newTotal').value, 10) || 0);
      var diff = target - cur;
      if (diff === 0) { alert('总数没有变化'); return; }
      renderOffPlans(m, target, diff);
    };
    m.querySelector('#newTotal').addEventListener('keydown', function (e) { if (e.key === 'Enter') m.querySelector('#mEval').click(); });
  }

  function renderOffPlans(m, target, diff) {
    var box = m.querySelector('#planBox');
    box.innerHTML = '<div style="display:flex;gap:9px;align-items:center;color:#8ba0b6"><div class="spinner"></div>重算中…</div>';
    setTimeout(function () {
      var active = state.lines.filter(function (l) { return !l.down; });
      var baseRes = evalScenario(active, 16);
      var plans;
      if (diff < 0) {
        var remove = -diff;
        var a1 = greedyRemoval(active, remove);           // {id: 减量}
        var a2 = proportionalRemoval(active, remove);
        plans = [
          offDef('按损失最小撤车（推荐保总吞吐）', '每台都从“少一台车、全网少干最少箱”的线撤，优先撤掉拥堵排队的冗余车。', a1, baseRes, true, true),
          offDef('按现有比例均衡缩减', '各线大致按比例减车，撤完后各线松紧度接近。', a2, baseRes, false, true)];
      } else {
        var add = diff;
        var g1 = greedyAlloc(active, add, active);
        var g2 = evenAlloc(add, active);
        plans = [
          offDef('按增益最大加车（推荐）', '新车投给再添一台最能出箱的线。', g1, baseRes, true, false),
          offDef('平均摊到各线', '各线车数尽量拉平。', g2, baseRes, false, false)];
      }
      box.innerHTML = plans.map(function (p, i) {
        var sign = diff < 0 ? ' −' : ' +';
        var fakeAlloc = {};
        state.lines.forEach(function (l) { fakeAlloc[l.id] = diff < 0 ? 0 : (p.alloc[l.id] || 0); });
        // 直接用自定义行渲染
        var rows = state.lines.filter(function (l) { return !l.down; }).map(function (l) {
          var d = p.alloc[l.id] || 0;
          var before = lineP50(p.baseRes, l.id), after = lineP50(p.res, l.id);
          var delta = (before != null && after != null) ? after - before : null;
          var dTxt = delta == null ? '—' : (Math.abs(delta) < 3 ? '±0' : (delta > 0 ? '+' + fmtH(delta) : '−' + fmtH(-delta)));
          var dCls = delta == null ? '' : delta > 3 ? 'bad' : delta < -3 ? 'good' : '';
          return '<tr><td>' + esc(l.name) + '</td><td>' + l.trucks + ' → ' +
            (l.trucks + (diff < 0 ? -d : d)) + '</td><td>' + (before != null ? fmtH(before) : '—') +
            '</td><td>' + (after != null ? fmtH(after) : '估不完') + '</td><td class="' + dCls + '">' + dTxt + '</td></tr>';
        }).join('');
        var bg = globalP50(p.baseRes), ag = globalP50(p.res);
        var gTxt = ag != null ? fmtH(ag) + ((bg != null && Math.abs(ag - bg) >= 3) ? ('（' + (ag > bg ? '慢 ' + fmtH(ag - bg) : '快 ' + fmtH(bg - ag)) + '）') : '（基本不变）') : '估不完';
        return '<div class="plan' + (p.recommend ? ' recommend' : '') + '" data-i="' + i + '">' +
          '<h4>' + (diff < 0 ? '撤车' : '加车') + '方案 ' + (i + 1) + '：' + p.title +
          (p.recommend ? '<span class="badge">推荐</span>' : '') + '</h4>' +
          '<div class="desc">' + p.desc + '</div>' +
          '<table><tr><th>作业线</th><th>集卡(台)</th><th>原完工</th><th>方案后完工</th><th>变化</th></tr>' + rows + '</table>' +
          '<div class="desc" style="margin-top:7px">全网全部完工：<b>' + gTxt + '</b>。点击卡片采用。</div></div>';
      }).join('');
      box.querySelectorAll('.plan').forEach(function (el, i) {
        el.onclick = function () {
          applyOff(target, plans[i].alloc, diff < 0);
          closeModal(); markChanged(); renderAll(); doRecalc();
        };
      });
    }, 30);
  }

  function applyOff(target, alloc, isRemove) {
    state.lines.forEach(function (l) {
      if (l.down || !alloc[l.id]) return;
      l.trucks = isRemove ? Math.max(0, l.trucks - alloc[l.id]) : l.trucks + alloc[l.id];
    });
  }

  function offDef(title, desc, alloc, baseRes, recommend, isRemove) {
    var active = state.lines.filter(function (l) { return !l.down; });
    var after = active.map(function (l) {
      var d = alloc[l.id] || 0;
      return Object.assign({}, l, { trucks: isRemove ? Math.max(0, l.trucks - d) : l.trucks + d });
    });
    return { title: title, desc: desc, alloc: alloc, baseRes: baseRes, res: evalScenario(after, 16), recommend: recommend };
  }

  // 反复从"少一台损失最小"的线撤车
  function greedyRemoval(activeLines, remove) {
    var work = activeLines.map(function (l) { return Object.assign({}, l); });
    var alloc = {}; work.forEach(function (l) { alloc[l.id] = 0; });
    var h = (function () {
      var maxRem = work.reduce(function (a, l) { return Math.max(a, +l.remaining); }, 0);
      return Math.min(180, Math.max(60, maxRem / 30 * 60 + 30));
    })();
    for (var i = 0; i < remove; i++) {
      var cand = work.filter(function (l) { return l.trucks > 0; });
      if (!cand.length) break;
      var worst = null, worstLoss = 1e18;
      // 撤掉 X 一台的损失 ≈ X 在当前数量下最后一台的边际增益
      cand.forEach(function (l) {
        var minus = work.map(function (x) { return Object.assign({}, x, { trucks: x.trucks - (x.id === l.id ? 1 : 0) }); });
        var loss = marginalGain(minus, l.id, h).gain; // minus 状态下 +1 的增益
        if (loss < worstLoss) { worstLoss = loss; worst = l; }
      });
      work.forEach(function (l) { if (l.id === worst.id) l.trucks--; });
      alloc[worst.id]++;
    }
    return alloc;
  }

  function proportionalRemoval(activeLines, remove) {
    var work = activeLines.map(function (l) { return { id: l.id, trucks: l.trucks }; });
    var alloc = {}; work.forEach(function (l) { alloc[l.id] = 0; });
    for (var i = 0; i < remove; i++) {
      var cand = work.filter(function (l) { return l.trucks > 0; });
      if (!cand.length) break;
      // 撤"当前车数占比超出目标比例最多"的线 -> 结果最均衡
      var totalNow = work.reduce(function (a, l) { return a + Math.max(0, l.trucks); }, 0) || 1;
      var target = cand.slice().sort(function (a, b) {
        return (b.trucks / totalNow) - (a.trucks / totalNow);
      })[0];
      target.trucks--; alloc[target.id]++;
    }
    return alloc;
  }

  // ---------------- 临时加线 + 抽车方案 ----------------
  function openAddLine() {
    var m = openModal(
      '<h3>临时增加一条作业线</h3>' +
      '<div class="m-sub">新线也要车。车只能从现有线抽，被抽的线会变慢；每个抽车方案按全网一起算账。</div>' +
      '<div class="form-grid">' +
      '<div class="field"><label>线名</label><input id="nlName" value="临时' + (state.lines.length + 1) + '号线"></div>' +
      '<div class="field"><label>分配堆场</label><select id="nlYard">' +
        state.yards.map(function (y) { return '<option value="' + y.id + '">' + esc(y.name) + '</option>'; }).join('') +
        '</select></div>' +
      '<div class="field"><label>岸桥速度 箱/h</label><input id="nlRate" type="number" value="24" min="1"></div>' +
      '<div class="field"><label>剩余箱量</label><input id="nlRem" type="number" value="300" min="1"></div>' +
      '<div class="field full"><label>需要集卡（台）</label><input id="nlTrucks" type="number" value="6" min="1"></div>' +
      '</div>' +
      '<div id="planBox" style="margin-top:12px"><div class="m-sub">填好后点“生成抽车方案”。</div></div>' +
      '<div class="modal-foot"><button id="mGen" class="primary">生成抽车方案</button><button id="mCancel">取消</button></div>', true);
    m.querySelector('#mCancel').onclick = closeModal;
    m.querySelector('#mGen').onclick = function () {
      var need = Math.max(1, parseInt(m.querySelector('#nlTrucks').value, 10) || 0);
      renderAddPlans(m, {
        name: m.querySelector('#nlName').value.trim() || '临时线',
        yardId: m.querySelector('#nlYard').value,
        rate: Math.max(1, +m.querySelector('#nlRate').value || 24),
        remaining: Math.max(1, +m.querySelector('#nlRem').value || 1),
        trucks: need
      });
    };
  }

  function renderAddPlans(m, spec) {
    var box = m.querySelector('#planBox');
    box.innerHTML = '<div style="display:flex;gap:9px;align-items:center;color:#8ba0b6"><div class="spinner"></div>抽车方案评估中…</div>';
    setTimeout(function () {
      var active = state.lines.filter(function (l) { return !l.down; });
      var newId = uid('L');
      var newLine = { id: newId, name: spec.name, yardId: spec.yardId, remaining: spec.remaining,
        craneRate: spec.rate, trucks: spec.trucks, down: false, calib: null, calibSig: null };

      function linesWith(drawAlloc) {
        var ex = active.map(function (l) { return Object.assign({}, l, { trucks: l.trucks - (drawAlloc[l.id] || 0) }); });
        var nl = Object.assign({}, newLine);
        return ex.concat(nl);
      }
      // 方案1: 从损失最小的线抽(贪心撤车, 撤够 need 台)
      var d1 = greedyRemoval(active, spec.trucks);
      // 方案2: 平均从各线抽
      var d2 = proportionalRemoval(active, spec.trucks);
      // 方案3: 从最堵(岸边等待最高)的线抽冗余车
      var baseRes = evalScenario(active, 16);
      var d3 = {}; active.forEach(function (l) { d3[l.id] = 0; });
      var congested = active.slice().sort(function (a, b) {
        return baseRes.perLine[b.id].shoreWaitPerBox - baseRes.perLine[a.id].shoreWaitPerBox;
      });
      var left = spec.trucks;
      congested.forEach(function (l) {
        var take = Math.min(Math.max(0, l.trucks - 1), left);
        d3[l.id] = take; left -= take;
      });
      if (left > 0) { // 车不够, 有多少抽多少, 新线少车
        congested.forEach(function (l) {
          if (left <= 0) return;
          var more = Math.min(left, 1);
          d3[l.id] += more; left -= more;
        });
      }

      var defs = [
        addDef('按损失最小抽车（推荐）', '每台都从“少一台、全网少干最少”的线抽，优先抽岸边排队最长的冗余车。', d1),
        addDef('各线平均摊抽', '各线按比例摊，公平但可能同时拖慢所有线。', d2),
        addDef('集中从最堵的线抽', '从当前岸边等待最严重的线抽车，先消化它的车过剩。', d3)];

      var html = defs.map(function (p, i) {
        var rows = state.lines.filter(function (l) { return !l.down; }).map(function (l) {
          var take = p.alloc[l.id] || 0;
          var before = lineP50(baseRes, l.id), after = lineP50(p.res, l.id);
          var delta = (before != null && after != null) ? after - before : null;
          var dTxt = delta == null ? '—' : (Math.abs(delta) < 3 ? '±0' : (delta > 0 ? '+' + fmtH(delta) : '−' + fmtH(-delta)));
          return '<tr><td>' + esc(l.name) + '</td><td>' + l.trucks + ' → ' + (l.trucks - take) +
            '</td><td>' + (before != null ? fmtH(before) : '—') + '</td><td>' +
            (after != null ? fmtH(after) : '估不完') + '</td><td class="' +
            (delta != null && delta > 3 ? 'bad' : delta != null && delta < -3 ? 'good' : '') + '">' + dTxt + '</td></tr>';
        }).join('');
        var nlFinish = lineP50(p.res, newId);
        var ag = globalP50(p.res), bg = globalP50(baseRes);
        var gTxt = ag != null ? fmtH(ag) + ((bg != null && Math.abs(ag - bg) >= 3) ? ('（比现在 ' + (ag > bg ? '慢 ' + fmtH(ag - bg) : '快 ' + fmtH(bg - ag)) + '）') : '（与现在基本持平）') : '估不完';
        return '<div class="plan' + (i === 0 ? ' recommend' : '') + '" data-i="' + i + '">' +
          '<h4>抽车方案 ' + (i + 1) + '：' + p.title + (i === 0 ? '<span class="badge">推荐</span>' : '') + '</h4>' +
          '<div class="desc">' + p.desc + '</div>' +
          '<table><tr><th>现有线</th><th>集卡</th><th>原完工</th><th>抽车后完工</th><th>变化</th></tr>' + rows + '</table>' +
          '<div class="desc" style="margin-top:7px">新线可得 <b>' + (spec.trucks - p.shortfall) + '</b>/' + spec.trucks +
          ' 台，新线完工 ' + (nlFinish != null ? fmtH(nlFinish) : '估不完') +
          '；加线后全网全部完工 <b>' + gTxt + '</b>。点击卡片采用。</div></div>';
      }).join('');
      box.innerHTML = html;
      box.querySelectorAll('.plan').forEach(function (el, i) {
        el.onclick = function () {
          var alloc = defs[i].alloc;
          state.lines.forEach(function (l) { if (alloc[l.id]) l.trucks -= alloc[l.id]; });
          newLine.trucks = spec.trucks - defs[i].shortfall;
          state.lines.push(newLine);
          closeModal(); markChanged(); renderAll(); doRecalc();
        };
      });

      function addDef(title, desc, alloc) {
        var drawn = Object.keys(alloc).reduce(function (a, k) { return a + alloc[k]; }, 0);
        var shortfall = Math.max(0, spec.trucks - drawn);
        var nl2 = Object.assign({}, newLine, { trucks: spec.trucks - shortfall });
        var ex = active.map(function (l) { return Object.assign({}, l, { trucks: l.trucks - (alloc[l.id] || 0) }); });
        return { title: title, desc: desc, alloc: alloc, shortfall: shortfall, res: evalScenario(ex.concat(nl2), 16) };
      }
    }, 30);
  }

  // ---------------- 实际进度修正 ----------------
  function openCalib(ln) {
    var r = state.cache && state.cache.fingerprint === currentFp ? state.cache.result : null;
    var pr = r ? r.perLine[ln.id] : null;
    var delivered = Math.max(0, (ln.remaining && false) ? 0 : 0);
    var m = openModal(
      '<h3>填报实际进度 —— ' + esc(ln.name) + '</h3>' +
      '<div class="m-sub">报实际值只用于<strong>修正后续估算</strong>，历史条件不重来：剩余箱改为真实值，' +
      '并把“实际/估算”的差距折算成岸桥速度修正系数。</div>' +
      '<div class="form-grid">' +
      '<div class="field"><label>当前真实剩余箱量（箱）</label><input id="cRem" type="number" min="0" value="' + ln.remaining + '"></div>' +
      '<div class="field"><label>从估算开始到现在已过去（分钟）</label><input id="cMin" type="number" min="0" value="60"></div>' +
      '<div class="field full"><label>这段时间实际完成箱量（箱，可留空=用原剩余−现剩余）</label><input id="cDone" type="number" min="0"></div>' +
      '</div>' +
      '<div id="cPreview" class="tag-row" style="margin-top:10px"></div>' +
      (ln.calib ? '<div class="m-sub" style="margin-top:8px">当前修正系数 ×' + ln.calib.factor.toFixed(2) +
        '；重新填报会以当前实际为准重新计算。</div>' : '') +
      '<div class="modal-foot"><button id="mSave" class="primary">保存并修正后续估算</button><button id="mCancel">取消</button></div>');

    function preview() {
      var remNow = Math.max(0, +m.querySelector('#cRem').value || 0);
      var mins = Math.max(0, +m.querySelector('#cMin').value || 0);
      var doneFld = m.querySelector('#cDone').value;
      var actualDone = doneFld === '' ? Math.max(0, ln.remaining - remNow) : Math.max(0, +doneFld || 0);
      var pv = m.querySelector('#cPreview');
      if (!pr || mins <= 0 || actualDone <= 0) {
        pv.innerHTML = '<span class="tag warn">填入已过去时间和实际完成量后显示修正系数</span>';
        return { remNow: remNow, factor: null };
      }
      // 估算同期应完成: 用累计曲线在 mins 处的落地速率近似 -> 直接用岸桥利用率×名义速度×时间
      var effNominal = effectiveRate(ln);
      var expRate = effNominal * pr.craneUtil;          // 箱/小时, 已含等车
      var expDone = expRate * (mins / 60);
      var factor = Math.max(0.4, Math.min(1.8, actualDone / Math.max(1e-6, expDone)));
      pv.innerHTML =
        '<span class="tag ' + (factor < 0.9 ? 'bad' : factor > 1.1 ? 'warn' : 'good') +
        '">同期估算应完成 ' + expDone.toFixed(0) + ' 箱，实际 ' + actualDone +
        ' 箱 → 岸桥速度系数 ×' + factor.toFixed(2) + '</span>' +
        '<span class="tag">修正后有效速度 ' + (effNominal * factor).toFixed(1) + ' 箱/h</span>';
      return { remNow: remNow, factor: factor, mins: mins, actualDone: actualDone, expDone: expDone };
    }
    m.querySelector('#cRem').addEventListener('input', preview);
    m.querySelector('#cMin').addEventListener('input', preview);
    m.querySelector('#cDone').addEventListener('input', preview);
    preview();
    m.querySelector('#mCancel').onclick = closeModal;
    m.querySelector('#mSave').onclick = function () {
      var info = preview();
      ln.remaining = info.remNow;
      if (info.factor != null) {
        ln.calib = {
          factor: +info.factor.toFixed(3),
          at: Date.now(),
          detail: { mins: info.mins, actualDone: info.actualDone, expDone: Math.round(info.expDone) }
        };
        ln.calibSig = calibBasisFp();
      }
      closeModal(); markChanged(); renderAll(); doRecalc();
    };
  }

  function renameLine(ln) {
    var v = prompt('改线名：', ln.name);
    if (v && v.trim()) { ln.name = v.trim(); markChanged(); renderAll(); }
  }

  // ---------------- 重算 ----------------
  function doRecalc() {
    currentFp = fingerprint();
    runEstimate({ reps: 40 }, function (result) {
      state.seq++;
      state.cache = { fingerprint: currentFp, at: Date.now(), result: result };
      state.history.unshift({ seq: state.seq, at: Date.now(), fp: currentFp });
      state.history = state.history.slice(0, 20);
      saveState();
      renderAll(); updateStaleBar();
    });
  }

  function openHelp() {
    openModal(
      '<h3>模型怎么算 · 怎么用</h3>' +
      '<div class="help-body">' +
      '<p><b>它在仿真什么：</b>每条岸桥带着分配给它的集卡跑闭环——岸桥把箱吊上车 → 车开到进口堆场 → 堆场卸箱 → 空车返回。' +
      '岸桥、堆场都是有限服务台，车到了得排队。用 40 次带随机波动的蒙特卡洛仿真（岸桥/堆场服务时间按指数分布，运输±15%抖动）取统计区间。</p>' +
      '<ul>' +
      '<li><b>车太少</b>：岸桥经常没车可装（“岸桥等车”比例高），那条线最先停。</li>' +
      '<li><b>车太多</b>：岸桥利用率接近满，但岸边每箱等待时间变长、岸边车数堆积；若堆场也忙，堆场队列一起涨。</li>' +
      '<li><b>多条线共享堆场</b>：往同一堆场加车会互相挤占卸箱设备，方案评估把这部分拖累一起算进去。</li>' +
      '<li><b>故障分车/下班/加线</b>：弹窗给出 2–3 个分配方案，每个方案都显示各线完工时间变化和全网完工时间，点卡片即采用并重算。</li>' +
      '<li><b>天气/视线</b>：整体下调所有岸桥有效速度，估期随之变长。</li>' +
      '<li><b>填报实际进度</b>：用“实际完成 ÷ 同期估算应完成”修正该线岸桥速度系数（限制在 0.4–1.8），同时更新真实剩余箱；' +
      '之后从当前状态往后估，不从头再来。车数/堆场布局变化后旧系数会被标记为失效，避免误用。</li>' +
      '<li><b>改任何条件</b>：顶部出现“结果已过期”条，旧结论作废，点“重新估算”后才会显示新数。</li>' +
      '<li><b>关闭页面</b>：全部条件（含故障、修正、天气、高级参数、上次结果）存在浏览器本地，再打开自动恢复。</li>' +
      '</ul>' +
      '<p><b>怎么读结果：</b>完工时间给中位和 80% 区间（p10–p90）；百分比颜色：绿≈健康，黄≈偏紧，红≈明显缺车或拥堵。</p>' +
      '</div>' +
      '<div class="modal-foot"><button id="mOk" class="primary">知道了</button></div>');
    $('mOk').onclick = closeModal;
  }

  // ---------------- 绑定 ----------------
  function bind() {
    $('btnRecalc').addEventListener('click', doRecalc);
    $('staleRecalc').addEventListener('click', doRecalc);
    $('btnHelp').addEventListener('click', openHelp);
    $('btnAddLine').addEventListener('click', openAddLine);
    $('btnBreakdown').addEventListener('click', function () {
      var d = state.lines.filter(function (l) { return l.down; })[0];
      if (d) openBreakdownPlan(d);
      else alert('先在某条线点“故障”把它停下，再给它的集卡找去处。');
    });
    $('btnOffDuty').addEventListener('click', openOffDuty);
    $('btnActual').addEventListener('click', function () {
      var l = state.lines[0];
      if (l) openCalib(l);
    });
    $('btnReset').addEventListener('click', function () {
      if (confirm('重置为默认场景？当前所有条件、修正和结果都会清除。')) {
        state = defaultState();
        currentFp = fingerprint();
        saveState(); renderAll(); updateStaleBar(); doRecalc();
      }
    });
    $('btnAdv').addEventListener('click', function () {
      var p = $('advPanel'), b = $('btnAdv');
      p.classList.toggle('hidden');
      b.textContent = p.classList.contains('hidden') ? '▸ 高级参数（运输/堆场/修正系数）' : '▾ 高级参数（运输/堆场/修正系数）';
    });
    $('weatherSel').addEventListener('change', function (e) {
      if (e.target.value === 'custom') {
        var v = prompt('自定义天气系数（0.3–1.0，1.0=良好）：', String(state.weather));
        var f = v == null ? state.weather : Math.max(0.3, Math.min(1, parseFloat(v) || 1));
        state.weather = f;
        e.target.value = 'custom';
      } else {
        state.weather = parseFloat(e.target.value);
      }
      saveState(); markChanged(); renderAll();
    });
    window.addEventListener('resize', function () { renderCharts(); });
  }

  function syncWeatherSelect() {
    var sel = $('weatherSel');
    var known = ['1', '0.9', '0.75', '0.6', '0.45'];
    var v = String(+state.weather.toFixed(2));
    if (known.indexOf(v) >= 0) sel.value = v;
    else sel.value = 'custom';
  }

  // ---------------- 启动 ----------------
  function init() {
    bind();
    syncWeatherSelect();
    renderAll();
    updateStaleBar();
    if (state.cache && state.cache.fingerprint === currentFp) {
      renderAll();   // 直接展示上次结果
    } else {
      doRecalc();    // 首次或条件变了: 自动估算
    }
  }
  init();
})();
