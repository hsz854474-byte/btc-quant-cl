import { mkdir, writeFile } from "node:fs/promises";

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const PAPER_START_TIME = 1785211200000;
const MARKET_URL = "https://data-api.binance.vision/api/v3/klines";
const OUTPUT_PATH = new URL("../state/paper.json", import.meta.url);

const SETTINGS = {
  initialCash: 100000,
  riskPct: 0.5,
  maxAllocationPct: 20,
  feePct: 0.1,
  slippagePct: 0.05,
  breakoutBars: 20,
  fastEma: 20,
  slowEma: 50,
  atrPeriod: 14,
  atrMultiplier: 2.5,
};

function ema(values, period) {
  const result = [];
  const multiplier = 2 / (period + 1);
  values.forEach((value, index) => {
    result.push(
      index === 0
        ? value
        : value * multiplier + result[index - 1] * (1 - multiplier),
    );
  });
  return result;
}

function atr(candles, period) {
  const ranges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  return ema(ranges, period);
}

function nextRunTime(now = Date.now()) {
  return Math.floor(now / FOUR_HOURS) * FOUR_HOURS + FOUR_HOURS + FIVE_MINUTES;
}

async function fetchClosedCandles() {
  const startTime = PAPER_START_TIME - 120 * FOUR_HOURS;
  const response = await fetch(
    `${MARKET_URL}?symbol=BTCUSDT&interval=4h&limit=1000&startTime=${startTime}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Binance market data returned HTTP ${response.status}`);
  }

  const rows = await response.json();
  const now = Date.now();
  const candles = rows
    .filter((row) => Number(row[6]) < now)
    .map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .filter((candle) => Object.values(candle).every(Number.isFinite))
    .sort((a, b) => a.time - b.time);

  if (candles.length < 80) {
    throw new Error(`Only ${candles.length} closed 4H candles were returned`);
  }
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()];
}

function createAccount(anchor) {
  return {
    version: 3,
    strategyVersion: "trend-breakout-v0.3",
    startedAt: PAPER_START_TIME,
    lastProcessedTime: anchor.time,
    cash: SETTINGS.initialCash,
    quantity: 0,
    averageEntry: 0,
    entryCost: 0,
    stopPrice: 0,
    highestSinceEntry: 0,
    trades: [],
    snapshots: [{ time: anchor.time, equity: SETTINGS.initialCash }],
    lastEvent: "云端模拟账户已建立，等待下一根4小时K线收盘。",
  };
}

function syncAccount(existing, candles) {
  const account = structuredClone(existing);
  const closes = candles.map((candle) => candle.close);
  const fast = ema(closes, SETTINGS.fastEma);
  const slow = ema(closes, SETTINGS.slowEma);
  const ranges = atr(candles, SETTINGS.atrPeriod);
  const warmup =
    Math.max(SETTINGS.slowEma, SETTINGS.breakoutBars, SETTINGS.atrPeriod) + 2;
  const newEvents = [];

  candles.forEach((candle, index) => {
    if (index < warmup || candle.time <= account.lastProcessedTime) return;

    const breakout = Math.max(
      ...candles
        .slice(index - SETTINGS.breakoutBars, index)
        .map((item) => item.high),
    );
    const trendUp = fast[index] > slow[index] && candle.close > slow[index];
    const feeRate = SETTINGS.feePct / 100;
    const slippageRate = SETTINGS.slippagePct / 100;

    if (account.quantity === 0 && trendUp && candle.close > breakout) {
      const price = candle.close * (1 + slippageRate);
      const stop = price - ranges[index] * SETTINGS.atrMultiplier;
      const riskPerUnit = Math.max(price - stop, price * 0.005);
      const quantityByRisk =
        (account.cash * (SETTINGS.riskPct / 100)) / riskPerUnit;
      const quantityByAllocation =
        (account.cash * (SETTINGS.maxAllocationPct / 100)) /
        (price * (1 + feeRate));
      const quantity = Math.min(quantityByRisk, quantityByAllocation);

      if (quantity > 0) {
        const value = quantity * price;
        const fee = value * feeRate;
        account.cash -= value + fee;
        account.quantity = quantity;
        account.averageEntry = price;
        account.entryCost = value + fee;
        account.stopPrice = stop;
        account.highestSinceEntry = candle.high;
        const trade = {
          id: candle.time,
          side: "买入",
          time: candle.time,
          price,
          quantity,
          fee,
          reason: `趋势向上并突破 ${SETTINGS.breakoutBars} 根K线高点`,
        };
        account.trades.unshift(trade);
        newEvents.push(trade);
        account.lastEvent = trade.reason;
      }
    } else if (account.quantity > 0) {
      account.highestSinceEntry = Math.max(
        account.highestSinceEntry,
        candle.high,
      );
      account.stopPrice = Math.max(
        account.stopPrice,
        account.highestSinceEntry - ranges[index] * SETTINGS.atrMultiplier,
      );
      const trendExit = fast[index] < slow[index];
      const stopExit = candle.close <= account.stopPrice;

      if (trendExit || stopExit) {
        const reference = stopExit
          ? Math.min(candle.close, account.stopPrice)
          : candle.close;
        const price = reference * (1 - slippageRate);
        const value = account.quantity * price;
        const fee = value * feeRate;
        const pnl = value - fee - account.entryCost;
        const trade = {
          id: candle.time,
          side: "卖出",
          time: candle.time,
          price,
          quantity: account.quantity,
          fee,
          pnl,
          reason: stopExit ? "触发 ATR 动态保护价" : "快线跌破慢线，趋势转弱",
        };
        account.cash += value - fee;
        account.quantity = 0;
        account.averageEntry = 0;
        account.entryCost = 0;
        account.stopPrice = 0;
        account.highestSinceEntry = 0;
        account.trades.unshift(trade);
        newEvents.push(trade);
        account.lastEvent = trade.reason;
      }
    }

    account.snapshots.push({
      time: candle.time,
      equity: account.cash + account.quantity * candle.close,
    });
    account.lastProcessedTime = candle.time;
  });

  account.trades = account.trades.slice(0, 200);
  account.snapshots = account.snapshots.slice(-2200);
  return { account, newEvents };
}

function buildWeeklyReport(account, latestPrice) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentSnapshots = account.snapshots.filter(
    (snapshot) => snapshot.time >= cutoff,
  );
  const startEquity =
    recentSnapshots[0]?.equity ??
    account.snapshots[0]?.equity ??
    account.cash;
  const endEquity = account.cash + account.quantity * latestPrice;
  const recentTrades = account.trades.filter((trade) => trade.time >= cutoff);
  const realizedPnl = recentTrades.reduce(
    (sum, trade) => sum + (trade.pnl ?? 0),
    0,
  );
  const returnPct = startEquity
    ? (endEquity / startEquity - 1) * 100
    : 0;

  return {
    returnPct,
    startEquity,
    endEquity,
    tradeCount: recentTrades.length,
    realizedPnl,
    status:
      recentSnapshots.length <= 1
        ? "记录期刚开始，等待更多4小时K线"
        : returnPct >= 0
          ? "本周风险受控，继续观察"
          : "本周处于回撤，暂不扩大风险",
  };
}

const started = Date.now();
const candles = await fetchClosedCandles();
const latest = candles.at(-1);
const anchorIndex = candles.findLastIndex(
  (candle) => candle.time <= PAPER_START_TIME,
);
if (!latest || anchorIndex < 0) {
  throw new Error("Could not locate the paper account anchor candle");
}

const synced = syncAccount(createAccount(candles[anchorIndex]), candles);
const payload = {
  account: synced.account,
  runtime: {
    status: "healthy",
    mode: "cloud",
    lastRunAt: Date.now(),
    lastRunDurationMs: Date.now() - started,
    nextRunAt: nextRunTime(),
    latestPrice: latest.close,
    latestCandleTime: latest.time,
    processedEvents: synced.newEvents.length,
    source: "GitHub Actions · Binance BTCUSDT",
    error: null,
  },
  weekly: buildWeeklyReport(synced.account, latest.close),
  strategyVersion: "trend-breakout-v0.3",
  strategy: SETTINGS,
  source: "GitHub Actions · Binance BTCUSDT",
};

await mkdir(new URL("../state/", import.meta.url), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify({
    status: payload.runtime.status,
    latestCandleTime: payload.runtime.latestCandleTime,
    cash: payload.account.cash,
    quantity: payload.account.quantity,
    trades: payload.account.trades.length,
    latestTrade: payload.account.trades[0] ?? null,
  }),
);
