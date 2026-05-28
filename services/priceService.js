const { default: YahooFinance } = require('yahoo-finance2');

const quietYahooLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  dir: () => {},
};

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: {
    logErrors: false,
  },
  logger: quietYahooLogger,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLastNumeric(values) {
  if (!Array.isArray(values)) {
    return null;
  }

  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

async function fetchTickerChartQuote(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol
  )}?range=1d&interval=1m`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const meta = result?.meta;

  const indicatorQuote = result?.indicators?.quote?.[0];
  const close = getLastNumeric(indicatorQuote?.close);
  const price = meta?.regularMarketPrice ?? close;

  if (price == null) {
    throw new Error('No market price in chart payload');
  }

  return {
    price: Number(price),
    currency: meta?.currency || 'N/A',
    marketTime: meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

function parseDailyPoints(payload) {
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const highs = result?.indicators?.quote?.[0]?.high || [];
  const rows = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = timestamps[i];
    const close = closes[i];
    const high = highs[i];
    if (typeof ts !== 'number') {
      continue;
    }

    const closeValue = typeof close === 'number' && Number.isFinite(close) ? close : null;
    const highValue = typeof high === 'number' && Number.isFinite(high) ? high : null;
    if (closeValue == null && highValue == null) {
      continue;
    }

    rows.push({
      timestampMs: ts * 1000,
      close: closeValue,
      high: highValue,
    });
  }

  return rows.sort((a, b) => a.timestampMs - b.timestampMs);
}

function shiftBusinessDays(date, businessDays) {
  const out = new Date(date);
  let remaining = Math.abs(businessDays);
  const direction = businessDays >= 0 ? 1 : -1;

  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + direction);
    const day = out.getUTCDay();
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }

  return out;
}

function pickCloseAtOrBefore(points, targetMs) {
  let best = null;
  for (const point of points) {
    if (!Number.isFinite(point.close)) {
      continue;
    }
    if (point.timestampMs <= targetMs) {
      best = point;
    } else {
      break;
    }
  }

  if (best) {
    return best;
  }

  for (const point of points) {
    if (Number.isFinite(point.close)) {
      return point;
    }
  }

  return null;
}

async function fetchTickerReferencePrices(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol
  )}?range=1y&interval=1d`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo reference request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const points = parseDailyPoints(payload);
  if (points.length === 0) {
    throw new Error('No daily closes found for reference prices');
  }

  const numericHighs = points
    .map((point) => {
      if (Number.isFinite(point.high)) {
        return point.high;
      }
      return Number.isFinite(point.close) ? point.close : null;
    })
    .filter((value) => Number.isFinite(value));

  const high52Week = numericHighs.length > 0 ? Math.max(...numericHighs) : null;

  const now = new Date();
  const oneBusinessDayAgo = shiftBusinessDays(now, -1);
  const twoBusinessDaysAgo = shiftBusinessDays(now, -2);
  const oneMonthAgo = new Date(now);
  oneMonthAgo.setUTCMonth(oneMonthAgo.getUTCMonth() - 1);
  const oneYearAgo = new Date(now);
  oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);

  const oneDayPoint = pickCloseAtOrBefore(points, oneBusinessDayAgo.getTime());
  const twoDayPoint = pickCloseAtOrBefore(points, twoBusinessDaysAgo.getTime());
  const oneMonthPoint = pickCloseAtOrBefore(points, oneMonthAgo.getTime());
  const oneYearPoint = pickCloseAtOrBefore(points, oneYearAgo.getTime());

  return {
    high52Week,
    oneBusinessDayAgo: oneDayPoint
      ? {
          price: oneDayPoint.close,
          date: new Date(oneDayPoint.timestampMs).toISOString(),
        }
      : null,
    twoBusinessDaysAgo: twoDayPoint
      ? {
          price: twoDayPoint.close,
          date: new Date(twoDayPoint.timestampMs).toISOString(),
        }
      : null,
    oneMonthAgo: oneMonthPoint
      ? {
          price: oneMonthPoint.close,
          date: new Date(oneMonthPoint.timestampMs).toISOString(),
        }
      : null,
    oneYearAgo: oneYearPoint
      ? {
          price: oneYearPoint.close,
          date: new Date(oneYearPoint.timestampMs).toISOString(),
        }
      : null,
  };
}

async function fetchBatchReferencePrices(yahooSymbols) {
  if (!Array.isArray(yahooSymbols) || yahooSymbols.length === 0) {
    return new Map();
  }

  const out = new Map();
  const queue = [...yahooSymbols];
  const workers = [];
  const concurrency = 3;

  for (let i = 0; i < concurrency; i += 1) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const symbol = queue.shift();
          if (!symbol) {
            continue;
          }

          try {
            const refs = await fetchTickerReferencePrices(symbol);
            out.set(symbol, refs);
          } catch {
            // Missing or incomplete history is tolerated for individual symbols.
          }

          await sleep(200);
        }
      })()
    );
  }

  await Promise.all(workers);
  return out;
}

async function fetchBatchTickerPrices(yahooSymbols) {
  if (!Array.isArray(yahooSymbols) || yahooSymbols.length === 0) {
    return new Map();
  }

  const out = new Map();
  const queue = [...yahooSymbols];
  const workers = [];
  const concurrency = 4;

  for (let i = 0; i < concurrency; i += 1) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const symbol = queue.shift();
          if (!symbol) {
            continue;
          }

          try {
            const quote = await fetchTickerChartQuote(symbol);
            out.set(symbol, quote);
          } catch {
            // Missing symbols or temporary failures are handled by caller.
          }

          await sleep(120);
        }
      })()
    );
  }

  await Promise.all(workers);
  return out;
}

async function fetchBatchTickerDescriptions(yahooSymbols) {
  if (!Array.isArray(yahooSymbols) || yahooSymbols.length === 0) {
    return new Map();
  }

  const out = new Map();
  const queue = [...yahooSymbols];
  const workers = [];
  const concurrency = 4;

  async function fetchSingle(symbol) {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=8&newsCount=0`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return '';
    }

    const payload = await response.json();
    const quotes = Array.isArray(payload?.quotes) ? payload.quotes : [];
    if (quotes.length === 0) {
      return '';
    }

    const target = quotes.find((q) => String(q?.symbol || '').toUpperCase() === symbol.toUpperCase()) || quotes[0];
    return target?.longname || target?.shortname || target?.name || '';
  }

  for (let i = 0; i < concurrency; i += 1) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const symbol = queue.shift();
          if (!symbol) {
            continue;
          }

          try {
            const description = await fetchSingle(symbol);
            if (description) {
              out.set(symbol, description);
            }
          } catch {
            // Best effort only.
          }

          await sleep(140);
        }
      })()
    );
  }

  await Promise.all(workers);

  return out;
}

async function fetchBatchTickerMarketCaps(yahooSymbols) {
  if (!Array.isArray(yahooSymbols) || yahooSymbols.length === 0) {
    return new Map();
  }

  const out = new Map();
  const queue = [...new Set(yahooSymbols.filter(Boolean))];
  const workers = [];
  const concurrency = 4;

  for (let i = 0; i < concurrency; i += 1) {
    workers.push(
      (async () => {
        try {
          while (queue.length > 0) {
            const symbol = queue.shift();
            if (!symbol) {
              continue;
            }

            try {
              const quote = await yahooFinance.quote(symbol);
              const marketCap = Number(quote?.marketCap);
              if (Number.isFinite(marketCap) && marketCap > 0) {
                out.set(String(symbol).toUpperCase(), marketCap);
              }
            } catch {
              // Best effort only.
            }

            await sleep(120);
          }
        } catch {
          // Guard against unexpected worker-level failures so startup never fails.
        }
      })()
    );
  }

  await Promise.allSettled(workers);

  return out;
}

module.exports = {
  fetchBatchTickerPrices,
  fetchBatchReferencePrices,
  fetchBatchTickerDescriptions,
  fetchBatchTickerMarketCaps,
};
