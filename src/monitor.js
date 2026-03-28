// src/monitor.js — Core monitoring engine (Singleton)
//
// 策略：RSI(14) on 3秒K线，10分钟监控窗口，支持多次买卖
//
// 收录流程：
//   webhook → FDV/LP 门槛检查 → 通过则开始监控（不自动买入）
//   → 每1秒拉价格 → 每3秒K线评估 RSI 信号 → 买入/卖出/止损
//
// 出场信号（持仓中）：
//   1. 止损    当前价 < 入场价 × (1 - STOP_LOSS_PCT/100)
//   2. RSI卖出 RSI >= RSI_SELL (75)
//
// 买入信号（空仓中）：
//   RSI 上穿 RSI_BUY (30) → 买入一次
//
// 多次买卖：
//   10分钟内可以反复开仓/平仓，每次都记录独立 tradeRecord
//   同一时刻只允许持有一个仓位（inPosition=true 时不再买入）
//
// 到期：10分钟后若有持仓则平仓并移除，否则直接移除

'use strict';

const birdeye                         = require('./birdeye');
const { evaluateSignal, buildCandles } = require('./rsi');
const trader                          = require('./trader');
const { broadcastToClients }          = require('./wsHub');
const logger                          = require('./logger');

const PRICE_POLL_SEC     = parseInt(process.env.PRICE_POLL_SEC        || '1');
const KLINE_INTERVAL_SEC = parseInt(process.env.KLINE_INTERVAL_SEC    || '3');
const TOKEN_MAX_AGE_MIN  = parseInt(process.env.TOKEN_MAX_AGE_MINUTES || '10');
const FDV_MIN_USD        = parseInt(process.env.FDV_MIN_USD           || '20000');
const FDV_MAX_USD        = parseInt(process.env.FDV_MAX_USD           || '50000');
const LP_MIN_USD         = parseInt(process.env.LP_MIN_USD            || '5000');
const STOP_LOSS_PCT      = parseFloat(process.env.STOP_LOSS_PCT       || '20');

// 最多保留 10 分钟的 tick（1秒轮询 → 600 条）
const MAX_TICKS = 600;

class TokenMonitor {
  static instance = null;
  static getInstance() {
    if (!TokenMonitor.instance) TokenMonitor.instance = new TokenMonitor();
    return TokenMonitor.instance;
  }

  constructor() {
    this.tokens       = new Map();  // address → TokenState
    this.tradeLog     = [];         // 最近 200 条实时 feed
    this.tradeRecords = [];         // 24h 完整交易记录（以每笔交易为单位）
    this._pollTimer   = null;
    this._klineTimer  = null;
    this._metaTimer   = null;
    this._ageTimer    = null;
    this._dashTimer   = null;
    this._fdvTimer    = null;
  }

  // ── Add token ────────────────────────────────────────────────
  async addToken({ address, symbol, network = 'solana', xMentions, holders, top10Pct, devPct }) {
    if (this.tokens.has(address)) {
      logger.info(`[Monitor] Already tracking: ${symbol} (${address.slice(0, 8)})`);
      return { ok: false, reason: 'already_exists' };
    }

    const state = {
      address,
      symbol:       symbol || address.slice(0, 8),
      network,
      addedAt:      Date.now(),
      ticks:        [],
      candles:      [],
      currentPrice: null,
      rsi:          NaN,
      prevRsi:      NaN,
      lastSignal:   null,
      fdv:          null,
      lp:           null,
      age:          null,
      xMentions:    xMentions ?? null,
      holders:      holders   ?? null,
      top10Pct:     top10Pct  ?? null,
      devPct:       devPct    ?? null,
      // 仓位
      position:     null,
      pnlPct:       null,
      inPosition:   false,
      managing:     false,       // 防并发锁
      // 统计（本币种本次监控期内的汇总）
      tradeCount:   0,           // 本次监控期完成的交易笔数
      totalPnlSol:  0,           // 本次监控期净盈亏 SOL
      exitSent:     false,
    };

    this.tokens.set(address, state);
    logger.info(`[Monitor] ✅ Added: ${state.symbol} (${address})`);

    // 异步拉 meta 做门槛检查，不阻塞 webhook 响应
    this._checkMetaAndActivate(state);

    broadcastToClients({ type: 'token_added', data: this._stateView(state) });
    return { ok: true };
  }

  // ── FDV/LP 门槛检查 ──────────────────────────────────────────
  async _checkMetaAndActivate(state) {
    try {
      const overview = await birdeye.getTokenOverview(state.address);
      if (overview) {
        state.fdv    = overview.fdv ?? overview.mc ?? null;
        state.lp     = overview.liquidity ?? null;
        state.symbol = overview.symbol || state.symbol;
        const created = overview.createdAt || overview.created_at || null;
        if (created) state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
      }
    } catch (e) {
      logger.warn(`[Monitor] meta error ${state.symbol}: ${e.message}`);
    }

    if (state.fdv === null || state.fdv < FDV_MIN_USD) {
      const r = state.fdv === null ? 'FDV_UNKNOWN' : `FDV_TOO_LOW($${state.fdv})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${r}`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, r), 500);
      return;
    }
    if (state.fdv > FDV_MAX_USD) {
      const r = `FDV_TOO_HIGH($${state.fdv})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${r}`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, r), 500);
      return;
    }
    if (state.lp === null || state.lp < LP_MIN_USD) {
      const r = state.lp === null ? 'LP_UNKNOWN' : `LP_TOO_LOW($${state.lp})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${r}`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, r), 500);
      return;
    }

    logger.warn(
      `[Monitor] ✅ ${state.symbol}` +
      ` FDV=$${state.fdv?.toLocaleString()}` +
      ` LP=$${state.lp?.toLocaleString()}` +
      ` — 开始监控 ${TOKEN_MAX_AGE_MIN}min`
    );
  }

  // ── Start timers ─────────────────────────────────────────────
  start() {
    logger.info(
      `[Monitor] Starting — poll ${PRICE_POLL_SEC}s | kline ${KLINE_INTERVAL_SEC}s` +
      ` | window ${TOKEN_MAX_AGE_MIN}min | SL ${STOP_LOSS_PCT}%`
    );
    this._pollTimer  = setInterval(() => this._pollPrices(),  PRICE_POLL_SEC * 1000);
    this._klineTimer = setInterval(() => this._evaluateAll(), KLINE_INTERVAL_SEC * 1000);
    this._metaTimer  = setInterval(async () => {
      for (const s of this.tokens.values()) {
        if (!s.exitSent) await this._refreshMeta(s);
        await sleep(100);
      }
    }, 30_000);
    this._ageTimer  = setInterval(() => this._checkExpiry(), 5_000);
    this._dashTimer = setInterval(() => {
      broadcastToClients({ type: 'update', data: this.getDashboardData() });
    }, 3000);
    this._fdvTimer  = setInterval(() => this._refreshTradeRecordFdv(), 15 * 60 * 1000);
  }

  stop() {
    [this._pollTimer, this._klineTimer, this._metaTimer, this._ageTimer, this._dashTimer, this._fdvTimer]
      .forEach(t => t && clearInterval(t));
    logger.info('[Monitor] Stopped');
  }

  // ── 价格轮询 + 止损检查（每 PRICE_POLL_SEC 秒）──────────────
  async _pollPrices() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;

      const price = await birdeye.getPrice(addr);
      if (price !== null && price > 0) {
        state.currentPrice = price;
        state.ticks.push({ time: Date.now(), price });
        if (state.ticks.length > MAX_TICKS) state.ticks.shift();

        // 持仓中：每秒检查止损
        if (state.inPosition && state.position && !state.managing) {
          state.managing = true;
          try {
            await this._checkStopLoss(state);
          } finally {
            state.managing = false;
          }
        }
      }
      await sleep(10);
    }
  }

  // ── 止损检查 ─────────────────────────────────────────────────
  async _checkStopLoss(state) {
    const { position, currentPrice, symbol } = state;
    if (!position || !currentPrice) return;

    const pnlPct = (currentPrice - position.entryPriceUsd) / position.entryPriceUsd * 100;
    state.pnlPct = pnlPct.toFixed(2);

    if (pnlPct <= -STOP_LOSS_PCT) {
      logger.warn(`[Monitor] STOP-LOSS ${symbol} PnL=${pnlPct.toFixed(1)}%`);
      await this._doSell(state, `STOP_LOSS_${STOP_LOSS_PCT}%`);
    }
  }

  // ── RSI 信号评估（每 KLINE_INTERVAL_SEC 秒）─────────────────
  async _evaluateAll() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent || !state.ticks.length) continue;

      state.candles = buildCandles(state.ticks, KLINE_INTERVAL_SEC);
      // 只用已收盘的 K 线评估（去掉最后一根正在进行的）
      const closed = state.candles.length > 1 ? state.candles.slice(0, -1) : state.candles;

      const result = evaluateSignal(closed, state);
      state.rsi = result.rsi;

      if (state.managing) continue;  // 止损正在执行，跳过

      if (result.signal === 'BUY' && !state.inPosition) {
        // 空仓 + RSI 上穿买入线 → 开仓
        logger.warn(`[Monitor] RSI BUY ${state.symbol} — ${result.reason}`);
        state.managing = true;
        try {
          await this._doBuy(state, result.reason);
        } finally {
          state.managing = false;
        }

      } else if (result.signal === 'SELL' && state.inPosition) {
        // 持仓 + RSI 超过卖出线 → 平仓
        logger.warn(`[Monitor] RSI SELL ${state.symbol} — ${result.reason}`);
        state.managing = true;
        try {
          await this._doSell(state, result.reason);
        } finally {
          state.managing = false;
        }
      }
    }
  }

  // ── 开仓 ────────────────────────────────────────────────────
  async _doBuy(state, reason) {
    const pos = await trader.buy(state);
    if (!pos) {
      logger.warn(`[Monitor] ⚠️  ${state.symbol} 买入失败`);
      return;
    }
    state.position   = pos;
    state.inPosition = true;
    state.lastSignal = 'BUY';
    state.pnlPct     = '0.00';

    this._addTradeLog({ type: 'BUY', symbol: state.symbol, reason });
    this._openTradeRecord(state, pos, reason);
    logger.warn(`[Monitor] ✅ BUY OK ${state.symbol} entry=${pos.entryPriceUsd}`);
  }

  // ── 平仓 ────────────────────────────────────────────────────
  async _doSell(state, reason) {
    if (!state.position || !state.inPosition) return;
    const prevPos = state.position;

    state.position = await trader.sell(state, 1.0, reason);
    state.inPosition = false;
    state.lastSignal = 'SELL';

    const pnl = state.pnlPct ? parseFloat(state.pnlPct) : 0;
    state.tradeCount++;
    state.totalPnlSol += prevPos.solSpent * pnl / 100;

    this._addTradeLog({ type: 'SELL', symbol: state.symbol, reason });
    this._closeTradeRecord(state, reason);
    logger.warn(`[Monitor] ✅ SELL OK ${state.symbol} reason=${reason} pnl=${pnl.toFixed(1)}%`);
  }

  // ── Meta refresh ─────────────────────────────────────────────
  async _refreshMeta(state) {
    try {
      const ov = await birdeye.getTokenOverview(state.address);
      if (!ov) return;
      state.fdv    = ov.fdv ?? ov.mc ?? null;
      state.lp     = ov.liquidity ?? null;
      state.symbol = ov.symbol || state.symbol;
      const created = ov.createdAt || ov.created_at || null;
      if (created) state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
    } catch (_) {}
  }

  // ── 到期检查（每 5s）────────────────────────────────────────
  async _checkExpiry() {
    const maxMs = TOKEN_MAX_AGE_MIN * 60 * 1000;
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;
      if (Date.now() - state.addedAt < maxMs) continue;

      state.exitSent = true;

      if (state.inPosition && state.position) {
        logger.info(`[Monitor] ⏰ Expired, selling: ${state.symbol}`);
        state.managing = true;
        await this._doSell(state, `EXPIRED_${TOKEN_MAX_AGE_MIN}min`);
        state.managing = false;
      } else {
        logger.info(`[Monitor] ⏰ Expired (no position): ${state.symbol}`);
      }
      setTimeout(() => this._removeToken(addr, 'EXPIRED'), 3000);
    }
  }

  _removeToken(addr, reason) {
    const s = this.tokens.get(addr);
    if (s) {
      logger.info(`[Monitor] 🗑  Removed ${s.symbol} — ${reason}`);
      this.tokens.delete(addr);
      broadcastToClients({ type: 'token_removed', data: { address: addr, reason } });
    }
  }

  // ── 交易记录（每笔交易独立，stats 页以笔为单位）─────────────
  _openTradeRecord(state, pos, reason) {
    const rec = {
      // 唯一 ID = address + 开仓时间戳，支持同一币种多笔
      id:           `${state.address}_${pos.openAt}`,
      address:      state.address,
      symbol:       state.symbol,
      buyAt:        pos.openAt,
      buyReason:    reason,
      // 入场时元数据
      entryFdv:     state.fdv,
      entryLp:      state.lp,
      entryLpFdv:   state.fdv ? +((state.lp / state.fdv) * 100).toFixed(1) : null,
      xMentions:    state.xMentions,
      holders:      state.holders,
      top10Pct:     state.top10Pct,
      devPct:       state.devPct,
      // 交易数据
      solSpent:     pos.solSpent,
      entryPrice:   pos.entryPriceUsd,
      // 待填（平仓后填入）
      exitAt:       null,
      exitReason:   null,
      exitFdv:      null,
      exitPrice:    null,
      solReceived:  null,
      pnlPct:       null,
      // 当前 FDV（定期刷新）
      currentFdv:   state.fdv,
      fdvUpdatedAt: Date.now(),
    };

    this.tradeRecords.unshift(rec);
    this._pruneRecords();
  }

  _closeTradeRecord(state, reason) {
    // 找最近一条未关闭的同地址记录
    const rec = this.tradeRecords.find(r => r.address === state.address && r.exitAt === null);
    if (!rec) return;

    rec.exitAt     = Date.now();
    rec.exitReason = reason;
    rec.exitFdv    = state.fdv;
    rec.exitPrice  = state.currentPrice;
    rec.pnlPct     = state.pnlPct;

    if (state.pnlPct != null && rec.solSpent) {
      const pnl = parseFloat(state.pnlPct) / 100;
      rec.solReceived = +(rec.solSpent * (1 + pnl)).toFixed(4);
    }
  }

  _pruneRecords() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.tradeRecords = this.tradeRecords.filter(r => r.buyAt > cutoff);
  }

  async _refreshTradeRecordFdv() {
    this._pruneRecords();
    for (const rec of this.tradeRecords) {
      try {
        const ov = await birdeye.getTokenOverview(rec.address);
        if (ov) { rec.currentFdv = ov.fdv ?? ov.mc ?? rec.currentFdv; rec.fdvUpdatedAt = Date.now(); }
      } catch (_) {}
      await sleep(200);
    }
  }

  getTradeRecords() {
    this._pruneRecords();
    return this.tradeRecords;
  }

  _addTradeLog(entry) {
    const log = { id: Date.now(), time: new Date().toISOString(), ...entry };
    this.tradeLog.unshift(log);
    if (this.tradeLog.length > 200) this.tradeLog.length = 200;
    broadcastToClients({ type: 'trade_log', data: log });
  }

  _stateView(s) {
    const pos = s.position;
    return {
      address:      s.address,
      symbol:       s.symbol,
      age:          s.age,
      lp:           s.lp,
      fdv:          s.fdv,
      currentPrice: s.currentPrice,
      entryPrice:   pos?.entryPriceUsd ?? null,
      tokenBalance: pos?.tokenBalance  ?? 0,
      pnlPct:       s.pnlPct,
      rsi:          isNaN(s.rsi) ? null : +s.rsi.toFixed(2),
      lastSignal:   s.lastSignal,
      candleCount:  s.candles.length,
      tickCount:    s.ticks.length,
      addedAt:      s.addedAt,
      inPosition:   s.inPosition,
      exitSent:     s.exitSent,
      tradeCount:   s.tradeCount,
      totalPnlSol:  +s.totalPnlSol.toFixed(4),
      timeLeft:     Math.max(0, Math.round((TOKEN_MAX_AGE_MIN * 60 * 1000 - (Date.now() - s.addedAt)) / 1000)),
      recentCandles: s.candles.slice(-120),
    };
  }

  getDashboardData() {
    return {
      tokens:     [...this.tokens.values()].map(s => this._stateView(s)),
      tradeLog:   this.tradeLog.slice(0, 100),
      uptime:     process.uptime(),
      tokenCount: this.tokens.size,
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { TokenMonitor };
