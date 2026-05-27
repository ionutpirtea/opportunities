require('dotenv').config();

const path = require('node:path');
const express = require('express');
const cron = require('node-cron');

const { loadTickersFromCsv, toYahooSymbol } = require('./services/tickerSource');
const { fetchBatchTickerPrices, fetchBatchReferencePrices, fetchBatchTickerDescriptions } = require('./services/priceService');
const { ensureCsv, appendCsvRows, readCsv } = require('./services/storage');
const { createWhatsAppSender } = require('./services/whatsappAlert');
const { fetchRedditTickerInterest } = require('./services/redditInterest');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const SCHEDULE_CRON = process.env.SCHEDULE_CRON || '*/15 * * * *';
const ALERT_BELOW_52WEEK_HIGH_PCT = Number(process.env.ALERT_BELOW_52WEEK_HIGH_PCT || 20);
const WHATSAPP_DIGEST_MODE = (process.env.WHATSAPP_DIGEST_MODE || 'single').toLowerCase();
const TZ = process.env.TZ;

const ROOT = __dirname;
const TICKERS_CSV = path.join(ROOT, 'tickers.csv');
const INDICES_CSV = path.join(ROOT, 'indices.csv');
const HISTORY_CSV = path.join(ROOT, 'data', 'price_history.csv');
const ALERTS_CSV = path.join(ROOT, 'data', 'alerts.csv');

const HISTORY_HEADERS = ['timestamp', 'ticker', 'yahoo_symbol', 'price', 'currency', 'market_time'];
const ALERT_HEADERS = ['timestamp', 'ticker', 'old_price', 'new_price', 'change_pct', 'threshold_pct', 'reason'];

const latestByTicker = new Map();
const referenceByTicker = new Map();
const redditInterestByTicker = new Map();
const descriptionByTicker = new Map();
const whatsapp = createWhatsAppSender();
const runtimeConfig = {
  alertBelow52WeekHighPct: Number.isFinite(ALERT_BELOW_52WEEK_HIGH_PCT) ? ALERT_BELOW_52WEEK_HIGH_PCT : 20,
};
let lastRun = {
  startedAt: null,
  finishedAt: null,
  total: 0,
  success: 0,
  failed: 0,
  alerts: 0,
  errors: [],
  whatsapp: { sent: 0, failed: 0, skipped: 0, reason: 'not-run' },
};
let redditFetchStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  postsScanned: null,
  tickersUpdated: 0,
};

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'templates'));
app.use('/public', express.static(path.join(ROOT, 'public')));
app.use(express.json());

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctChange(previous, current) {
  if (!previous || previous === 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}

function pctDiffFromReference(current, reference) {
  if (!Number.isFinite(current) || !Number.isFinite(reference) || reference === 0) {
    return null;
  }
  return ((current - reference) / reference) * 100;
}

function pctBelowReference(current, referenceHigh) {
  if (!Number.isFinite(current) || !Number.isFinite(referenceHigh) || referenceHigh <= 0) {
    return null;
  }
  return ((referenceHigh - current) / referenceHigh) * 100;
}

async function refreshReferenceCache(tickers, { force = false } = {}) {
  const successStaleMs = 6 * 60 * 60 * 1000;
  const missingStaleMs = 5 * 60 * 1000;
  const nowMs = Date.now();
  const missingSymbols = [];

  for (const ticker of tickers) {
    const cached = referenceByTicker.get(ticker);
    const ttl = cached?.refs ? successStaleMs : missingStaleMs;
    if (force || !cached || nowMs - cached.fetchedAtMs > ttl) {
      missingSymbols.push({ ticker, yahooSymbol: toYahooSymbol(ticker) });
    }
  }

  if (missingSymbols.length === 0) {
    return;
  }

  const symbolToTicker = new Map(missingSymbols.map((row) => [row.yahooSymbol, row.ticker]));
  const refMap = await fetchBatchReferencePrices(missingSymbols.map((row) => row.yahooSymbol));

  for (const row of missingSymbols) {
    referenceByTicker.set(row.ticker, {
      fetchedAtMs: nowMs,
      refs: null,
    });
  }

  for (const [symbol, refs] of refMap.entries()) {
    const ticker = symbolToTicker.get(symbol);
    if (!ticker) {
      continue;
    }
    referenceByTicker.set(ticker, {
      fetchedAtMs: nowMs,
      refs,
    });
  }
}

async function refreshRedditInterestCache(tickers, { force = false } = {}) {
  const staleMs = 15 * 60 * 1000;
  const nowMs = Date.now();
  const needsRefresh = force || tickers.some((ticker) => {
    const cached = redditInterestByTicker.get(ticker);
    return !cached || nowMs - cached.fetchedAtMs > staleMs;
  });

  if (!needsRefresh) {
    return;
  }

  const attemptAt = new Date().toISOString();
  redditFetchStatus.lastAttemptAt = attemptAt;

  try {
    const interestMap = await fetchRedditTickerInterest(tickers);

    let postsScanned = 0;
    for (const ticker of tickers) {
      const value = interestMap.get(ticker) || null;
      redditInterestByTicker.set(ticker, {
        fetchedAtMs: nowMs,
        value,
      });
      if (Number.isFinite(value?.postsScanned)) {
        postsScanned = Math.max(postsScanned, value.postsScanned);
      }
    }

    redditFetchStatus.lastSuccessAt = new Date().toISOString();
    redditFetchStatus.lastError = null;
    redditFetchStatus.postsScanned = postsScanned;
    redditFetchStatus.tickersUpdated = tickers.length;
  } catch (error) {
    redditFetchStatus.lastError = error?.message || 'Unknown Reddit fetch error';
  }
}

async function refreshDescriptionCache(tickers, { force = false } = {}) {
  const successStaleMs = 24 * 60 * 60 * 1000;
  const missingStaleMs = 60 * 60 * 1000;
  const nowMs = Date.now();
  const missingRows = [];

  for (const ticker of tickers) {
    const cached = descriptionByTicker.get(ticker);
    const ttl = cached?.value ? successStaleMs : missingStaleMs;
    if (force || !cached || nowMs - cached.fetchedAtMs > ttl) {
      missingRows.push({ ticker, yahooSymbol: toYahooSymbol(ticker) });
    }
  }

  if (missingRows.length === 0) {
    return;
  }

  const symbolToTicker = new Map(missingRows.map((row) => [row.yahooSymbol, row.ticker]));
  const descMap = await fetchBatchTickerDescriptions(missingRows.map((row) => row.yahooSymbol));

  for (const row of missingRows) {
    descriptionByTicker.set(row.ticker, {
      fetchedAtMs: nowMs,
      value: '',
    });
  }

  for (const [symbol, description] of descMap.entries()) {
    const ticker = symbolToTicker.get(symbol);
    if (!ticker) {
      continue;
    }

    descriptionByTicker.set(ticker, {
      fetchedAtMs: nowMs,
      value: description,
    });
  }
}

function parseTimestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parsePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) ? price : null;
}

function sortReportRows(rows, { sortBy = 'none', sortDir = 'desc' } = {}) {
  const fieldByKey = {
    pct1d: 'pctVsOneBusinessDayAgo',
    pct1m: 'pctVsOneMonthAgo',
    pct1y: 'pctVsOneYearAgo',
  };

  const field = fieldByKey[sortBy] || null;
  if (!field) {
    return rows;
  }

  const direction = sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = Number.isFinite(a[field]) ? a[field] : null;
    const bv = Number.isFinite(b[field]) ? b[field] : null;

    if (av == null && bv == null) {
      return a.ticker.localeCompare(b.ticker);
    }
    if (av == null) {
      return 1;
    }
    if (bv == null) {
      return -1;
    }

    if (av === bv) {
      return a.ticker.localeCompare(b.ticker);
    }

    return (av - bv) * direction;
  });
}

async function fetchLatestSnapshot(tickers) {
  const symbolRows = tickers.map((ticker) => ({
    ticker,
    yahooSymbol: toYahooSymbol(ticker),
  }));

  const quoteMap = await fetchBatchTickerPrices(symbolRows.map((row) => row.yahooSymbol));
  const latestMap = new Map();

  for (const row of symbolRows) {
    const result = quoteMap.get(row.yahooSymbol);
    if (!result) {
      continue;
    }

    latestMap.set(row.ticker, {
      price: result.price,
      currency: result.currency,
      timestamp: new Date().toISOString(),
    });
  }

  return latestMap;
}

function buildReportRows(tickers, latestMap) {
  return tickers.map((ticker) => {
    const latest = latestMap.get(ticker);
    const refs = referenceByTicker.get(ticker)?.refs;
    const reddit = redditInterestByTicker.get(ticker)?.value;
    const currentPrice = latest?.price;
    const oneDayPrice = Number.isFinite(refs?.oneBusinessDayAgo?.price) ? refs.oneBusinessDayAgo.price : null;
    const oneMonthPrice = Number.isFinite(refs?.oneMonthAgo?.price) ? refs.oneMonthAgo.price : null;
    const oneYearPrice = Number.isFinite(refs?.oneYearAgo?.price) ? refs.oneYearAgo.price : null;
    const high52Week = Number.isFinite(refs?.high52Week) ? refs.high52Week : null;

    return {
      ticker,
      description: descriptionByTicker.get(ticker)?.value || '',
      price: latest?.price ?? null,
      currency: latest?.currency ?? '',
      timestamp: latest?.timestamp ?? '',
      redditMentions: Number.isFinite(reddit?.mentions) ? reddit.mentions : null,
      redditPostsScanned: Number.isFinite(reddit?.postsScanned) ? reddit.postsScanned : null,
      oneBusinessDayAgoPrice: oneDayPrice,
      oneBusinessDayAgoDate: refs?.oneBusinessDayAgo?.date || '',
      oneMonthAgoPrice: oneMonthPrice,
      oneMonthAgoDate: refs?.oneMonthAgo?.date || '',
      oneYearAgoPrice: oneYearPrice,
      oneYearAgoDate: refs?.oneYearAgo?.date || '',
      high52Week,
      pctVsOneBusinessDayAgo: pctDiffFromReference(currentPrice, oneDayPrice),
      pctVsOneMonthAgo: pctDiffFromReference(currentPrice, oneMonthPrice),
      pctVsOneYearAgo: pctDiffFromReference(currentPrice, oneYearPrice),
      pctBelow52WeekHigh: pctBelowReference(currentPrice, high52Week),
    };
  });
}

function buildAlertCandidates(rows, { minPctBelow = 20 } = {}) {
  return rows
    .filter((row) => Number.isFinite(row?.pctBelow52WeekHigh) && row.pctBelow52WeekHigh >= minPctBelow)
    .sort((a, b) => b.pctBelow52WeekHigh - a.pctBelow52WeekHigh);
}

function computeMovers(historyRows, { sinceMs = null, limit = 20 } = {}) {
  const byTicker = new Map();

  for (const row of historyRows) {
    const ticker = row.ticker;
    const timestampMs = parseTimestamp(row.timestamp);
    const price = parsePrice(row.price);
    if (!ticker || timestampMs == null || price == null) {
      continue;
    }

    if (sinceMs != null && timestampMs < sinceMs) {
      continue;
    }

    const existing = byTicker.get(ticker);
    if (!existing) {
      byTicker.set(ticker, {
        ticker,
        startPrice: price,
        startTime: row.timestamp,
        endPrice: price,
        endTime: row.timestamp,
      });
      continue;
    }

    if (timestampMs < parseTimestamp(existing.startTime)) {
      existing.startPrice = price;
      existing.startTime = row.timestamp;
    }

    if (timestampMs > parseTimestamp(existing.endTime)) {
      existing.endPrice = price;
      existing.endTime = row.timestamp;
    }
  }

  return [...byTicker.values()]
    .filter((entry) => entry.startPrice > 0 && entry.endPrice != null && entry.startPrice !== entry.endPrice)
    .map((entry) => {
      const changePct = ((entry.endPrice - entry.startPrice) / entry.startPrice) * 100;
      return {
        ...entry,
        changePct,
        absChangePct: Math.abs(changePct),
      };
    })
    .sort((a, b) => b.absChangePct - a.absChangePct)
    .slice(0, limit);
}

async function bootstrapStateFromHistory() {
  const rows = await readCsv(HISTORY_CSV);
  for (const row of rows) {
    latestByTicker.set(row.ticker, {
      price: asNumber(row.price),
      currency: row.currency,
      timestamp: row.timestamp,
      marketTime: row.market_time || null,
    });
  }
}

async function runPriceCheck({ reason = 'scheduled' } = {}) {
  const startedAt = new Date();
  const tickers = await loadTickersFromCsv(TICKERS_CSV);
  await refreshReferenceCache(tickers, { force: false });

  const historyRows = [];
  const alertRows = [];
  const errors = [];

  const symbolRows = tickers.map((ticker) => ({
    ticker,
    yahooSymbol: toYahooSymbol(ticker),
  }));

  const chunkSize = 50;
  for (let index = 0; index < symbolRows.length; index += chunkSize) {
    const chunk = symbolRows.slice(index, index + chunkSize);
    const symbols = chunk.map((row) => row.yahooSymbol);

    let quoteMap;
    try {
      quoteMap = await fetchBatchTickerPrices(symbols);
    } catch (error) {
      for (const row of chunk) {
        errors.push({ ticker: row.ticker, message: error.message });
      }
      continue;
    }

    for (const row of chunk) {
      const result = quoteMap.get(row.yahooSymbol);
      if (!result) {
        errors.push({ ticker: row.ticker, message: `No quote found for ${row.yahooSymbol}` });
        continue;
      }

      const timestamp = new Date().toISOString();
      const previous = latestByTicker.get(row.ticker);

      historyRows.push({
        timestamp,
        ticker: row.ticker,
        yahoo_symbol: row.yahooSymbol,
        price: result.price,
        currency: result.currency,
        market_time: result.marketTime || '',
      });

      const refs = referenceByTicker.get(row.ticker)?.refs;
      const high52Week = Number.isFinite(refs?.high52Week) ? refs.high52Week : null;
      const pctBelow52WeekHigh = pctBelowReference(result.price, high52Week);

      if (pctBelow52WeekHigh != null && pctBelow52WeekHigh >= runtimeConfig.alertBelow52WeekHighPct) {
        const drawdownPct = Number(pctBelow52WeekHigh.toFixed(3));

        alertRows.push({
          timestamp,
          ticker: row.ticker,
          old_price: high52Week,
          new_price: result.price,
          change_pct: (-drawdownPct).toFixed(3),
          threshold_pct: runtimeConfig.alertBelow52WeekHighPct,
          reason: `${drawdownPct.toFixed(2)}% below 52-week high`,
        });
      }

      latestByTicker.set(row.ticker, {
        price: result.price,
        currency: result.currency,
        timestamp,
        marketTime: result.marketTime,
      });
    }
  }

  await appendCsvRows(HISTORY_CSV, HISTORY_HEADERS, historyRows);
  await appendCsvRows(ALERTS_CSV, ALERT_HEADERS, alertRows);

  let whatsappResult = { sent: 0, failed: 0, skipped: 0, reason: 'no-alerts' };
  if (alertRows.length > 0) {
    whatsappResult = await whatsapp.sendAlerts(alertRows);
  }

  const finishedAt = new Date();
  lastRun = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    total: tickers.length,
    success: historyRows.length,
    failed: errors.length,
    alerts: alertRows.length,
    errors,
    reason,
    whatsapp: whatsappResult,
  };

  return lastRun;
}

app.get('/', (_req, res) => {
  res.redirect('/report');
});

app.get('/report', async (_req, res, next) => {
  try {
    const tickers = await loadTickersFromCsv(TICKERS_CSV);
    const alerts = await readCsv(ALERTS_CSV);
    const forceRefresh = String(_req.query.refreshRefs || '0') === '1';
    const forceRefreshReddit = String(_req.query.refreshReddit || '0') === '1';
    const forceRefreshDesc = String(_req.query.refreshDesc || '0') === '1';
    const sortBy = String(_req.query.sortBy || 'none').toLowerCase();
    const sortDir = String(_req.query.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    await refreshReferenceCache(tickers, { force: forceRefresh });
    await refreshRedditInterestCache(tickers, { force: forceRefreshReddit });
    await refreshDescriptionCache(tickers, { force: forceRefreshDesc });

    const latestRows = buildReportRows(tickers, latestByTicker);

    const sortedRows = sortReportRows(latestRows, { sortBy, sortDir });

    res.render('report', {
      latestRows: sortedRows,
      alerts: alerts.slice(-100).reverse(),
      run: lastRun,
      pageTitle: 'Stock Report',
      pageKey: 'stocks',
      showRunSection: true,
      showAlertsSection: true,
      config: {
        schedule: SCHEDULE_CRON,
        alertBelow52WeekHighPct: runtimeConfig.alertBelow52WeekHighPct,
        whatsappDigestMode: WHATSAPP_DIGEST_MODE,
        sortBy,
        sortDir,
        reportPath: '/report',
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/index-report', async (_req, res, next) => {
  try {
    const indices = await loadTickersFromCsv(INDICES_CSV);
    const forceRefresh = String(_req.query.refreshRefs || '0') === '1';
    const forceRefreshReddit = String(_req.query.refreshReddit || '0') === '1';
    const forceRefreshDesc = String(_req.query.refreshDesc || '0') === '1';
    const sortBy = String(_req.query.sortBy || 'none').toLowerCase();
    const sortDir = String(_req.query.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

    await refreshReferenceCache(indices, { force: forceRefresh });
    await refreshRedditInterestCache(indices, { force: forceRefreshReddit });
    await refreshDescriptionCache(indices, { force: forceRefreshDesc });

    const liveLatestMap = await fetchLatestSnapshot(indices);
    const latestRows = buildReportRows(indices, liveLatestMap);
    const sortedRows = sortReportRows(latestRows, { sortBy, sortDir });

    res.render('report', {
      latestRows: sortedRows,
      alerts: [],
      run: lastRun,
      pageTitle: 'Index Report',
      pageKey: 'indices',
      showRunSection: false,
      showAlertsSection: false,
      config: {
        schedule: SCHEDULE_CRON,
        alertBelow52WeekHighPct: runtimeConfig.alertBelow52WeekHighPct,
        whatsappDigestMode: WHATSAPP_DIGEST_MODE,
        sortBy,
        sortDir,
        reportPath: '/index-report',
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/alerts', async (_req, res) => {
  const alerts = await readCsv(ALERTS_CSV);
  res.json({
    count: alerts.length,
    alerts: alerts.slice(-200).reverse(),
  });
});

app.get('/alerts-page', async (_req, res, next) => {
  try {
    const tickers = await loadTickersFromCsv(TICKERS_CSV);
    const forceRefresh = String(_req.query.refreshRefs || '0') === '1';
    const forceRefreshReddit = String(_req.query.refreshReddit || '0') === '1';
    const forceRefreshDesc = String(_req.query.refreshDesc || '0') === '1';

    await refreshReferenceCache(tickers, { force: forceRefresh });
    await refreshRedditInterestCache(tickers, { force: forceRefreshReddit });
    await refreshDescriptionCache(tickers, { force: forceRefreshDesc });

    const latestRows = buildReportRows(tickers, latestByTicker);
    const candidates = buildAlertCandidates(latestRows, {
      minPctBelow: runtimeConfig.alertBelow52WeekHighPct,
    });
    const alerts = await readCsv(ALERTS_CSV);

    res.render('alerts', {
      pageTitle: 'Alerts',
      pageKey: 'alerts',
      thresholdPct: runtimeConfig.alertBelow52WeekHighPct,
      candidates,
      alerts: alerts.slice(-200).reverse(),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/movers', async (req, res, next) => {
  try {
    const hours = Math.max(1, Number(req.query.hours) || 24);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const sinceMs = Date.now() - hours * 60 * 60 * 1000;
    const historyRows = await readCsv(HISTORY_CSV);
    const movers = computeMovers(historyRows, { sinceMs, limit });

    res.render('movers', {
      movers,
      hours,
      limit,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    now: new Date().toISOString(),
    schedule: SCHEDULE_CRON,
    alertBelow52WeekHighPct: runtimeConfig.alertBelow52WeekHighPct,
    redditInterest: {
      ...redditFetchStatus,
      cacheSize: redditInterestByTicker.size,
    },
    lastRun,
  });
});

app.post('/config/thresholds', (req, res) => {
  const nextThreshold = Number(req.body?.thresholdPct ?? req.body?.alertBelow52WeekHighPct);

  if (!Number.isFinite(nextThreshold) || nextThreshold <= 0 || nextThreshold > 100) {
    return res.status(400).json({ error: 'thresholdPct must be a number between 0 and 100' });
  }

  runtimeConfig.alertBelow52WeekHighPct = Number(nextThreshold.toFixed(3));

  return res.json({
    ok: true,
    thresholdPct: runtimeConfig.alertBelow52WeekHighPct,
    alertBelow52WeekHighPct: runtimeConfig.alertBelow52WeekHighPct,
  });
});

app.post('/whatsapp/test', async (_req, res) => {
  const result = await whatsapp.sendTest({
    text: `[Ticker Monitor Test]\nTime: ${new Date().toISOString()}\nThis is a manual test from the report page.`,
  });

  if (result.reason !== 'ok') {
    return res.status(400).json(result);
  }

  return res.json(result);
});

app.post('/run-check', async (_req, res, next) => {
  try {
    const result = await runPriceCheck({ reason: 'manual' });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  res.status(500).json({
    error: error.message,
  });
});

async function start() {
  await ensureCsv(HISTORY_CSV, HISTORY_HEADERS);
  await ensureCsv(ALERTS_CSV, ALERT_HEADERS);
  await bootstrapStateFromHistory();

  app.listen(PORT, () => {
    console.log(`Ticker monitor listening on http://localhost:${PORT}`);
  });

  if (TZ) {
    cron.schedule(SCHEDULE_CRON, () => runPriceCheck({ reason: 'scheduled' }), { timezone: TZ });
  } else {
    cron.schedule(SCHEDULE_CRON, () => runPriceCheck({ reason: 'scheduled' }));
  }

  // First snapshot at startup, then periodic checks on cron schedule.
  runPriceCheck({ reason: 'startup' }).catch((error) => {
    console.error('Startup snapshot failed:', error.message);
  });
}

start().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});
