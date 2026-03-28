// src/rsi.js — RSI calculation + BUY/SELL signal logic
//
// K线周期: KLINE_INTERVAL_SEC (默认 3 秒)
// 价格轮询: PRICE_POLL_SEC    (默认 1 秒)
//
// BUY  : RSI 由下往上穿越 RSI_BUY  (默认 30) → 开仓
// SELL : RSI 上升到 RSI_SELL (默认 75) → 平仓
// STOP : 当前价跌破入场价 -STOP_LOSS_PCT% → 止损平仓

'use strict';

const RSI_PERIOD = parseInt(process.env.RSI_PERIOD        || '7');
const RSI_BUY    = parseFloat(process.env.RSI_BUY         || '30');  // 上穿此值买入
const RSI_SELL   = parseFloat(process.env.RSI_SELL        || '75');  // 超过此值卖出
const KLINE_SEC  = parseInt(process.env.KLINE_INTERVAL_SEC || '3');

/**
 * 计算 RSI 数组（Wilder 平滑法，oldest-first 输入）
 * 返回与 closes 等长的数组，前 RSI_PERIOD 项为 NaN。
 */
function calcRSI(closes, period = RSI_PERIOD) {
  const result = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  // 首个 avgGain/avgLoss 用简单平均
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder 平滑
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

/**
 * 从已收盘K线计算当前 RSI 并给出信号。
 *
 * tokenState 读写字段: prevRsi
 * Returns: { rsi, signal: null|'BUY'|'SELL', reason }
 */
function evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const rsis   = calcRSI(closes, RSI_PERIOD);
  const len    = rsis.length;

  // 至少需要 RSI_PERIOD + 2 根才能判断穿越
  if (len < RSI_PERIOD + 2) {
    tokenState.prevRsi = NaN;
    return { rsi: NaN, signal: null, reason: 'warming_up' };
  }

  const rsiNow  = rsis[len - 1];
  const rsiPrev = rsis[len - 2];

  if (isNaN(rsiNow) || isNaN(rsiPrev)) {
    return { rsi: NaN, signal: null, reason: 'rsi_nan' };
  }

  // BUY：上一根 < RSI_BUY，这一根 >= RSI_BUY（金叉）
  if (rsiPrev < RSI_BUY && rsiNow >= RSI_BUY) {
    tokenState.prevRsi = rsiNow;
    return {
      rsi: rsiNow, signal: 'BUY',
      reason: `RSI上穿${RSI_BUY} (${rsiPrev.toFixed(1)}→${rsiNow.toFixed(1)})`,
    };
  }

  // SELL：RSI 超过 RSI_SELL
  if (rsiNow >= RSI_SELL) {
    tokenState.prevRsi = rsiNow;
    return {
      rsi: rsiNow, signal: 'SELL',
      reason: `RSI超过${RSI_SELL} (${rsiNow.toFixed(1)})`,
    };
  }

  tokenState.prevRsi = rsiNow;
  return { rsi: rsiNow, signal: null, reason: '' };
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

module.exports = { calcRSI, evaluateSignal, buildCandles, RSI_PERIOD, RSI_BUY, RSI_SELL, KLINE_SEC };
