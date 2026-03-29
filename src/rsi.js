// src/rsi.js — RSI calculation + BUY/SELL signal logic
//
// BUY 触发条件（全部满足）：
//   1. RSI 上穿 RSI_BUY (30)
//   2. EMA9/EMA20 收敛 ≤ EMA_CONVERGE_PCT（K线不足20根时跳过此过滤，不阻塞）
//   3. RSI 底背离（K线不足时跳过，不阻塞）
//
// SELL 触发条件：
//   RSI 超过 RSI_SELL (75)
//
// 预热逻辑优化（解决买入滞后）：
//   - 只需 RSI_PERIOD + 2 根K线即可出信号（默认 9 根）
//   - EMA20 需要20根预热，不足时跳过EMA过滤器（而不是整体阻塞）
//   - RSI底背离同理，数据不足时直接放行

'use strict';

const logger = require('./logger');

const RSI_PERIOD       = parseInt(process.env.RSI_PERIOD         || '7');
const RSI_BUY          = parseFloat(process.env.RSI_BUY          || '30');
const RSI_SELL         = parseFloat(process.env.RSI_SELL         || '75');
const KLINE_SEC        = parseInt(process.env.KLINE_INTERVAL_SEC || '3');
const EMA_CONVERGE_PCT = parseFloat(process.env.EMA_CONVERGE_PCT || '3');
const RSI_DIVERGE_BARS = parseInt(process.env.RSI_DIVERGE_BARS   || '20');

// RSI 最少需要 period+1 根收盘价才能算出第一个值，再+1根才能判断穿越
const RSI_MIN_BARS = RSI_PERIOD + 2;  // 默认 9 根

// ── RSI 计算（Wilder 平滑法，oldest-first）────────────────────
function calcRSI(closes, period = RSI_PERIOD) {
  const result = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g    = diff > 0 ? diff : 0;
    const l    = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

// ── EMA 计算（SMA 种子，oldest-first）────────────────────────
function calcEMA(closes, period) {
  const result = new Array(closes.length).fill(NaN);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

// ── 过滤器1：EMA 收敛检查 ─────────────────────────────────────
// K线不足20根时返回 skip=true，由调用方决定是否跳过（不阻塞买入）
function checkEmaConverge(closes) {
  if (closes.length < 20) {
    return { pass: true, skip: true, reason: 'ema_warmup', ema9: NaN, ema20: NaN, gapPct: NaN };
  }

  const ema9s  = calcEMA(closes, 9);
  const ema20s = calcEMA(closes, 20);
  const len    = closes.length;
  const ema9   = ema9s[len - 1];
  const ema20  = ema20s[len - 1];
  const price  = closes[len - 1];

  if (isNaN(ema9) || isNaN(ema20) || price <= 0) {
    return { pass: true, skip: true, reason: 'ema_nan', ema9, ema20, gapPct: NaN };
  }

  const gapPct = Math.abs(ema9 - ema20) / price * 100;
  const pass   = gapPct <= EMA_CONVERGE_PCT;

  return {
    pass,
    skip: false,
    reason: pass
      ? `EMA收敛(gap=${gapPct.toFixed(2)}%≤${EMA_CONVERGE_PCT}%)`
      : `EMA发散(gap=${gapPct.toFixed(2)}%>${EMA_CONVERGE_PCT}%)`,
    ema9,
    ema20,
    gapPct,
  };
}

// ── 过滤器2：RSI 底背离检查 ───────────────────────────────────
// 数据不足时返回 pass=true（跳过，不阻塞）
function checkRsiDivergence(rsis, currentIdx) {
  let thisTrough = Infinity;
  let i = currentIdx - 1;
  while (i >= 0 && rsis[i] <= rsis[i + 1]) {
    if (!isNaN(rsis[i])) thisTrough = Math.min(thisTrough, rsis[i]);
    i--;
  }
  if (thisTrough === Infinity) return { pass: true, reason: 'no_prev_trough' };

  const searchStart = Math.max(0, i - RSI_DIVERGE_BARS);
  let prevTrough    = Infinity;
  for (let j = searchStart; j <= i; j++) {
    if (!isNaN(rsis[j])) prevTrough = Math.min(prevTrough, rsis[j]);
  }
  if (prevTrough === Infinity) return { pass: true, reason: 'no_prev_trough' };

  const pass = thisTrough >= prevTrough;
  return {
    pass,
    reason: pass
      ? `RSI底背离(本次${thisTrough.toFixed(1)}≥上次${prevTrough.toFixed(1)})`
      : `RSI底部下沉(本次${thisTrough.toFixed(1)}<上次${prevTrough.toFixed(1)})`,
    thisTrough,
    prevTrough,
  };
}

// ── 主信号评估（带 try-catch，单币出错不崩服务）──────────────
function evaluateSignal(candles, tokenState) {
  try {
    return _evaluateSignal(candles, tokenState);
  } catch (e) {
    logger.warn(`[RSI] evaluateSignal error for ${tokenState?.symbol || '?'}: ${e.message}`);
    return { rsi: NaN, ema9: NaN, ema20: NaN, emaGapPct: NaN, signal: null, reason: 'error', blocked: false };
  }
}

function _evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const rsis   = calcRSI(closes, RSI_PERIOD);
  const len    = closes.length;

  // 只需 RSI_MIN_BARS 根即可出信号（默认9根，约27秒）
  if (len < RSI_MIN_BARS) {
    tokenState.prevRsi = NaN;
    return { rsi: NaN, ema9: NaN, ema20: NaN, emaGapPct: NaN, signal: null, reason: `warming_up(${len}/${RSI_MIN_BARS})`, blocked: false };
  }

  const rsiNow  = rsis[len - 1];
  const rsiPrev = rsis[len - 2];

  if (isNaN(rsiNow) || isNaN(rsiPrev)) {
    return { rsi: NaN, ema9: NaN, ema20: NaN, emaGapPct: NaN, signal: null, reason: 'rsi_nan', blocked: false };
  }

  // 始终计算 EMA 供 dashboard 显示（不足20根时为 NaN，无害）
  const emaResult = checkEmaConverge(closes);
  tokenState.ema9      = emaResult.ema9;
  tokenState.ema20     = emaResult.ema20;
  tokenState.emaGapPct = emaResult.gapPct ?? NaN;

  // ── SELL：RSI 超过卖出线 ──────────────────────────────────────
  if (rsiNow >= RSI_SELL) {
    tokenState.prevRsi = rsiNow;
    return {
      rsi: rsiNow, ema9: emaResult.ema9, ema20: emaResult.ema20, emaGapPct: emaResult.gapPct,
      signal: 'SELL',
      reason: `RSI超过${RSI_SELL} (${rsiNow.toFixed(1)})`,
      blocked: false,
    };
  }

  // ── BUY：RSI 上穿买入线 ───────────────────────────────────────
  if (rsiPrev < RSI_BUY && rsiNow >= RSI_BUY) {
    tokenState.prevRsi = rsiNow;

    // 过滤器1：EMA 收敛（预热期跳过，不阻塞）
    if (!emaResult.skip && !emaResult.pass) {
      logger.info(`[RSI] BUY blocked — ${emaResult.reason}`);
      return {
        rsi: rsiNow, ema9: emaResult.ema9, ema20: emaResult.ema20, emaGapPct: emaResult.gapPct,
        signal: null,
        reason: `RSI上穿但过滤: ${emaResult.reason}`,
        blocked: true,
        blockReason: emaResult.reason,
      };
    }

    // 过滤器2：RSI 底背离（数据不足时跳过，不阻塞）
    const divResult = checkRsiDivergence(rsis, len - 1);
    if (!divResult.pass) {
      return {
        rsi: rsiNow, ema9: emaResult.ema9, ema20: emaResult.ema20, emaGapPct: emaResult.gapPct,
        signal: null,
        reason: `RSI上穿但过滤: ${divResult.reason}`,
        blocked: true,
        blockReason: divResult.reason,
      };
    }

    // 过滤器均通过 → BUY
    const filterNote = emaResult.skip ? '(EMA预热跳过)' : emaResult.reason;
    return {
      rsi: rsiNow, ema9: emaResult.ema9, ema20: emaResult.ema20, emaGapPct: emaResult.gapPct,
      signal: 'BUY',
      reason: `RSI上穿${RSI_BUY} + ${filterNote} + ${divResult.reason}`,
      blocked: false,
    };
  }

  tokenState.prevRsi = rsiNow;
  return {
    rsi: rsiNow, ema9: emaResult.ema9, ema20: emaResult.ema20, emaGapPct: emaResult.gapPct,
    signal: null, reason: '', blocked: false,
  };
}

// ── K线聚合 ───────────────────────────────────────────────────
function buildCandles(ticks, intervalSec = KLINE_SEC) {
  if (!ticks.length) return [];

  const intervalMs = intervalSec * 1000;
  const candles    = [];
  let bucketStart  = Math.floor(ticks[0].time / intervalMs) * intervalMs;
  let current      = null;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.time / intervalMs) * intervalMs;

    if (bucket !== bucketStart) {
      if (current) candles.push(current);

      let gap = bucketStart + intervalMs;
      while (gap < bucket) {
        const prev = candles[candles.length - 1];
        candles.push({ time: gap, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 });
        gap += intervalMs;
      }

      bucketStart = bucket;
      current     = null;
    }

    if (!current) {
      current = { time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: 1 };
    } else {
      if (tick.price > current.high) current.high = tick.price;
      if (tick.price < current.low)  current.low  = tick.price;
      current.close = tick.price;
      current.volume++;
    }
  }

  if (current) candles.push(current);
  return candles;
}

module.exports = {
  calcRSI, calcEMA, evaluateSignal, buildCandles,
  RSI_PERIOD, RSI_BUY, RSI_SELL, KLINE_SEC,
  EMA_CONVERGE_PCT, RSI_DIVERGE_BARS,
};
