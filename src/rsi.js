// src/rsi.js — RSI calculation + BUY/SELL signal logic
//
// K线周期: KLINE_INTERVAL_SEC (默认 3 秒)
// 价格轮询: PRICE_POLL_SEC    (默认 1 秒)
//
// BUY 触发条件（全部满足）：
//   1. RSI 上穿 RSI_BUY (30)
//   2. EMA9 与 EMA20 收敛：差值 < 价格 × EMA_CONVERGE_PCT (默认 3%)
//   3. RSI 底背离：本次 RSI 谷底 >= 上次 RSI 谷底（不再创新低）
//
// SELL 触发条件：
//   RSI 超过 RSI_SELL (75)
//
// STOP：当前价跌破入场价 -STOP_LOSS_PCT% → 止损（由 monitor.js 处理）

'use strict';

const RSI_PERIOD        = parseInt(process.env.RSI_PERIOD          || '7');
const RSI_BUY           = parseFloat(process.env.RSI_BUY           || '30');   // 上穿此值买入
const RSI_SELL          = parseFloat(process.env.RSI_SELL          || '75');   // 超过此值卖出
const KLINE_SEC         = parseInt(process.env.KLINE_INTERVAL_SEC  || '3');
// EMA 收敛阈值：EMA9 与 EMA20 的差值不能超过当前价格的此百分比
const EMA_CONVERGE_PCT  = parseFloat(process.env.EMA_CONVERGE_PCT  || '3');
// RSI 底背离：在最近 RSI_DIVERGE_BARS 根 K 线内寻找上一个谷底
const RSI_DIVERGE_BARS  = parseInt(process.env.RSI_DIVERGE_BARS    || '20');

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
// EMA9 与 EMA20 差值 < 当前价 × EMA_CONVERGE_PCT%
// 差值过大说明趋势强烈发散，不适合逆势买入
function checkEmaConverge(closes) {
  if (closes.length < 20) return { pass: false, reason: 'ema_warmup', ema9: NaN, ema20: NaN };

  const ema9s  = calcEMA(closes, 9);
  const ema20s = calcEMA(closes, 20);
  const len    = closes.length;
  const ema9   = ema9s[len - 1];
  const ema20  = ema20s[len - 1];
  const price  = closes[len - 1];

  if (isNaN(ema9) || isNaN(ema20) || price <= 0) {
    return { pass: false, reason: 'ema_nan', ema9, ema20 };
  }

  const gapPct = Math.abs(ema9 - ema20) / price * 100;
  const pass   = gapPct <= EMA_CONVERGE_PCT;

  return {
    pass,
    reason: pass
      ? `EMA收敛(gap=${gapPct.toFixed(2)}%<${EMA_CONVERGE_PCT}%)`
      : `EMA发散(gap=${gapPct.toFixed(2)}%>${EMA_CONVERGE_PCT}%)`,
    ema9,
    ema20,
    gapPct,
  };
}

// ── 过滤器2：RSI 底背离检查 ───────────────────────────────────
// 在最近 RSI_DIVERGE_BARS 根里，找上一个 RSI 谷底（局部最低点）。
// 要求：本次 RSI 谷底 >= 上次 RSI 谷底（RSI 底部在抬高）。
// 这说明卖压在减弱，是真实超卖反转而非趋势性下跌中的假反弹。
//
// "本次谷底" = 当前 RSI 上穿前的最低点
// "上次谷底" = 再往前一段时间内的最低点
function checkRsiDivergence(rsis, currentIdx) {
  // 向前找"本次谷底"：从当前往回，找到 RSI 开始回升前的最低点
  let thisTrough = Infinity;
  let i = currentIdx - 1;
  // 往回扫，直到找到一个局部低点（RSI 不再下降）
  while (i >= 0 && rsis[i] <= rsis[i + 1]) {
    if (!isNaN(rsis[i])) thisTrough = Math.min(thisTrough, rsis[i]);
    i--;
  }
  if (thisTrough === Infinity) return { pass: true, reason: 'no_prev_trough' };

  // 继续往回找"上次谷底"（在 RSI_DIVERGE_BARS 范围内）
  const searchStart = Math.max(0, i - RSI_DIVERGE_BARS);
  let prevTrough    = Infinity;
  for (let j = searchStart; j <= i; j++) {
    if (!isNaN(rsis[j])) prevTrough = Math.min(prevTrough, rsis[j]);
  }
  if (prevTrough === Infinity) return { pass: true, reason: 'no_prev_trough' };

  // 底背离：本次谷底 >= 上次谷底（RSI 底部在抬高）
  const pass = thisTrough >= prevTrough;
  return {
    pass,
    reason: pass
      ? `RSI底背离(本次谷底${thisTrough.toFixed(1)}≥上次${prevTrough.toFixed(1)})`
      : `RSI底部下沉(本次谷底${thisTrough.toFixed(1)}<上次${prevTrough.toFixed(1)})`,
    thisTrough,
    prevTrough,
  };
}

// ── 主信号评估 ────────────────────────────────────────────────
/**
 * 从已收盘K线计算信号。
 *
 * tokenState 读写字段: prevRsi, ema9, ema20, emaGapPct, filterReason
 * Returns: { rsi, ema9, ema20, emaGapPct, signal: null|'BUY'|'SELL', reason, blocked }
 */
function evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const rsis   = calcRSI(closes, RSI_PERIOD);
  const len    = closes.length;

  // 至少需要 RSI_PERIOD + 2 根才能判断穿越，且需要 20 根供 EMA20 预热
  const minBars = Math.max(RSI_PERIOD + 2, 22);
  if (len < minBars) {
    tokenState.prevRsi = NaN;
    return { rsi: NaN, ema9: NaN, ema20: NaN, emaGapPct: NaN, signal: null, reason: 'warming_up', blocked: false };
  }

  const rsiNow  = rsis[len - 1];
  const rsiPrev = rsis[len - 2];

  if (isNaN(rsiNow) || isNaN(rsiPrev)) {
    return { rsi: NaN, ema9: NaN, ema20: NaN, emaGapPct: NaN, signal: null, reason: 'rsi_nan', blocked: false };
  }

  // 始终计算 EMA 供 dashboard 显示
  const emaResult = checkEmaConverge(closes);
  tokenState.ema9      = emaResult.ema9;
  tokenState.ema20     = emaResult.ema20;
  tokenState.emaGapPct = emaResult.gapPct ?? NaN;

  // ── SELL：RSI 超过 RSI_SELL，不加过滤（卖出越快越好）────────
  if (rsiNow >= RSI_SELL) {
    tokenState.prevRsi = rsiNow;
    return {
      rsi: rsiNow, ema9: emaResult.ema9, ema20: emaResult.ema20, emaGapPct: emaResult.gapPct,
      signal: 'SELL',
      reason: `RSI超过${RSI_SELL} (${rsiNow.toFixed(1)})`,
      blocked: false,
    };
  }

  // ── BUY：RSI 上穿 RSI_BUY ────────────────────────────────────
  if (rsiPrev < RSI_BUY && rsiNow >= RSI_BUY) {
    tokenState.prevRsi = rsiNow;

    // 过滤器1：EMA 收敛
    if (!emaResult.pass) {
      logger.debug && logger.debug(`[RSI] BUY blocked — ${emaResult.reason}`);
      return {
        rsi: rsiNow, ema9: emaResult.ema9, ema20: emaResult.ema20, emaGapPct: emaResult.gapPct,
        signal: null,
        reason: `RSI上穿但过滤: ${emaResult.reason}`,
        blocked: true,
        blockReason: emaResult.reason,
      };
    }

    // 过滤器2：RSI 底背离
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

    // 两个过滤器均通过 → 发出 BUY 信号
    return {
      rsi: rsiNow, ema9: emaResult.ema9, ema20: emaResult.ema20, emaGapPct: emaResult.gapPct,
      signal: 'BUY',
      reason: `RSI上穿${RSI_BUY} + ${emaResult.reason} + ${divResult.reason}`,
      blocked: false,
    };
  }

  tokenState.prevRsi = rsiNow;
  return {
    rsi: rsiNow, ema9: emaResult.ema9, ema20: emaResult.ema20, emaGapPct: emaResult.gapPct,
    signal: null, reason: '', blocked: false,
  };
}

/**
 * 将原始价格 tick 聚合为固定宽度 OHLCV K线。
 * 空桶用前收盘前向填充。
 */
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
