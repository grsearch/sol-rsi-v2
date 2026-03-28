// src/routes/dashboard.js — REST API
const express          = require('express');
const router           = express.Router();
const trader           = require('../trader');
const { TokenMonitor } = require('../monitor');

// GET /api/dashboard
router.get('/dashboard', (req, res) => {
  res.json(TokenMonitor.getInstance().getDashboardData());
});

// GET /api/tokens
router.get('/tokens', (req, res) => {
  const tokens = [...TokenMonitor.getInstance().tokens.values()].map(s => ({
    address:      s.address,
    symbol:       s.symbol,
    age:          s.age,
    lp:           s.lp,
    fdv:          s.fdv,
    currentPrice: s.currentPrice,
    entryPrice:   s.position?.entryPriceUsd ?? null,
    tokenBalance: s.position?.tokenBalance  ?? 0,
    pnlPct:       s.pnlPct,
    rsi:          isNaN(s.rsi) ? null : +s.rsi.toFixed(2),
    lastSignal:   s.lastSignal,
    inPosition:   s.inPosition,
    tradeCount:   s.tradeCount,
    totalPnlSol:  s.totalPnlSol,
    addedAt:      s.addedAt,
    exitSent:     s.exitSent,
    timeLeft:     Math.max(0, Math.round((
      parseInt(process.env.TOKEN_MAX_AGE_MINUTES || '10') * 60 * 1000 -
      (Date.now() - s.addedAt)
    ) / 1000)),
  }));
  res.json(tokens);
});

// GET /api/trades
router.get('/trades', (req, res) => {
  res.json(TokenMonitor.getInstance().tradeLog.slice(0, 100));
});

// GET /api/trade-records — 24h 完整交易记录（每笔交易一条）
router.get('/trade-records', (req, res) => {
  res.json(TokenMonitor.getInstance().getTradeRecords());
});

// DELETE /api/tokens/:address — 手动移除，有持仓先平仓
router.delete('/tokens/:address', async (req, res) => {
  const monitor = TokenMonitor.getInstance();
  const state   = monitor.tokens.get(req.params.address);

  if (!state) return res.status(404).json({ ok: false, error: 'Token not found' });

  if (state.inPosition && state.position && !state.exitSent) {
    state.managing = true;
    state.position = await trader.sell(state, 1.0, 'MANUAL_REMOVE');
    state.inPosition = false;
    state.lastSignal = 'SELL';
    monitor._closeTradeRecord(state, 'MANUAL_REMOVE');
    monitor._addTradeLog({ type: 'SELL', symbol: state.symbol, reason: 'MANUAL_REMOVE' });
    state.managing = false;
  }

  state.exitSent   = true;
  state.inPosition = false;
  state.position   = null;
  monitor._removeToken(state.address, 'MANUAL_REMOVE');
  res.json({ ok: true });
});

module.exports = router;
