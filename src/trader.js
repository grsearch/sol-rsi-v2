// src/trader.js — Jupiter swap executor
//
// 只负责链上交易执行，不含任何策略判断。
// 策略（RSI信号 + 止损）全部在 monitor.js 处理。
//
// 特性：
//   • Jupiter Ultra API swap quote + execute
//   • 动态滑点重试：每次重试 ×1.5，上限 20%
//   • 卖出滑点自动翻倍（确保止损单成交）
//   • 买入后立即重拉价格作为开仓基准

'use strict';

const {
  Connection, Keypair,
  VersionedTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58   = require('bs58');
const axios  = require('axios');
const logger = require('./logger');
const { broadcastToClients } = require('./wsHub');

// ── Config ─────────────────────────────────────────────────────
const HELIUS_RPC       = process.env.HELIUS_RPC_URL            || '';
const JUP_API          = process.env.JUPITER_API_URL           || 'https://api.jup.ag';
const JUP_API_KEY      = process.env.JUPITER_API_KEY           || '';
const SLIPPAGE_BPS     = parseInt(process.env.SLIPPAGE_BPS     || '500');  // 默认 5%
const SLIPPAGE_MAX_BPS = 2000;                                              // 重试上限 20%
const TRADE_SOL        = parseFloat(process.env.TRADE_SIZE_SOL || '0.2');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function jupHeaders() {
  return JUP_API_KEY ? { 'x-api-key': JUP_API_KEY } : {};
}

// ── Wallet ─────────────────────────────────────────────────────
let _keypair = null;
function getKeypair() {
  if (_keypair) return _keypair;
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('WALLET_PRIVATE_KEY not set');
  _keypair = Keypair.fromSecretKey(bs58.decode(pk));
  return _keypair;
}

// ── RPC connection ─────────────────────────────────────────────
let _conn = null;
function getConn() {
  if (_conn) return _conn;
  if (!HELIUS_RPC) throw new Error('HELIUS_RPC_URL not set');
  _conn = new Connection(HELIUS_RPC, 'confirmed');
  return _conn;
}

// ── Jupiter helpers ────────────────────────────────────────────
async function getSwapOrder({ inputMint, outputMint, amount, slippageBps }) {
  const { data } = await axios.get(`${JUP_API}/ultra/v1/order`, {
    params: {
      inputMint,
      outputMint,
      amount:      Math.floor(amount).toString(),
      slippageBps: slippageBps ?? SLIPPAGE_BPS,
      taker:       getKeypair().publicKey.toBase58(),
    },
    headers: jupHeaders(),
    timeout: 10000,
  });
  return data;
}

async function executeSwapOrder({ requestId, signedTransaction }) {
  const { data } = await axios.post(
    `${JUP_API}/ultra/v1/execute`,
    { requestId, signedTransaction },
    { headers: jupHeaders(), timeout: 30000 }
  );
  return data;
}

function signTx(base64Tx) {
  const kp  = getKeypair();
  const buf = Buffer.from(base64Tx, 'base64');
  const tx  = VersionedTransaction.deserialize(buf);
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString('base64');
}

// ── Dynamic-slippage retry ─────────────────────────────────────
// 每次重试重新拉报价 + 滑点 ×1.5，上限 SLIPPAGE_MAX_BPS
async function executeWithRetry(orderFn, retries = 3) {
  let slippage = SLIPPAGE_BPS;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const order    = await orderFn(slippage);
      const txBase64 = order.transaction;
      if (!txBase64) throw new Error(`Jupiter: no 'transaction' field. Keys: ${Object.keys(order).join(', ')}`);
      const result = await executeSwapOrder({
        requestId:         order.requestId,
        signedTransaction: signTx(txBase64),
      });
      if (result.status === 'Success') return result;
      logger.warn(`[Trader] status="${result.status}" attempt=${attempt} slip=${slippage}bps`);
    } catch (e) {
      logger.warn(`[Trader] attempt=${attempt} slip=${slippage}bps: ${e.message}`);
    }
    slippage = Math.min(Math.floor(slippage * 1.5), SLIPPAGE_MAX_BPS);
    if (attempt < retries) await sleep(1500 * attempt);
  }
  throw new Error(`Swap failed after ${retries} retries`);
}

// ── BUY ────────────────────────────────────────────────────────
// 返回 position 对象，失败返回 null
async function buy(tokenState) {
  const { address, symbol, currentPrice } = tokenState;
  const solLamports = Math.floor(TRADE_SOL * LAMPORTS_PER_SOL);
  logger.warn(`[Trader] BUY ${symbol} sol=${TRADE_SOL} price≈${currentPrice}`);

  try {
    const result = await executeWithRetry((slip) =>
      getSwapOrder({ inputMint: SOL_MINT, outputMint: address, amount: solLamports, slippageBps: slip })
    );

    const tokenBalance     = parseInt(result.outputAmountResult || '0') || 0;
    const solSpentLamports = parseInt(result.inputAmountResult  || String(solLamports)) || solLamports;

    // 买入后立即重拉价格，避免执行耗时导致止损基准偏移
    let entryPriceUsd = currentPrice;
    try {
      const fresh = await require('./birdeye').getPrice(address);
      if (fresh && fresh > 0) { entryPriceUsd = fresh; }
    } catch (_) {}

    const pos = {
      tokenBalance,
      initialBalance: tokenBalance,
      solSpent:       solSpentLamports / LAMPORTS_PER_SOL,
      entryPriceUsd,
      txBuy:          result.signature,
      openAt:         Date.now(),
    };

    logger.warn(
      `[Trader] BUY OK ${symbol}` +
      ` | sig=${result.signature?.slice(0, 12)}` +
      ` | tokens=${tokenBalance}` +
      ` | spent=${pos.solSpent.toFixed(4)} SOL` +
      ` | entry=${entryPriceUsd}`
    );
    _broadcast('BUY', symbol, address, entryPriceUsd, pos.solSpent, result.signature);
    return pos;
  } catch (e) {
    logger.warn(`[Trader] BUY FAILED ${symbol}: ${e.message}`);
    return null;
  }
}

// ── SELL ────────────────────────────────────────────────────────
// fraction: 卖出比例 (1.0 = 全仓)
// 返回更新后 position，全仓卖出返回 null
async function sell(tokenState, fraction, reason) {
  const { address, symbol, currentPrice, position } = tokenState;
  if (!position || position.tokenBalance <= 0) return null;

  const sellAmount = Math.floor(position.tokenBalance * fraction);
  if (sellAmount <= 0) return position;

  logger.warn(`[Trader] SELL ${(fraction * 100).toFixed(0)}% ${symbol} (${reason}) @ ${currentPrice}`);

  try {
    const result = await executeWithRetry((slip) =>
      getSwapOrder({
        inputMint:   address,
        outputMint:  SOL_MINT,
        amount:      sellAmount,
        slippageBps: Math.min(slip * 2, SLIPPAGE_MAX_BPS),  // 卖出滑点翻倍
      })
    );

    const outLamports = parseInt(result.outputAmountResult || '0') || 0;
    const solReceived = outLamports / LAMPORTS_PER_SOL;
    const newBalance  = position.tokenBalance - sellAmount;

    logger.warn(
      `[Trader] SELL OK ${symbol}` +
      ` | sig=${result.signature?.slice(0, 12)}` +
      ` | received=${solReceived.toFixed(4)} SOL` +
      ` | remaining=${newBalance}`
    );
    _broadcast('SELL', symbol, address, currentPrice, solReceived, result.signature, reason);

    if (newBalance <= 0) return null;
    return { ...position, tokenBalance: newBalance };
  } catch (e) {
    logger.warn(`[Trader] SELL FAILED ${symbol}: ${e.message}`);
    return position;  // 保持原仓位，下次重试
  }
}

// ── Helpers ────────────────────────────────────────────────────
function _broadcast(type, symbol, mint, price, amount, sig, reason = '') {
  broadcastToClients({
    type: 'trade',
    data: { id: Date.now(), time: new Date().toISOString(), tradeType: type, symbol, mint, price, amount, sig, reason },
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { buy, sell, getKeypair, getConn, TRADE_SOL };
