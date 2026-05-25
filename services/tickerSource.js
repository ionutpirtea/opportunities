const fs = require('node:fs/promises');

async function loadTickersFromCsv(tickerFilePath) {
  const raw = await fs.readFile(tickerFilePath, 'utf8');

  const tickers = raw
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toUpperCase());

  return [...new Set(tickers)];
}

function toYahooSymbol(ticker) {
  return ticker.replace(/\./g, '-');
}

module.exports = {
  loadTickersFromCsv,
  toYahooSymbol,
};
