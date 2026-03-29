// src/monitor.js — Core monitoring engine (Singleton)
//
// ── 三层逻辑 ──────────────────────────────────────────────────
//
// 【收录门槛】webhook 进来时检查（_checkAdmission）：
//   FDV_MIN_USD($20000) ≤ FDV ≤ FDV_MAX_USD($50000)
//   LP ≥ LP_ADMIT_USD($5000)
//   → 通过则加入监控列表，开始拉价格 & RSI 计算
//
// 【买入条件】纯 RSI 策略，不再检查 FDV/LP：
//   RSI 上穿 RSI_BUY(30) + EMA 收敛 + RSI 底背离 → 买入
//
// 【强制退出】_checkExpiry 每 5s 轮询：
//   1. FDV < FDV_EXIT_USD($15000)  → 立即平仓并移除
//   2. LP  < LP_EXIT_USD($2000)    → 立即平仓并移除
//   3. 监控窗口到期（10min）        → 立即平仓并移除

'use strict';

const birdeye                          = require('./birdeye');
const { evaluateSignal, buildCandles } = require('./rsi');
const trader                           = require('./trader');
const { broadcastToClients }           = require('./wsHub');
const logger                           = require('./logger');

// ── 收录门槛 ──────────────────────────────────────────────────
const FDV_MIN_USD  = parseInt(process.env.FDV_MIN_USD  || '20000');  // 收录：FDV 下限
const FDV_MAX_USD  = parseInt(process.env.FDV_MAX_USD  || '50000');  // 收录：FDV 上限
const LP_ADMIT_USD = parseInt(process.env.LP_MIN_USD   || '5000');   // 收录：LP 下限

// ── 强制退出门槛 ───────────────────────────────────────────────
const FDV_EXIT_USD = parseInt(process.env.FDV_EXIT_USD || '15000');  // 退出：FDV 跌破此值
const LP_EXIT_USD  = parseInt(process.env.LP_EXIT_USD  || '2000');   // 退出：LP 跌破此值

// ── 其他参数 ───────────────────────────────────────────────────
const PRICE_POLL_SEC     = parseInt(process.env.PRICE_POLL_SEC        || '1');
const KLINE_INTERVAL_SEC = parseInt(process.env.KLINE_INTERVAL_SEC    || '3');
const TOKEN_MAX_AGE_MIN  = parseInt(process.env.TOKEN_MAX_AGE_MINUTES || '10');
const STOP_LOSS_PCT      = parseFloat(process.env.STOP_LOSS_PCT       || '20');

const MAX_TICKS = 600;

class TokenMonitor {
  static instance = null;
  static getInstance() {
    if (!TokenMonitor.instance) TokenMonitor.instance = new TokenMonitor();
    return TokenMonitor.instance;
  }

  constructor() {
    this.tokens       = new Map();
    this.tradeLog     = [];
    this.tradeRecords = [];
    this._pollTimer   = null;
    this._klineTimer  = null;
    this._metaTimer   = null;
    this._ageTimer    = null;
    this._dashTimer   = null;
    this._fdvTimer    = null;
  }

  // ── 收录代币 ─────────────────────────────────────────────────
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
      position:     null,
      pnlPct:       null,
      inPosition:   false,
      managing:     false,
      ema9:         NaN,
      ema20:        NaN,
      emaGapPct:    NaN,
      filterReason: '',
      tradeCount:   0,
      totalPnlSol:  0,
      exitSent:     false,
    };

    this.tokens.set(address, state);
    logger.info(`[Monitor] ✅ Added: ${state.symbol} (${address})`);

    // 异步做收录门槛检查，不阻塞 webhook 响应
    this._checkAdmission(state);

    broadcastToClients({ type: 'token_added', data: this._stateView(state) });
    return { ok: true };
  }

  // ── 【收录门槛】FDV $20K~$50K，LP ≥ $5K ─────────────────────
  async _checkAdmission(state) {
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

    if (state.fdv === null) {
      this._reject(state, 'FDV_UNKNOWN'); return;
    }
    if (state.fdv < FDV_MIN_USD) {
      this._reject(state, `FDV_TOO_LOW($${state.fdv})`); return;
    }
    if (state.fdv > FDV_MAX_USD) {
      this._reject(state, `FDV_TOO_HIGH($${state.fdv})`); return;
    }
    if (state.lp === null) {
      this._reject(state, 'LP_UNKNOWN'); return;
    }
    if (state.lp < LP_ADMIT_USD) {
      this._reject(state, `LP_TOO_LOW($${state.lp})`); return;
    }

    logger.warn(
      `[Monitor] ✅ ADMITTED ${state.symbol}` +
      ` FDV=$${state.fdv?.toLocaleString()}` +
      ` LP=$${state.lp?.toLocaleString()}` +
      ` — 开始监控 ${TOKEN_MAX_AGE_MIN}min`
    );
  }

  _reject(state, reason) {
    logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${reason}`);
    state.exitSent = true;
    setTimeout(() => this._removeToken(state.address, reason), 500);
  }

  // ── 启动定时器 ────────────────────────────────────────────────
  start() {
    logger.info(
      `[Monitor] Starting` +
      ` | admit FDV $${FDV_MIN_USD}~$${FDV_MAX_USD} LP≥$${LP_ADMIT_USD}` +
      ` | exit FDV<$${FDV_EXIT_USD} LP<$${LP_EXIT_USD}` +
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

        if (state.inPosition && state.position && !state.managing) {
          state.managing = true;
          try { await this._checkStopLoss(state); }
          finally { state.managing = false; }
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
  // 买入：纯 RSI 策略，不检查 FDV/LP
  async _evaluateAll() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent || !state.ticks.length) continue;

      state.candles = buildCandles(state.ticks, KLINE_INTERVAL_SEC);
      const closed  = state.candles.length > 1 ? state.candles.slice(0, -1) : state.candles;

      const result  = evaluateSignal(closed, state);
      state.rsi     = result.rsi;
      if (!isNaN(result.ema9))      state.ema9      = result.ema9;
      if (!isNaN(result.ema20))     state.ema20     = result.ema20;
      if (!isNaN(result.emaGapPct)) state.emaGapPct = result.emaGapPct;

      if (state.managing) continue;

      if (result.signal === 'BUY' && !state.inPosition) {
        state.filterReason = '';
        logger.warn(`[Monitor] RSI BUY ${state.symbol} — ${result.reason}`);
        state.managing = true;
        try { await this._doBuy(state, result.reason); }
        finally { state.managing = false; }

      } else if (result.blocked) {
        if (state.filterReason !== result.blockReason) {
          state.filterReason = result.blockReason || result.reason;
          logger.info(`[Monitor] BUY filtered ${state.symbol} — ${state.filterReason}`);
        }

      } else if (result.signal === 'SELL' && state.inPosition) {
        state.filterReason = '';
        logger.warn(`[Monitor] RSI SELL ${state.symbol} — ${result.reason}`);
        state.managing = true;
        try { await this._doSell(state, result.reason); }
        finally { state.managing = false; }
      }
    }
  }

  // ── 开仓 ─────────────────────────────────────────────────────
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

  // ── 平仓 ─────────────────────────────────────────────────────
  async _doSell(state, reason) {
    if (!state.position || !state.inPosition) return;
    const prevPos    = state.position;
    state.position   = await trader.sell(state, 1.0, reason);
    state.inPosition = false;
    state.lastSignal = 'SELL';
    const pnl        = state.pnlPct ? parseFloat(state.pnlPct) : 0;
    state.tradeCount++;
    state.totalPnlSol += prevPos.solSpent * pnl / 100;
    this._addTradeLog({ type: 'SELL', symbol: state.symbol, reason });
    this._closeTradeRecord(state, reason);
    logger.warn(`[Monitor] ✅ SELL OK ${state.symbol} reason=${reason} pnl=${pnl.toFixed(1)}%`);
  }

  // ── Meta 刷新（每 30s）───────────────────────────────────────
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

  // ── 【强制退出】到期 + FDV/LP 跌破退出线（每 5s）────────────
  async _checkExpiry() {
    const maxMs = TOKEN_MAX_AGE_MIN * 60 * 1000;

    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;

      // 1. 监控窗口到期
      if (Date.now() - state.addedAt >= maxMs) {
        await this._forceExit(state, `EXPIRED_${TOKEN_MAX_AGE_MIN}min`);
        continue;
      }

      // 2. FDV 跌破退出线（有数据才判断，避免刚收录时 fdv=null 误踢）
      if (state.fdv !== null && state.fdv < FDV_EXIT_USD) {
        logger.warn(`[Monitor] ⚠️  ${state.symbol} FDV=$${state.fdv} < 退出线 $${FDV_EXIT_USD}`);
        await this._forceExit(state, `FDV_DROPPED($${state.fdv})`);
        continue;
      }

      // 3. LP 跌破退出线
      if (state.lp !== null && state.lp < LP_EXIT_USD) {
        logger.warn(`[Monitor] ⚠️  ${state.symbol} LP=$${state.lp} < 退出线 $${LP_EXIT_USD}`);
        await this._forceExit(state, `LP_DROPPED($${state.lp})`);
        continue;
      }
    }
  }

  async _forceExit(state, reason) {
    state.exitSent = true;
    if (state.inPosition && state.position && !state.managing) {
      logger.info(`[Monitor] ⏏  Force exit with sell: ${state.symbol} — ${reason}`);
      state.managing = true;
      await this._doSell(state, reason);
      state.managing = false;
    } else {
      logger.info(`[Monitor] ⏏  Force exit (no position): ${state.symbol} — ${reason}`);
    }
    setTimeout(() => this._removeToken(state.address, reason), 3000);
  }

  _removeToken(addr, reason) {
    const s = this.tokens.get(addr);
    if (s) {
      logger.info(`[Monitor] 🗑  Removed ${s.symbol} — ${reason}`);
      this.tokens.delete(addr);
      broadcastToClients({ type: 'token_removed', data: { address: addr, reason } });
    }
  }

  // ── 交易记录 ──────────────────────────────────────────────────
  _openTradeRecord(state, pos, reason) {
    const rec = {
      id:           `${state.address}_${pos.openAt}`,
      address:      state.address,
      symbol:       state.symbol,
      buyAt:        pos.openAt,
      buyReason:    reason,
      entryFdv:     state.fdv,
      entryLp:      state.lp,
      entryLpFdv:   state.fdv ? +((state.lp / state.fdv) * 100).toFixed(1) : null,
      xMentions:    state.xMentions,
      holders:      state.holders,
      top10Pct:     state.top10Pct,
      devPct:       state.devPct,
      solSpent:     pos.solSpent,
      entryPrice:   pos.entryPriceUsd,
      exitAt:       null,
      exitReason:   null,
      exitFdv:      null,
      exitPrice:    null,
      solReceived:  null,
      pnlPct:       null,
      currentFdv:   state.fdv,
      fdvUpdatedAt: Date.now(),
    };
    this.tradeRecords.unshift(rec);
    this._pruneRecords();
  }

  _closeTradeRecord(state, reason) {
    const rec = this.tradeRecords.find(r => r.address === state.address && r.exitAt === null);
    if (!rec) return;
    rec.exitAt      = Date.now();
    rec.exitReason  = reason;
    rec.exitFdv     = state.fdv;
    rec.exitPrice   = state.currentPrice;
    rec.pnlPct      = state.pnlPct;
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
      rsi:          isNaN(s.rsi)       ? null : +s.rsi.toFixed(2),
      ema9:         isNaN(s.ema9)      ? null : +s.ema9.toFixed(8),
      ema20:        isNaN(s.ema20)     ? null : +s.ema20.toFixed(8),
      emaGapPct:    isNaN(s.emaGapPct) ? null : +s.emaGapPct.toFixed(2),
      filterReason: s.filterReason    || '',
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
