/* 岸桥-集卡 网络离散事件仿真引擎
 * 闭合循环: 岸桥装 -> 水平运输 -> 进口堆场卸 -> 空车返回 -> 岸桥...
 * 车在各节点排队, 天然刻画"车等岸桥 / 岸桥等车 / 岸边排队 / 堆场拥堵";
 * 多条作业线共享岸边通道与堆场, 调一条线的车会牵动全局。
 *
 * 箱计数:
 *   quay[i]  仍在岸边未吊的箱; 岸桥服务结束(吊上车)时 -1
 *   inflight 在途/在堆场的箱; 吊上车 +1, 堆场落地 -1
 *   delivered 已落地箱
 *   quay 清零 -> 该线不再接空车; inflight 清零 -> 该线完工
 */
(function (global) {
  'use strict';

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) {
    var r = mulberry32(seed);
    return {
      next: r,
      exp: function (mean) { var u; do { u = r(); } while (u <= 0); return -mean * Math.log(u); },
      uniform: function (lo, hi) { return lo + (hi - lo) * r(); }
    };
  }

  function Heap() { this.h = []; }
  Heap.prototype.push = function (ev) {
    var h = this.h, i = h.length; h.push(ev);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (h[p].time <= ev.time) break;
      h[i] = h[p]; i = p;
    }
    h[i] = ev;
  };
  Heap.prototype.pop = function () {
    var h = this.h, top = h[0], last = h.pop();
    if (h.length) {
      var i = 0, n = h.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && h[l].time < last.time) m = l;
        if (r < n && h[r].time < (m === i ? last.time : h[m].time)) m = r;
        if (m === i) break;
        h[i] = h[m]; i = m;
      }
      h[i] = last;
    }
    return top;
  };
  Heap.prototype.size = function () { return this.h.length; };

  /* 单次仿真
   * model: {
   *   travelToYardMin, travelBackMin,
   *   lines: [{id, remaining, effectiveCraneRate(箱/小时,已含天气/修正), down, yardId, trucks}],
   *   yards: {id: {rate(箱/小时), capacity(并行服务台数)}}
   * }
   * opts: {seed, horizonMin(给定则只跑到观察窗, 不追求完工), sampleEveryMin}
   */
  function oneRun(model, opts) {
    opts = opts || {};
    var rng = makeRng(opts.seed || 1);
    var lines = model.lines, L = lines.length;
    var yardIds = Object.keys(model.yards);

    var quay = [], inflight = [], delivered = [];
    var lineClosed = [], lineFinishT = [];           // closed=岸边箱已吊完; finish=全落地
    var craneBusy = [], craneServing = [], craneBusyArea = [];
    var shoreQ = [], shoreQArea = [], shoreServed = [];
    var idleArea = [];                                // 岸桥等车(空闲且仍有活)
    var trucksOf = [];

    for (var i = 0; i < L; i++) {
      var rem = Math.max(0, lines[i].remaining);
      var dead0 = !!lines[i].down || lines[i].trucks <= 0 || rem <= 0;
      quay[i] = rem; inflight[i] = 0; delivered[i] = 0;
      lineClosed[i] = dead0; lineFinishT[i] = dead0 ? 0 : null;
      craneBusy[i] = false; craneServing[i] = null;
      craneBusyArea[i] = 0; shoreQArea[i] = 0; shoreServed[i] = 0; idleArea[i] = 0;
      shoreQ[i] = [];
      var arr = [];
      for (var c = 0; c < (lines[i].trucks | 0); c++) {
        var tr = { line: i, stagger: rng.uniform(0, 12 / Math.max(1, lines[i].trucks | 0) + 4) };
        arr.push(tr);
      }
      trucksOf[i] = arr;
    }
    var totalRemaining = quay.reduce(function (a, b) { return a + b; }, 0);

    var yard = {};
    yardIds.forEach(function (yid) {
      var y = model.yards[yid];
      yard[yid] = {
        cap: Math.max(1, y.capacity | 0), rate: y.rate,
        busy: 0, q: [], busyArea: 0, qArea: 0, served: 0, waitSum: 0
      };
    });

    var every = opts.sampleEveryMin || 15;
    var samples = [], nextSample = every;
    function sample(tt) {
      var s = { t: tt, deliveredTotal: 0, shoreQ: {}, yardN: {}, yardBusy: {} };
      for (var si = 0; si < L; si++) {
        s.deliveredTotal += delivered[si];
        s.shoreQ[lines[si].id] = shoreQ[si].length + (craneBusy[si] ? 1 : 0);
      }
      yardIds.forEach(function (yid) {
        var ys = yard[yid];
        s.yardN[yid] = ys.q.length + ys.busy;
        s.yardBusy[yid] = ys.busy;
      });
      samples.push(s);
    }

    var heap = new Heap();
    var t = 0, lastT = 0;
    var horizon = opts.horizonMin || 0;
    var aliveLines = 0;
    for (var a0 = 0; a0 < L; a0++) if (!lineClosed[a0] || inflight[a0] > 0) aliveLines++;

    function accumulate(dt) {
      if (dt <= 0) return;
      for (var k = 0; k < L; k++) {
        var working = !lineClosed[k] || inflight[k] > 0;
        if (working) {
          if (craneBusy[k]) craneBusyArea[k] += dt;
          else if (!lineClosed[k]) idleArea[k] += dt;
        }
        shoreQArea[k] += shoreQ[k].length * dt;
      }
      yardIds.forEach(function (yid) {
        var ys = yard[yid];
        ys.busyArea += ys.busy * dt;
        ys.qArea += ys.q.length * dt;
      });
    }

    function finishLineIfDone(ix, tt) {
      if (lineFinishT[ix] == null && lineClosed[ix] && inflight[ix] === 0) {
        lineFinishT[ix] = tt;
      }
    }

    function startCrane(ix, tt) {
      var truck = shoreQ[ix].shift();
      craneBusy[ix] = true;
      craneServing[ix] = truck;
      var mean = 60 / lines[ix].effectiveCraneRate;
      heap.push({ time: tt + rng.exp(mean), type: 'craneEnd', line: ix, truck: truck });
    }

    // 车到岸桥边
    function arriveShore(ix, truck, tt) {
      if (lineClosed[ix]) return;                 // 岸边没箱了, 该车退出
      if (!craneBusy[ix]) startCrane(ix, tt);
      else shoreQ[ix].push(truck);
    }

    // 岸桥把箱吊上车
    function craneEnd(ix, truck, tt) {
      craneBusy[ix] = false; craneServing[ix] = null;
      quay[ix] -= 1; inflight[ix] += 1; shoreServed[ix] += 1;
      if (quay[ix] <= 0) {
        lineClosed[ix] = true;
        shoreQ[ix].length = 0;                    // 队里等的车白等, 退出
      }
      heap.push({ time: tt + rng.uniform(0.85, 1.15) * model.travelToYardMin,
                  type: 'arriveYard', line: ix, truck: truck });
      if (!lineClosed[ix] && shoreQ[ix].length) startCrane(ix, tt);
    }

    // 重车到堆场
    function arriveYard(ix, truck, tt) {
      var yid = lines[ix].yardId, ys = yard[yid];
      if (ys.busy < ys.cap) {
        ys.busy++;
        heap.push({ time: tt + rng.exp(60 / ys.rate), type: 'yardEnd', line: ix, truck: truck });
      } else {
        ys.q.push({ truck: truck, line: ix, since: tt });
      }
    }

    // 堆场卸完一箱
    function yardEnd(ix, truck, tt) {
      var yid = lines[ix].yardId, ys = yard[yid];
      ys.busy--; ys.served++;
      inflight[ix] -= 1; delivered[ix] += 1;
      if (ys.q.length) {
        var head = ys.q.shift();
        ys.waitSum += tt - head.since;
        ys.busy++;
        heap.push({ time: tt + rng.exp(60 / ys.rate), type: 'yardEnd', line: head.line, truck: head.truck });
      }
      finishLineIfDone(ix, tt);
      // 空车回岸桥; 线若已关闭则退出
      if (!lineClosed[ix]) {
        heap.push({ time: tt + rng.uniform(0.85, 1.15) * model.travelBackMin,
                    type: 'arriveShore', line: ix, truck: truck });
      }
    }

    // 初始: 所有车从岸桥边错峰进入
    for (var ti = 0; ti < L; ti++) {
      if (lineClosed[ti]) continue;
      trucksOf[ti].forEach(function (tr) {
        heap.push({ time: tr.stagger, type: 'arriveShore', line: ti, truck: tr });
      });
    }

    var maxEvents = 5000000, evCount = 0, stopT = null;
    while (heap.size()) {
      var ev = heap.pop();
      t = ev.time;
      if (horizon && t > horizon) { t = horizon; break; }
      accumulate(t - lastT); lastT = t;
      while (nextSample <= t) { sample(nextSample); nextSample += every; }
      evCount++;
      if (evCount > maxEvents) break;

      if (ev.type === 'arriveShore') arriveShore(ev.line, ev.truck, t);
      else if (ev.type === 'craneEnd') craneEnd(ev.line, ev.truck, t);
      else if (ev.type === 'arriveYard') arriveYard(ev.line, ev.truck, t);
      else if (ev.type === 'yardEnd') yardEnd(ev.line, ev.truck, t);

      var any = false;
      for (var z = 0; z < L; z++) {
        if (lineFinishT[z] == null) { any = true; break; }
      }
      if (!any) { stopT = t; break; }
    }
    if (stopT == null) { accumulate((horizon || t) - lastT); stopT = horizon || t; }
    // 提前结束的副本: 用最终值把采样点补齐到观察窗, 避免曲线末端下折
    if (horizon) {
      var finDelivered = 0;
      for (var fd = 0; fd < L; fd++) finDelivered += delivered[fd];
      while (nextSample <= horizon + 1e-6) {
        var ss = { t: nextSample, deliveredTotal: finDelivered, shoreQ: {}, yardN: {}, yardBusy: {} };
        for (var fs2 = 0; fs2 < L; fs2++) ss.shoreQ[lines[fs2].id] = 0;
        yardIds.forEach(function (yid) { ss.yardN[yid] = 0; ss.yardBusy[yid] = 0; });
        samples.push(ss);
        nextSample += every;
      }
    }

    return {
      stopMin: stopT,
      horizonMin: horizon || null,
      samples: samples,
      perLine: lines.map(function (ln, ix) {
        var span = lineFinishT[ix] != null ? lineFinishT[ix] : stopT;
        return {
          id: ln.id,
          quayLeft: quay[ix], inflight: inflight[ix], delivered: delivered[ix],
          finishMin: lineFinishT[ix],
          craneUtil: span > 0 ? craneBusyArea[ix] / span : 0,
          starvation: span > 0 ? idleArea[ix] / span : 0,
          shoreWaitPerBox: shoreServed[ix] > 0 ? shoreQArea[ix] / shoreServed[ix] : 0,
          shoreAvgQLen: span > 0 ? shoreQArea[ix] / span : 0,
          shoreServed: shoreServed[ix]
        };
      }),
      yards: yardIds.map(function (yid) {
        var ys = yard[yid];
        var capMin = stopT * ys.cap;
        return {
          id: yid, served: ys.served,
          util: capMin > 0 ? ys.busyArea / capMin : 0,
          avgQLen: stopT > 0 ? ys.qArea / stopT : 0,
          waitPerBox: ys.served > 0 ? ys.waitSum / ys.served : 0
        };
      })
    };
  }

  function pct(sorted, p) {
    if (!sorted.length) return null;
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[idx];
  }
  function quantiles(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    return { p10: pct(s, 0.1), p50: pct(s, 0.5), p90: pct(s, 0.9) };
  }
  function avg(values) { return values.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, values.length); }

  /* 自适应观察窗: 按各线"理想时间"(无排队, 受车数约束的粗估)取最大值再放大 */
  function adaptiveHorizon(model) {
    var maxH = 60;
    model.lines.forEach(function (ln) {
      if (ln.down || ln.remaining <= 0) return;
      var cycle = model.travelToYardMin + model.travelBackMin + 60 / ln.effectiveCraneRate;
      var y = model.yards[ln.yardId];
      cycle += 60 / y.rate;
      var effTrucks = Math.max(0.5, ln.trucks - 0.5);
      var ratePerTruck = 60 / cycle;
      var netRate = Math.min(ln.effectiveCraneRate, effTrucks * ratePerTruck);
      var h = ln.remaining / Math.max(0.01, netRate) * 60;
      if (h > maxH) maxH = h;
    });
    return Math.min(96 * 60, maxH * 2.2 + 180);
  }

  function sumCurve(runs, key, subKey) {
    // 以第一次运行的采样网格为准(每副本采样时刻一致, 因为每 15 分整点)
    var grid = runs[0].samples.map(function (s) { return s.t; });
    var series = grid.map(function (_, gi) {
      var vals = runs.map(function (r) {
        var s = r.samples[gi];
        if (!s) return null;
        return subKey ? (s[key][subKey]) : s[key];
      }).filter(function (v) { return v != null; });
      return avg(vals);
    });
    return { grid: grid, values: series };
  }

  /* 多次重复仿真并汇总
   * onProgress(done, total): 可选, 返回 false 可中止
   */
  function estimate(model, opts) {
    opts = opts || {};
    var reps = opts.reps || 40;
    var horizon = opts.horizonMin || adaptiveHorizon(model);
    var every = opts.sampleEveryMin || 15;
    var runs = [];
    var aborted = false;
    for (var r = 0; r < reps; r++) {
      runs.push(oneRun(model, { seed: (opts.baseSeed || 20260921) + r * 7919, horizonMin: horizon, sampleEveryMin: every }));
      if (opts.onProgress && opts.onProgress(r + 1, reps) === false) { aborted = true; break; }
    }

    var lineIds = model.lines.map(function (ln) { return ln.id; });
    var yardIds = Object.keys(model.yards);

    var perLine = {};
    lineIds.forEach(function (lid, ix) {
      var fin = runs.map(function (rn) { return rn.perLine[ix].finishMin; }).filter(function (v) { return v != null; });
      var unfinished = runs.length - fin.length;
      var q = fin.length ? quantiles(fin) : { p10: null, p50: null, p90: null };
      perLine[lid] = {
        finish: q,
        unfinishedFrac: unfinished / runs.length,
        craneUtil: avg(runs.map(function (rn) { return rn.perLine[ix].craneUtil; })),
        starvation: avg(runs.map(function (rn) { return rn.perLine[ix].starvation; })),
        shoreWaitPerBox: avg(runs.map(function (rn) { return rn.perLine[ix].shoreWaitPerBox; })),
        shoreAvgQLen: avg(runs.map(function (rn) { return rn.perLine[ix].shoreAvgQLen; }))
      };
    });

    var perYard = {};
    yardIds.forEach(function (yid, yi) {
      perYard[yid] = {
        util: avg(runs.map(function (rn) { return rn.yards[yi].util; })),
        avgQLen: avg(runs.map(function (rn) { return rn.yards[yi].avgQLen; })),
        waitPerBox: avg(runs.map(function (rn) { return rn.yards[yi].waitPerBox; }))
      };
    });

    // 总落地曲线与各节点平均排队曲线
    var totalCurve = sumCurve(runs, 'deliveredTotal');
    var shoreCurves = {}, yardQCurves = {}, yardBusyCurves = {};
    lineIds.forEach(function (lid) { shoreCurves[lid] = sumCurve(runs, 'shoreQ', lid); });
    yardIds.forEach(function (yid) {
      yardQCurves[yid] = sumCurve(runs, 'yardN', yid);
      yardBusyCurves[yid] = sumCurve(runs, 'yardBusy', yid);
    });

    // 整体完工时间(所有线都完成)
    var globalFin = runs.map(function (rn) {
      var mx = 0, ok = true;
      rn.perLine.forEach(function (pl) {
        if (pl.finishMin == null) ok = false;
        else if (pl.finishMin > mx) mx = pl.finishMin;
      });
      return ok ? mx : null;
    }).filter(function (v) { return v != null; });

    return {
      reps: runs.length, aborted: aborted, horizonMin: horizon,
      perLine: perLine, perYard: perYard,
      curves: { total: totalCurve, shore: shoreCurves, yardQ: yardQCurves, yardBusy: yardBusyCurves },
      globalFinish: globalFin.length ? quantiles(globalFin) : null,
      globalUnfinishedFrac: (runs.length - globalFin.length) / runs.length
    };
  }

  /* 固定观察窗下的每线净吞吐(箱/小时), 用于抽车方案边际评估 */
  function throughputMap(model, horizonMin, reps) {
    var h = horizonMin || 120;
    var total = {};
    model.lines.forEach(function (ln) { total[ln.id] = 0; });
    var n = reps || 12;
    for (var r = 0; r < n; r++) {
      var run = oneRun(model, { seed: 55501 + r * 104729, horizonMin: h, sampleEveryMin: h });
      run.perLine.forEach(function (pl) { total[pl.id] += pl.delivered; });
    }
    var out = {};
    model.lines.forEach(function (ln, ix) { out[ln.id] = (total[ln.id] / n) / (h / 60); });
    return out;
  }

  global.SIM = {
    oneRun: oneRun, estimate: estimate, throughputMap: throughputMap,
    adaptiveHorizon: adaptiveHorizon, makeRng: makeRng
  };
})(typeof window !== 'undefined' ? window : globalThis);
