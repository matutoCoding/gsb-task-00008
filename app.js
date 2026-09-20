const STORAGE_KEY = 'qc-truck-yard-estimator-v1';

const DEFAULT_STATE = {
  fleetTotal: 24,
  weatherFactor: 1,
  baseCycle: 10,
  horizonHours: 8,
  yards: {
    A: { servicePerHour: 110, stackNow: 4200, capacity: 6000, outboundPerHour: 34 },
    B: { servicePerHour: 95, stackNow: 3300, capacity: 5200, outboundPerHour: 28 }
  },
  lines: [
    { id: 'L1', name: '1 号作业线', qcRate: 32, trucks: 8, remaining: 180, completed: 120, elapsed: 4, yard: 'A', broken: false, temp: false, calibration: 1, heldTrucks: 0, lastCalibration: null },
    { id: 'L2', name: '2 号作业线', qcRate: 30, trucks: 8, remaining: 150, completed: 90, elapsed: 3.2, yard: 'A', broken: false, temp: false, calibration: 1, heldTrucks: 0, lastCalibration: null },
    { id: 'L3', name: '3 号作业线', qcRate: 28, trucks: 7, remaining: 210, completed: 70, elapsed: 2.8, yard: 'B', broken: false, temp: false, calibration: 1, heldTrucks: 0, lastCalibration: null }
  ],
  seq: 4
};

let state;
let model;
let planContext = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const numberOrZero = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};
const integerOrZero = (value) => Math.round(numberOrZero(value));
const fmt = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const signed = (value, digits = 1) => `${value > 0 ? '+' : ''}${fmt(value, digits)}`;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const saved = JSON.parse(raw);
    return normalizeState(saved);
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function normalizeState(saved) {
  const next = structuredClone(DEFAULT_STATE);
  if (!saved || typeof saved !== 'object') return next;
  next.fleetTotal = integerOrZero(saved.fleetTotal ?? next.fleetTotal);
  next.weatherFactor = clamp(numberOrZero(saved.weatherFactor ?? next.weatherFactor), 0.5, 1.15);
  next.baseCycle = Math.max(4, numberOrZero(saved.baseCycle ?? next.baseCycle));
  next.horizonHours = Math.max(1, numberOrZero(saved.horizonHours ?? next.horizonHours));
  next.seq = integerOrZero(saved.seq ?? next.seq);
  if (saved.yards) {
    for (const key of ['A', 'B']) {
      const source = saved.yards[key] || {};
      const target = next.yards[key];
      target.servicePerHour = numberOrZero(source.servicePerHour ?? target.servicePerHour);
      target.stackNow = numberOrZero(source.stackNow ?? target.stackNow);
      target.capacity = Math.max(1, numberOrZero(source.capacity ?? target.capacity));
      target.outboundPerHour = numberOrZero(source.outboundPerHour ?? target.outboundPerHour);
    }
  }
  if (Array.isArray(saved.lines)) {
    next.lines = saved.lines.map((line, index) => ({
      id: String(line.id || `L${index + 1}`),
      name: String(line.name || `作业线 ${index + 1}`),
      qcRate: numberOrZero(line.qcRate),
      trucks: integerOrZero(line.trucks),
      remaining: numberOrZero(line.remaining),
      completed: numberOrZero(line.completed),
      elapsed: numberOrZero(line.elapsed),
      yard: line.yard === 'B' ? 'B' : 'A',
      broken: Boolean(line.broken),
      temp: Boolean(line.temp),
      calibration: clamp(numberOrZero(line.calibration ?? 1), 0.45, 1.65),
      heldTrucks: integerOrZero(line.heldTrucks),
      lastCalibration: line.lastCalibration || null
    }));
  }
  return next;
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  $('#savedAt').textContent = `已自动保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function recompute() {
  model = computeModel(state);
  render();
  persist();
}

function computeModel(source) {
  const s = structuredClone(source);
  const active = s.lines.filter(line => !line.broken);
  const yardState = Object.fromEntries(['A', 'B'].map(side => {
    const yard = s.yards[side];
    return [side, {
      ...yard,
      initialOccupancy: clamp(yard.stackNow / Math.max(1, yard.capacity), 0, 1),
      queueWait: 0,
      throughput: 0,
      arrivals: 0,
      allocation: {},
      load: 0,
      queueTrucks: 0,
      stackWait: 0,
      endStack: yard.stackNow,
      endOccupancy: clamp(yard.stackNow / Math.max(1, yard.capacity), 0, 1),
      congested: false,
      bottleneck: false
    }];
  }));

  const lineResults = new Map();
  for (const line of s.lines) {
    lineResults.set(line.id, {
      id: line.id,
      yard: line.yard,
      broken: line.broken,
      qcPotential: 0,
      throughput: 0,
      cycleMinutes: s.baseCycle,
      queueWait: 0,
      stackWait: 0,
      required: 0,
      optimalTrucks: 0,
      coverage: 0,
      starvation: 0,
      surplus: Math.max(0, line.trucks),
      quayWaitPerTruck: 0,
      averageQuayQueue: 0,
      etaHours: null,
      horizonMoves: 0,
      progressNow: 0,
      horizonProgress: 0,
      riskScore: 0,
      status: 'idle',
      reason: '',
      calibration: line.calibration
    });
  }

  for (let iteration = 0; iteration < 42; iteration++) {
    const scratchYards = Object.fromEntries(['A', 'B'].map(side => [side, {
      demand: 0,
      allocation: {},
      throughput: 0,
      arrivals: 0,
      queueWait: yardState[side].queueWait
    }]));
    const scratchLines = new Map();

    for (const line of active) {
      const yard = yardState[line.yard];
      const qcPotential = line.qcRate * s.weatherFactor * line.calibration;
      const occupancy = clamp((yard.stackNow + Math.max(0, (yard.arrivals - yard.outboundPerHour) * s.horizonHours * 0.5)) / Math.max(1, yard.capacity), 0, 1);
      const stackWait = Math.pow(Math.max(0, occupancy) / 0.82, 4) * 3.2;
      const cycle = Math.max(3, s.baseCycle + yard.queueWait + stackWait);
      const sustainable = line.trucks * 60 / cycle;
      const throughput = Math.min(qcPotential, sustainable);
      const required = qcPotential * cycle / 60;

      scratchLines.set(line.id, { qcPotential, occupancy, stackWait, cycle, sustainable, throughput, required });
      scratchYards[line.yard].demand += throughput;
      scratchYards[line.yard].allocation[line.id] = throughput;
    }

    for (const side of ['A', 'B']) {
      const yard = yardState[side];
      const scratch = scratchYards[side];
      const capacity = yard.servicePerHour;
      let allocation = Object.fromEntries(Object.entries(scratch.allocation));
      let total = Object.values(allocation).reduce((sum, value) => sum + value, 0);

      if (total > capacity) {
        const scale = capacity / total;
        for (const id of Object.keys(allocation)) allocation[id] *= scale;
        total = capacity;
      }

      const initialOccupancy = clamp(yard.stackNow / Math.max(1, yard.capacity), 0, 1);
      const midStack = clamp(yard.stackNow + Math.max(0, (total - yard.outboundPerHour) * s.horizonHours * 0.5), 0, yard.capacity * 1.12);
      const occupancy = clamp(midStack / Math.max(1, yard.capacity), 0, 1.12);
      const stackWait = Math.pow(clamp(occupancy / 0.82, 0, 1.35), 4) * 3.2;
      const load = total / Math.max(0.001, capacity);
      let queueWait = 0;
      if (total > 0 && load < 0.92) {
        queueWait = (load / (1 - load)) * (0.72 / capacity) * 60;
      } else if (total > 0) {
        const over = Math.max(0, total - capacity * 0.92);
        queueWait = 9.8 + over * 18;
      }

      yardState[side] = {
        ...yard,
        initialOccupancy,
        queueWait: yard.queueWait * 0.65 + queueWait * 0.35,
        throughput: total,
        arrivals: total,
        allocation,
        load,
        queueTrucks: total * queueWait / 60,
        stackWait,
        endStack: clamp(yard.stackNow + (total - yard.outboundPerHour) * s.horizonHours, 0, yard.capacity * 1.1),
        endOccupancy: clamp((yard.stackNow + (total - yard.outboundPerHour) * s.horizonHours) / Math.max(1, yard.capacity), 0, 1.1),
        congested: load >= 0.9 || occupancy >= 0.9,
        bottleneck: load >= 0.92
      };
      scratch.yardThroughput = total;

      for (const line of active) {
        if (line.yard !== side) continue;
        const before = scratchLines.get(line.id);
        const allocated = allocation[line.id] || 0;
        const throughput = Math.min(before.qcPotential, before.sustainable, allocated);
        scratchLines.get(line.id).throughput = throughput;
      }
    }

    for (const line of active) {
      const scratch = scratchLines.get(line.id);
      const result = lineResults.get(line.id);
      result.qcPotential = scratch.qcPotential;
      result.throughput = scratch.throughput;
      result.cycleMinutes = scratch.cycle;
      result.queueWait = yardState[line.yard].queueWait;
      result.stackWait = scratch.stackWait;
      result.required = scratch.required;
    }
  }

  finalizeLineResults(s, yardState, lineResults);
  finalizeYardResults(s, yardState, lineResults);
  const summary = buildSummary(s, yardState, lineResults);
  return { state: s, yards: yardState, lines: lineResults, summary };
}

function finalizeLineResults(s, yards, results) {
  for (const line of s.lines) {
    const result = results.get(line.id);
    if (line.broken) {
      Object.assign(result, {
        qcPotential: 0,
        throughput: 0,
        cycleMinutes: s.baseCycle,
        queueWait: 0,
        stackWait: 0,
        required: 0,
        optimalTrucks: 0,
        coverage: 0,
        starvation: 1,
        surplus: 0,
        quayWaitPerTruck: 0,
        averageQuayQueue: 0,
        etaHours: null,
        horizonMoves: 0,
        progressNow: line.remaining + line.completed > 0 ? line.completed / (line.remaining + line.completed) : 0,
        horizonProgress: line.remaining + line.completed > 0 ? line.completed / (line.remaining + line.completed) : 0,
        riskScore: 0,
        status: 'down',
        reason: `岸桥故障，${line.heldTrucks} 辆集卡待分流`
      });
      continue;
    }

    const yard = yards[line.yard];
    const qc = result.qcPotential;
    const cycle = result.cycleMinutes;
    const optimalTrucks = Math.ceil(qc * cycle / 60);
    const coverage = qc > 0 ? clamp(result.throughput / qc, 0, 1) : 0;
    const starvation = clamp(1 - coverage, 0, 1);
    const surplus = Math.max(0, line.trucks - optimalTrucks);
    const quayWaitPerTruck = result.throughput > 0 && line.trucks > optimalTrucks
      ? clamp((line.trucks - optimalTrucks) * cycle / 60 / line.trucks * 60, 0, 120)
      : 0;
    const averageQuayQueue = result.throughput * quayWaitPerTruck / 60;
    const etaHours = result.throughput > 0.01 ? line.remaining / result.throughput : null;
    const horizonMoves = result.throughput * s.horizonHours;
    const total = line.remaining + line.completed;
    const progressNow = total > 0 ? line.completed / total : 0;
    const horizonProgress = total > 0 ? clamp((line.completed + horizonMoves) / total, 0, 1) : 0;
    const riskScore = starvation * 100 + (coverage > 0 && coverage < 0.82 ? (0.82 - coverage) * 120 : 0) + (yard.bottleneck ? 8 : 0);

    let status = 'good';
    let reason = '车辆与岸桥基本匹配';
    if (qc <= 0) {
      status = 'idle';
      reason = '岸桥速度为 0';
    } else if (yard.bottleneck && coverage < 0.98) {
      status = 'bad';
      reason = `${line.yard} 堆场排队限速，加车主要增加岸边等待`;
    } else if (coverage < 0.82) {
      status = 'bad';
      reason = `集卡不足，预计最先断供风险高，还需约 ${Math.max(0, optimalTrucks - line.trucks)} 辆`;
    } else if (coverage < 0.96) {
      status = 'warn';
      reason = `车辆略紧，饱和配置约 ${optimalTrucks} 辆`;
    } else if (surplus >= 3 || quayWaitPerTruck >= 8) {
      status = 'warn';
      reason = `集卡偏多，岸边平均等待 ${fmt(quayWaitPerTruck)} 分钟/车次`;
    } else if (yard.congested) {
      status = 'warn';
      reason = `${line.yard} 堆场接近拥堵，车辆回流变慢`;
    }

    Object.assign(result, {
      optimalTrucks,
      coverage,
      starvation,
      surplus,
      quayWaitPerTruck,
      averageQuayQueue,
      etaHours,
      horizonMoves,
      progressNow,
      horizonProgress,
      riskScore,
      status,
      reason
    });
  }
}

function finalizeYardResults(s, yards, results) {
  for (const side of ['A', 'B']) {
    const yard = yards[side];
    const lineIds = s.lines.filter(line => !line.broken && line.yard === side).map(line => line.id);
    yard.lineIds = lineIds;
    yard.maxWait = Math.max(0, ...lineIds.map(id => results.get(id).queueWait + results.get(id).stackWait));
    yard.status = yard.bottleneck ? 'bad' : yard.congested ? 'warn' : 'good';
    yard.reason = yard.bottleneck
      ? '已达服务上限，到车会转为长时间排队'
      : yard.congested
        ? '堆场占用或负荷偏高，回流时间上升'
        : '堆场可承接当前到车';
  }
}

function buildSummary(s, yards, results) {
  const activeLines = s.lines.filter(line => !line.broken);
  const assigned = s.lines.reduce((sum, line) => sum + line.trucks + line.heldTrucks, 0);
  const spare = Math.max(0, s.fleetTotal - assigned);
  const overAssigned = Math.max(0, assigned - s.fleetTotal);
  const throughput = activeLines.reduce((sum, line) => sum + results.get(line.id).throughput, 0);
  const remaining = activeLines.reduce((sum, line) => sum + line.remaining, 0);
  const completed = s.lines.reduce((sum, line) => sum + line.completed, 0);
  const totalWork = remaining + completed;
  const maxWait = Math.max(0, ...activeLines.map(line => results.get(line.id).quayWaitPerTruck));
  const worst = activeLines
    .map(line => results.get(line.id))
    .filter(result => result.qcPotential > 0)
    .sort((a, b) => b.riskScore - a.riskScore)[0];
  const yardBottleneck = Object.values(yards).some(yard => yard.bottleneck);
  const horizonMoves = throughput * s.horizonHours;
  return {
    assigned,
    spare,
    overAssigned,
    throughput,
    remaining,
    completed,
    totalProgress: totalWork > 0 ? completed / totalWork : 0,
    horizonProgress: totalWork > 0 ? clamp((completed + horizonMoves) / totalWork, 0, 1) : 0,
    systemEta: throughput > 0 ? remaining / throughput : null,
    maxWait,
    worstId: worst?.id || null,
    yardBottleneck,
    brokenCount: s.lines.filter(line => line.broken).length,
    heldTrucks: s.lines.reduce((sum, line) => sum + line.heldTrucks, 0)
  };
}

function cloneState() {
  return structuredClone(state);
}

function getLine(candidate, id) {
  return candidate.lines.find(line => line.id === id);
}

function setLineTrucks(candidate, id, value) {
  const line = getLine(candidate, id);
  line.trucks = Math.max(0, Math.round(value));
}

function allocationText(changes, labels) {
  const parts = Object.entries(changes)
    .filter(([, delta]) => Math.abs(delta) > 0.001)
    .map(([id, delta]) => `${labels[id] || id} ${signed(delta, 0)}`);
  return parts.length ? parts.join('；') : '车辆总数不变';
}

function integerShare(total, weights) {
  const sum = weights.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map(weight => total * Math.max(0, weight) / sum);
  const floors = raw.map(value => Math.floor(value));
  let remainder = total - floors.reduce((acc, value) => acc + value, 0);
  const order = raw.map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (const item of order) {
    if (remainder <= 0) break;
    floors[item.index] += 1;
    remainder -= 1;
  }
  return floors;
}

function evaluateCandidate(candidate, changes, kind, title, rationale, recommended = false) {
  const nextModel = computeModel(candidate);
  const currentThroughput = model.summary.throughput;
  const currentEta = model.summary.systemEta;
  return {
    title,
    rationale,
    recommended,
    kind,
    candidate,
    changes,
    throughput: nextModel.summary.throughput,
    throughputDelta: nextModel.summary.throughput - currentThroughput,
    eta: nextModel.summary.systemEta,
    etaDelta: (nextModel.summary.systemEta || 0) - (currentEta || 0),
    maxWait: nextModel.summary.maxWait,
    spare: nextModel.summary.spare,
    overAssigned: nextModel.summary.overAssigned,
    yardBottleneck: nextModel.summary.yardBottleneck,
    labels: Object.fromEntries(candidate.lines.map(line => [line.id, line.name]))
  };
}

function generatePlans(type, context = {}) {
  if (type === 'broken') return generateBrokenPlans(context.lineId, integerOrZero(context.target));
  if (type === 'fleet') return generateFleetPlans(integerOrZero(context.target));
  if (type === 'new') return generateNewLinePlans(context.line, integerOrZero(context.target));
  return [];
}

function generateBrokenPlans(lineId, target) {
  const broken = getLine(state, lineId);
  target = clamp(Math.round(target), 0, broken.heldTrucks);
  const recipientIds = state.lines.filter(line => !line.broken && line.id !== lineId).map(line => line.id);
  const labels = Object.fromEntries(state.lines.map(line => [line.id, line.name]));
  const plans = [];

  const makeBrokenCandidate = () => {
    const candidate = cloneState();
    const source = getLine(candidate, lineId);
    source.heldTrucks -= target;
    return candidate;
  };

  const greedy = makeBrokenCandidate();
  const greedyChanges = Object.fromEntries(recipientIds.map(id => [id, 0]));
  for (let i = 0; i < target; i++) {
    let bestId = null;
    let bestRate = -Infinity;
    for (const id of recipientIds) {
      const trial = structuredClone(greedy);
      getLine(trial, id).trucks += 1;
      const trialModel = computeModel(trial);
      const gain = trialModel.summary.throughput;
      if (gain > bestRate) {
        bestRate = gain;
        bestId = id;
      }
    }
    if (!bestId) break;
    getLine(greedy, bestId).trucks += 1;
    greedyChanges[bestId] += 1;
  }
  plans.push(evaluateCandidate(greedy, greedyChanges, 'broken', '方案 A｜按边际增量补车', `每辆车都分给当前最能提升总速度的岸桥。${allocationText(greedyChanges, labels)}`, true));

  const balanced = makeBrokenCandidate();
  const balancedChanges = Object.fromEntries(recipientIds.map(id => [id, 0]));
  const deficitModel = computeModel(balanced);
  const weights = recipientIds.map(id => {
    const line = getLine(balanced, id);
    return Math.max(0, deficitModel.lines.get(id).optimalTrucks - line.trucks);
  });
  integerShare(target, weights).forEach((amount, index) => {
    const id = recipientIds[index];
    setLineTrucks(balanced, id, getLine(balanced, id).trucks + amount);
    balancedChanges[id] = amount;
  });
  plans.push(evaluateCandidate(balanced, balancedChanges, 'broken', '方案 B｜按缺车比例均衡', `优先补齐各线到饱和配置的缺口。${allocationText(balancedChanges, labels)}`));

  const yardSafe = makeBrokenCandidate();
  const safeChanges = Object.fromEntries(recipientIds.map(id => [id, 0]));
  for (let i = 0; i < target; i++) {
    let bestId = null;
    let bestScore = -Infinity;
    for (const id of recipientIds) {
      const trial = structuredClone(yardSafe);
      getLine(trial, id).trucks += 1;
      const trialModel = computeModel(trial);
      const result = trialModel.lines.get(id);
      const score = 1 - trialModel.yards[result.yard].load + clamp(1 - result.coverage, 0, 1);
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }
    if (!bestId) break;
    getLine(yardSafe, bestId).trucks += 1;
    safeChanges[bestId] += 1;
  }
  plans.push(evaluateCandidate(yardSafe, safeChanges, 'broken', '方案 C｜避开高负荷堆场', `优先分给堆场负荷较低、仍有回流空间的线。${allocationText(safeChanges, labels)}`));
  return plans.sort((a, b) => b.throughput - a.throughput).map((plan, index) => ({ ...plan, recommended: index === 0 }));
}

function generateFleetPlans(target) {
  const labels = Object.fromEntries(state.lines.map(line => [line.id, line.name]));
  const needRemove = Math.max(0, model.summary.assigned - target);
  const plans = [];

  const removeWithGreedy = () => {
    const candidate = cloneState();
    candidate.fleetTotal = target;
    const changes = {};
    for (let i = 0; i < needRemove; i++) {
      let bestId = null;
      let bestThroughput = -Infinity;
      for (const line of candidate.lines) {
        if (line.broken || line.trucks <= 0) continue;
        const trial = structuredClone(candidate);
        getLine(trial, line.id).trucks -= 1;
        const trialModel = computeModel(trial);
        if (trialModel.summary.throughput > bestThroughput) {
          bestThroughput = trialModel.summary.throughput;
          bestId = line.id;
        }
      }
      if (!bestId) break;
      getLine(candidate, bestId).trucks -= 1;
      changes[bestId] = (changes[bestId] || 0) - 1;
    }
    return { candidate, changes };
  };

  const greedy = removeWithGreedy();
  plans.push(evaluateCandidate(greedy.candidate, greedy.changes, 'fleet', '方案 A｜先撤多余车', '逐辆撤下对总速度影响最小的车，尽量保进度。' + allocationText(greedy.changes, labels), true));

  const equalCandidate = cloneState();
  equalCandidate.fleetTotal = target;
  const activeIds = equalCandidate.lines.filter(line => !line.broken).map(line => line.id);
  const equalChanges = Object.fromEntries(activeIds.map(id => [id, 0]));
  let toRemove = needRemove;
  while (toRemove > 0) {
    const tempModel = computeModel(equalCandidate);
    const candidates = activeIds
      .map(id => ({ id, line: getLine(equalCandidate, id), result: tempModel.lines.get(id) }))
      .filter(item => item.line.trucks > item.result.optimalTrucks)
      .sort((a, b) => (b.line.trucks - b.result.optimalTrucks) - (a.line.trucks - a.result.optimalTrucks));
    if (!candidates.length) break;
    getLine(equalCandidate, candidates[0].id).trucks -= 1;
    equalChanges[candidates[0].id] -= 1;
    toRemove -= 1;
  }
  while (toRemove > 0) {
    const tempModel = computeModel(equalCandidate);
    const candidates = activeIds
      .map(id => ({ id, line: getLine(equalCandidate, id), result: tempModel.lines.get(id) }))
      .filter(item => item.line.trucks > 0)
      .sort((a, b) => a.result.starvation - b.result.starvation);
    if (!candidates.length) break;
    getLine(equalCandidate, candidates[0].id).trucks -= 1;
    equalChanges[candidates[0].id] -= 1;
    toRemove -= 1;
  }
  plans.push(evaluateCandidate(equalCandidate, equalChanges, 'fleet', '方案 B｜均衡承担缺口', '先撤富余，再让各线按风险较均衡地承担缺车。' + allocationText(equalChanges, labels)));

  const nearDone = greedy.candidate ? structuredClone(greedy.candidate) : cloneState();
  nearDone.fleetTotal = target;
  const nearChanges = structuredClone(greedy.changes);
  const trialModel = computeModel(nearDone);
  const sorted = state.lines
    .filter(line => !line.broken)
    .map(line => ({ line, result: trialModel.lines.get(line.id) }))
    .filter(item => item.result.etaHours !== null)
    .sort((a, b) => b.result.etaHours - a.result.etaHours);
  let stillNeed = needRemove - Math.abs(Object.values(nearChanges).reduce((sum, value) => sum + value, 0));
  for (const item of sorted) {
    while (stillNeed > 0 && getLine(nearDone, item.line.id).trucks > 0) {
      getLine(nearDone, item.line.id).trucks -= 1;
      nearChanges[item.line.id] = (nearChanges[item.line.id] || 0) - 1;
      stillNeed -= 1;
    }
  }
  plans.push(evaluateCandidate(nearDone, nearChanges, 'fleet', '方案 C｜保即将完成线', '优先从剩余时间较长的线撤车，短期完工线少受影响。' + allocationText(nearChanges, labels)));

  return plans.sort((a, b) => b.throughput - a.throughput).map((plan, index) => ({ ...plan, recommended: index === 0 }));
}

function generateNewLinePlans(newLine, target) {
  const labels = Object.fromEntries([...state.lines, newLine].map(line => [line.id, line.name]));
  const donorIds = state.lines.filter(line => line.trucks > 0).map(line => line.id);
  const spare = model.summary.spare;
  const fromPool = Math.min(target, spare);
  const needDraw = Math.max(0, target - fromPool);
  const plans = [];

  const buildBase = () => {
    const candidate = cloneState();
    candidate.lines.push(structuredClone(newLine));
    const source = candidate.lines.find(line => line.id === newLine.id);
    source.trucks = target;
    candidate.fleetTotal = state.fleetTotal;
    return candidate;
  };

  const drawGreedy = () => {
    const candidate = buildBase();
    const changes = { [newLine.id]: target };
    for (let i = 0; i < needDraw; i++) {
      let bestId = null;
      let bestThroughput = -Infinity;
      for (const id of donorIds) {
        const trial = structuredClone(candidate);
        getLine(trial, id).trucks -= 1;
        const throughput = computeModel(trial).summary.throughput;
        if (throughput > bestThroughput) {
          bestThroughput = throughput;
          bestId = id;
        }
      }
      if (!bestId) break;
      getLine(candidate, bestId).trucks -= 1;
      changes[bestId] = (changes[bestId] || 0) - 1;
    }
    return { candidate, changes };
  };

  const greedy = drawGreedy();
  plans.push(evaluateCandidate(greedy.candidate, greedy.changes, 'new', '方案 A｜先抽富余车', `空闲车先用 ${fromPool} 辆，再逐辆抽走边际影响最小的车。${allocationText(greedy.changes, labels)}`, true));

  const equal = buildBase();
  const equalChanges = { [newLine.id]: target };
  const tempModel = computeModel(equal);
  const surplus = donorIds.map(id => {
    const line = getLine(equal, id);
    return Math.max(0, line.trucks - tempModel.lines.get(id).optimalTrucks);
  });
  integerShare(needDraw, surplus).forEach((amount, index) => {
    const id = donorIds[index];
    if (!amount) return;
    setLineTrucks(equal, id, getLine(equal, id).trucks - amount);
    equalChanges[id] = -amount;
  });
  let left = needDraw - Object.values(equalChanges).reduce((sum, value) => sum + Math.abs(Math.min(0, value)), 0);
  while (left > 0) {
    const m = computeModel(equal);
    const donor = donorIds
      .map(id => ({ id, line: getLine(equal, id), result: m.lines.get(id) }))
      .filter(item => item.line.trucks > 0)
      .sort((a, b) => a.result.starvation - b.result.starvation)[0];
    if (!donor) break;
    donor.line.trucks -= 1;
    equalChanges[donor.id] = (equalChanges[donor.id] || 0) - 1;
    left -= 1;
  }
  plans.push(evaluateCandidate(equal, equalChanges, 'new', '方案 B｜按富余比例抽', `空闲车使用 ${fromPool} 辆，其余按各线富余程度分摊。${allocationText(equalChanges, labels)}`));

  const protect = buildBase();
  const protectChanges = { [newLine.id]: target };
  for (let i = 0; i < needDraw; i++) {
    const m = computeModel(protect);
    const donor = donorIds
      .map(id => ({ id, line: getLine(protect, id), result: m.lines.get(id) }))
      .filter(item => item.line.trucks > 0)
      .sort((a, b) => (b.result.etaHours || 0) - (a.result.etaHours || 0))[0];
    if (!donor) break;
    donor.line.trucks -= 1;
    protectChanges[donor.id] = (protectChanges[donor.id] || 0) - 1;
  }
  plans.push(evaluateCandidate(protect, protectChanges, 'new', '方案 C｜保快完工线', `空闲车使用 ${fromPool} 辆，其余优先从剩余时间更长的线抽。${allocationText(protectChanges, labels)}`));
  return plans;
}

function applyPlan(plan) {
  state = structuredClone(plan.candidate);
  recompute();
}

function statusClass(status) {
  return {
    good: 'status-good',
    warn: 'status-warn',
    bad: 'status-bad',
    info: 'status-info',
    idle: 'status-neutral',
    down: 'status-bad'
  }[status] || 'status-neutral';
}

function statusLabel(status) {
  return {
    good: '匹配',
    warn: '需关注',
    bad: '风险',
    info: '提示',
    idle: '未作业',
    down: '岸桥停机'
  }[status] || '—';
}

function renderGlobalInputs() {
  $('#fleetTotal').value = state.fleetTotal;
  $('#weatherFactor').value = state.weatherFactor;
  $('#weatherValue').textContent = `${Math.round(state.weatherFactor * 100)}%`;
  $('#baseCycle').value = state.baseCycle;
  $('#horizonHours').value = state.horizonHours;
}

function renderKpis() {
  const summary = model.summary;
  const worst = summary.worstId ? getLine(model.state, summary.worstId) : null;
  const kpis = [
    { label: '在港 / 已分配集卡', value: `${state.fleetTotal} / ${summary.assigned}`, sub: summary.overAssigned ? `超出 ${summary.overAssigned} 辆，需重分` : `空闲 ${summary.spare} 辆`, tone: summary.overAssigned ? 'bad' : 'good' },
    { label: '全部线当前速度', value: `${fmt(summary.throughput)} 箱/h`, sub: summary.systemEta ? `剩余约 ${fmt(summary.systemEta)} 小时` : '暂无可作业线', tone: summary.throughput > 0 ? 'good' : 'bad' },
    { label: '最先断供风险', value: worst ? worst.name.replace(' 作业线', '') : '—', sub: worst ? model.lines.get(worst.id).reason : '暂无缺车线', tone: worst && model.lines.get(worst.id).coverage < .82 ? 'bad' : 'good' },
    { label: '最大岸边等待', value: `${fmt(summary.maxWait)} 分/车次`, sub: summary.yardBottleneck ? '至少一侧堆场已限速' : '按当前车辆和堆场联动估算', tone: summary.maxWait >= 8 || summary.yardBottleneck ? 'warn' : 'good' }
  ];
  $('#globalKpis').innerHTML = kpis.map(kpi => `
    <article class="kpi ${kpi.tone}">
      <span>${kpi.label}</span><strong>${kpi.value}</strong><small>${kpi.sub}</small>
    </article>
  `).join('');
}

function renderNotices() {
  const notices = [];
  const broken = state.lines.find(line => line.broken && line.heldTrucks > 0);
  if (broken) {
    notices.push({
      tone: 'danger',
      title: `${broken.name} 岸桥故障：${broken.heldTrucks} 辆集卡待分流`,
      text: '分到其他线会增加岸边等待和堆场负荷，系统已给出三套联动重分方案。',
      action: `<button class="btn btn-danger" data-action="broken-plan" data-id="${broken.id}">分流 ${broken.heldTrucks} 辆</button>`
    });
  }
  if (model.summary.overAssigned > 0) {
    notices.push({
      tone: 'danger',
      title: `下班/调车后总数少了 ${model.summary.overAssigned} 辆`,
      text: '旧的分配结论已作废，需要从各线撤回车辆并重新估算后续进度。',
      action: `<button class="btn btn-danger" data-action="fleet-plan" data-target="${state.fleetTotal}">生成收缩方案</button>`
    });
  }
  const yard = Object.values(model.yards).find(item => item.bottleneck);
  if (yard && !model.summary.overAssigned) {
    notices.push({
      tone: 'warn',
      title: `${yard === model.yards.A ? 'A' : 'B'} 堆场已到拥堵临界`,
      text: '继续向该侧加车，岸桥速度提升有限，车辆会堆在岸边和堆场入口。',
      action: ''
    });
  }
  const tight = state.lines
    .filter(line => !line.broken)
    .map(line => model.lines.get(line.id))
    .find(result => result.coverage > 0 && result.coverage < .82);
  if (tight && !broken && !model.summary.overAssigned) {
    const line = getLine(model.state, tight.id);
    notices.push({
      tone: 'warn',
      title: `${line.name}预计最先等车停摆`,
      text: tight.reason,
      action: model.summary.spare > 0 ? `<button class="btn btn-secondary" data-action="quick-fill" data-id="${line.id}">空闲车补 1 辆</button>` : ''
    });
  }
  $('#noticeStack').innerHTML = notices.map(notice => `
    <div class="notice ${notice.tone}">
      <div><strong>${notice.title}</strong><p>${notice.text}</p></div>
      <div class="notice-actions">${notice.action}</div>
    </div>
  `).join('');
}

function renderLines() {
  const grid = $('#lineGrid');
  const template = $('#lineTemplate');
  grid.innerHTML = '';

  for (const line of state.lines) {
    const result = model.lines.get(line.id);
    const fragment = template.content.cloneNode(true);
    const card = $('.line-card', fragment);
    card.dataset.id = line.id;
    card.classList.toggle('is-down', line.broken);

    $('.line-card-head h3', fragment).textContent = line.name;
    $('.temp-badge', fragment).classList.toggle('hidden', !line.temp);
    $('.down-badge', fragment).classList.toggle('hidden', !line.broken);
    $('.line-subhead', fragment).textContent = `${line.yard} 堆场 · 已运行 ${fmt(line.elapsed)} h · 修正系数 ${fmt(line.calibration, 2)}×`;
    $('[data-field="broken"]', fragment).checked = line.broken;

    const pill = $('.status-pill', fragment);
    pill.className = `status-pill ${statusClass(result.status)}`;
    pill.textContent = `${statusLabel(result.status)} · ${result.reason}`;

    $('.progress-bar', fragment).style.width = `${Math.round(result.progressNow * 100)}%`;
    const forecast = $('.progress-forecast', fragment);
    forecast.style.left = `${Math.round(result.horizonProgress * 100)}%`;
    forecast.classList.toggle('visible', !line.broken && result.horizonProgress > result.progressNow);
    forecast.title = `${state.horizonHours} 小时后预计完成 ${Math.round(result.horizonProgress * 100)}%`;
    $('.m-eff', fragment).textContent = line.broken ? '0.0 箱/h' : `${fmt(result.throughput)} 箱/h`;
    $('.m-eta', fragment).textContent = line.broken ? '停机' : result.etaHours === null ? '—' : `${fmt(result.etaHours)} h`;
    $('.m-cover', fragment).textContent = line.broken ? '—' : `${Math.round(result.coverage * 100)}% / ${result.optimalTrucks}辆`;
    $('.m-wait', fragment).textContent = line.broken ? '—' : `${fmt(result.quayWaitPerTruck)} 分`;

    const values = {
      qcRate: line.qcRate,
      trucks: line.trucks,
      remaining: line.remaining,
      completed: line.completed,
      elapsed: line.elapsed
    };
    for (const [field, value] of Object.entries(values)) {
      $(`[data-field="${field}"]`, fragment).value = value;
    }
    $('[data-field="yard"]', fragment).value = line.yard;
    $('[data-field="yard"]', fragment).disabled = line.broken;
    $('.repair-btn', fragment).classList.toggle('hidden', !line.broken);
    $('.remove-btn', fragment).classList.toggle('hidden', !line.temp);
    const calNote = line.lastCalibration
      ? `上次按 ${fmt(line.lastCalibration.hours)} 小时完成 ${Math.round(line.lastCalibration.moves)} 箱修正，当前系数 ${fmt(line.calibration, 2)}×`
      : '尚未修正；修正后只影响后续估算，已完成箱量不会被清零。';
    $('.cal-note', fragment).textContent = calNote;
    grid.appendChild(fragment);
  }
}

function renderYards() {
  const grid = $('#yardGrid');
  grid.innerHTML = '';
  for (const side of ['A', 'B']) {
    const yard = state.yards[side];
    const result = model.yards[side];
    const sideName = side === 'A' ? 'A 堆场' : 'B 堆场';
    const article = document.createElement('article');
    article.className = 'yard-card';
    article.dataset.yard = side;
    article.innerHTML = `
      <h3>${sideName}<span class="status-pill ${statusClass(result.status)}">${statusLabel(result.status)}</span></h3>
      <p class="muted">${result.reason}；服务线：${result.lineIds.length} 条</p>
      <div class="yard-form">
        <label>服务能力（箱/h）<input data-yard-field="servicePerHour" type="number" min="0" step="1" value="${yard.servicePerHour}"></label>
        <label>当前堆存（箱）<input data-yard-field="stackNow" type="number" min="0" step="10" value="${yard.stackNow}"></label>
        <label>堆存容量（箱）<input data-yard-field="capacity" type="number" min="1" step="10" value="${yard.capacity}"></label>
        <label>外运转出（箱/h）<input data-yard-field="outboundPerHour" type="number" min="0" step="1" value="${yard.outboundPerHour}"></label>
      </div>
      <div class="yard-metrics">
        <div><span>当前负荷</span><strong>${Math.round(result.load * 100)}%</strong></div>
        <div><span>堆场入口等待</span><strong>${fmt(result.queueWait)} 分</strong></div>
        <div><span>堆存附加等待</span><strong>${fmt(result.stackWait)} 分</strong></div>
        <div><span>估算后堆存率</span><strong>${Math.round(clamp(result.endOccupancy, 0, 1) * 100)}%</strong></div>
        <div><span>排队车辆</span><strong>${fmt(result.queueTrucks)} 辆</strong></div>
        <div><span>总回流惩罚</span><strong>${fmt(result.maxWait)} 分</strong></div>
      </div>
    `;
    grid.appendChild(article);
  }
}

function render() {
  renderGlobalInputs();
  renderKpis();
  renderNotices();
  renderLines();
  renderYards();
}

function openPlanDialog(type, context, plans) {
  planContext = { type, context, plans };
  const titles = {
    broken: ['故障车辆分流', '选择一种分流方案；所有速度、等待时间和堆场负荷已联动重算。'],
    fleet: ['下班车辆收缩', '选择一种撤回方案；旧估算立即作废，后续进度按剩余车辆重估。'],
    new: ['临时加线抽车', '选择一种抽车方案；被抽线的变慢和新线进度会同账计算。']
  };
  $('#planEyebrow').textContent = titles[type][0];
  $('#planTitle').textContent = titles[type][0];
  $('#planDescription').textContent = titles[type][1];
  $('#planTarget').value = context.target;
  $('#planTarget').min = 0;
  $('#planTarget').max = type === 'broken' ? getLine(state, context.lineId)?.heldTrucks || 0 : '';
  renderPlanCards(plans);
  $('#planDialog').showModal();
}

function renderPlanCards(plans) {
  const currentEta = model.summary.systemEta;
  $('#planList').innerHTML = plans.map((plan, index) => `
    <article class="plan-card ${plan.recommended ? 'recommended' : ''}">
      <div>
        <h3>${plan.title}${plan.recommended ? ' <span class="badge temp-badge">推荐</span>' : ''}</h3>
        <p>${plan.rationale}</p>
      </div>
      <div class="plan-stat"><span>总速度</span><strong>${fmt(plan.throughput)} 箱/h<br><small>${signed(plan.throughputDelta)}</small></strong></div>
      <div class="plan-stat"><span>剩余总工时</span><strong>${plan.eta ? `${fmt(plan.eta)} h<br><small>${signed(plan.etaDelta)} h</small>` : '—'}</strong></div>
      <div class="plan-stat"><span>最大岸等 / 空闲车</span><strong>${fmt(plan.maxWait)} 分 / ${plan.spare} 辆</strong></div>
      <button class="btn ${plan.recommended ? 'btn-primary' : 'btn-secondary'}" data-plan-index="${index}">执行</button>
    </article>
  `).join('');
}

function refreshPlanDialog() {
  if (!planContext) return;
  const target = integerOrZero($('#planTarget').value);
  const context = { ...planContext.context, target };
  const plans = generatePlans(planContext.type, context);
  planContext.context = context;
  planContext.plans = plans;
  renderPlanCards(plans);
}

function addTempLine() {
  const id = `T${state.seq}`;
  const line = {
    id,
    name: `临时线 ${state.seq}`,
    qcRate: 26,
    trucks: 0,
    remaining: 120,
    completed: 0,
    elapsed: 0,
    yard: Object.values(model.yards).sort((a, b) => a.load - b.load)[0] === model.yards.A ? 'A' : 'B',
    broken: false,
    temp: true,
    calibration: 1,
    heldTrucks: 0,
    lastCalibration: null
  };
  const candidate = cloneState();
  candidate.lines.push(line);
  const probe = computeModel(candidate);
  const target = clamp(probe.lines.get(id).optimalTrucks, 0, state.fleetTotal);
  const context = { line, target };
  const plans = generateNewLinePlans(line, target);
  state.seq += 1;
  openPlanDialog('new', context, plans);
}

function applyCalibration(lineId) {
  const card = $(`.line-card[data-id="${lineId}"]`);
  const hours = numberOrZero($('[data-cal="hours"]', card).value);
  const moves = numberOrZero($('[data-cal="moves"]', card).value);
  if (hours <= 0 || moves <= 0) return;
  const line = getLine(state, lineId);
  const expected = line.qcRate * state.weatherFactor * hours;
  const observedFactor = moves / Math.max(0.001, expected);
  const nextFactor = clamp(line.calibration * (0.65 + 0.35 * observedFactor), 0.45, 1.65);
  line.calibration = nextFactor;
  line.lastCalibration = { hours, moves, at: new Date().toISOString() };
  recompute();
}

function bindEvents() {
  $('#fleetTotal').addEventListener('change', event => {
    state.fleetTotal = integerOrZero(event.target.value);
    recompute();
  });
  $('#weatherFactor').addEventListener('input', event => {
    state.weatherFactor = numberOrZero(event.target.value);
    $('#weatherValue').textContent = `${Math.round(state.weatherFactor * 100)}%`;
  });
  $('#weatherFactor').addEventListener('change', recompute);
  $('#baseCycle').addEventListener('change', event => {
    state.baseCycle = Math.max(4, numberOrZero(event.target.value));
    recompute();
  });
  $('#horizonHours').addEventListener('change', event => {
    state.horizonHours = Math.max(1, numberOrZero(event.target.value));
    recompute();
  });
  $('#addLineBtn').addEventListener('click', addTempLine);
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('恢复演示数据会覆盖当前估算条件，确定继续？')) return;
    state = structuredClone(DEFAULT_STATE);
    recompute();
  });

  $('#lineGrid').addEventListener('change', event => {
    const card = event.target.closest('.line-card');
    if (!card) return;
    const id = card.dataset.id;
    const line = getLine(state, id);
    const field = event.target.dataset.field;
    if (!field) return;
    if (field === 'broken') {
      line.broken = event.target.checked;
      if (line.broken) {
        line.heldTrucks = line.trucks;
        line.trucks = 0;
      }
      recompute();
      if (line.broken && line.heldTrucks > 0) {
        const plans = generateBrokenPlans(id, line.heldTrucks);
        openPlanDialog('broken', { lineId: id, target: line.heldTrucks }, plans);
      }
      return;
    }
    if (field === 'yard') {
      line.yard = event.target.value === 'B' ? 'B' : 'A';
    } else if (['trucks'].includes(field)) {
      line[field] = integerOrZero(event.target.value);
    } else {
      line[field] = numberOrZero(event.target.value);
    }
    recompute();
  });

  $('#lineGrid').addEventListener('click', event => {
    const button = event.target.closest('button');
    const card = event.target.closest('.line-card');
    if (!button || !card) return;
    const id = card.dataset.id;
    if (button.classList.contains('calibrate-btn')) applyCalibration(id);
    if (button.classList.contains('reset-cal-btn')) {
      const line = getLine(state, id);
      line.calibration = 1;
      line.lastCalibration = null;
      recompute();
    }
    if (button.classList.contains('repair-btn')) {
      const line = getLine(state, id);
      line.broken = false;
      line.trucks = line.heldTrucks;
      line.heldTrucks = 0;
      recompute();
    }
    if (button.classList.contains('remove-btn')) {
      state.lines = state.lines.filter(item => item.id !== id);
      recompute();
    }
  });

  $('#yardGrid').addEventListener('change', event => {
    const card = event.target.closest('.yard-card');
    const field = event.target.dataset.yardField;
    if (!card || !field) return;
    const side = card.dataset.yard;
    state.yards[side][field] = field === 'capacity'
      ? Math.max(1, numberOrZero(event.target.value))
      : numberOrZero(event.target.value);
    recompute();
  });

  $('#noticeStack').addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'broken-plan') {
      const lineId = button.dataset.id;
      const held = getLine(state, lineId).heldTrucks;
      openPlanDialog('broken', { lineId, target: held }, generateBrokenPlans(lineId, held));
    }
    if (action === 'fleet-plan') {
      const target = state.fleetTotal;
      openPlanDialog('fleet', { target }, generateFleetPlans(target));
    }
    if (action === 'quick-fill' && model.summary.spare > 0) {
      const line = getLine(state, button.dataset.id);
      line.trucks += 1;
      recompute();
    }
  });

  $('#planList').addEventListener('click', event => {
    const button = event.target.closest('[data-plan-index]');
    if (!button || !planContext) return;
    const plan = planContext.plans[Number(button.dataset.planIndex)];
    $('#planDialog').close();
    if (plan) applyPlan(plan);
    planContext = null;
  });
  $('#planTarget').addEventListener('change', refreshPlanDialog);
  $('#planDialog').addEventListener('close', () => {
    planContext = null;
    recompute();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  state = loadState();
  model = computeModel(state);
  bindEvents();
  render();
  $('#savedAt').textContent = '已载入上次估算条件';
});
