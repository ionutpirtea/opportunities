const REDDIT_BASES = ['https://www.reddit.com', 'https://old.reddit.com'];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function buildVariants(ticker) {
  const variants = new Set([ticker]);
  if (ticker.includes('.')) {
    variants.add(ticker.replace(/\./g, '-'));
  }
  if (ticker.includes('-')) {
    variants.add(ticker.replace(/-/g, '.'));
  }
  return [...variants].filter(Boolean);
}

function buildTokenRegex(variants, { caseInsensitive = true } = {}) {
  const escaped = variants.map((value) => escapeRegex(value));
  if (escaped.length === 0) {
    return null;
  }

  const flags = caseInsensitive ? 'i' : '';
  return new RegExp(`(?:^|[^A-Z0-9])(?:${escaped.join('|')})(?=$|[^A-Z0-9])`, flags);
}

function buildTickerMatchers(tickers) {
  const matchers = new Map();

  for (const ticker of tickers) {
    if (!ticker) {
      continue;
    }

    const variants = buildVariants(ticker);
    const cashtagRegex = new RegExp(`\\$(?:${variants.map((value) => escapeRegex(value)).join('|')})\\b`, 'i');

    // For very short symbols, avoid noisy matches in normal text.
    const wordRegex =
      ticker.length <= 2
        ? null
        : ticker.length === 3
          ? buildTokenRegex(variants, { caseInsensitive: false })
          : buildTokenRegex(variants, { caseInsensitive: true });

    matchers.set(ticker, { cashtagRegex, wordRegex });
  }

  return matchers;
}

async function fetchSubredditPosts(subreddit, { sort = 'new', limit = 100 } = {}) {
  const path = `/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(sort)}.json?limit=${limit}&raw_json=1`;
  let lastError = null;

  for (const base of REDDIT_BASES) {
    const url = `${base}${path}`;
    const timeout = withTimeout(12000);

    try {
      const response = await fetch(url, {
        signal: timeout.signal,
        headers: {
          'User-Agent': 'ticker-price-monitor/1.0 (+https://github.com/ionutpirtea/opportunities)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Reddit request failed for r/${subreddit} via ${base}: ${response.status} ${response.statusText}`);
      }

      const payload = await response.json();
      return payload?.data?.children?.map((item) => item?.data).filter(Boolean) || [];
    } catch (error) {
      lastError = error;
    } finally {
      timeout.clear();
    }
  }

  throw lastError || new Error(`Reddit request failed for r/${subreddit}`);
}

async function fetchRedditTickerInterest(tickers) {
  const out = new Map();
  for (const ticker of tickers) {
    out.set(ticker, { mentions: 0, postsScanned: 0, updatedAt: new Date().toISOString() });
  }

  const subreddits = ['stocks', 'investing', 'wallstreetbets', 'StockMarket'];
  const sortModes = ['new', 'hot'];
  const allPosts = [];

  for (const subreddit of subreddits) {
    for (const sort of sortModes) {
      try {
        const posts = await fetchSubredditPosts(subreddit, { sort, limit: 100 });
        allPosts.push(...posts);
      } catch {
        // Skip individual subreddit failures to keep report available.
      }
    }
  }

  const matchers = buildTickerMatchers(tickers);
  const uniquePosts = new Map();
  for (const post of allPosts) {
    const key = post.id || `${post.subreddit_name_prefixed || ''}:${post.created_utc || ''}:${post.title || ''}`;
    if (!uniquePosts.has(key)) {
      uniquePosts.set(key, post);
    }
  }

  const posts = [...uniquePosts.values()];

  for (const post of posts) {
    const text = `${post.title || ''}\n${post.selftext || ''}`;

    for (const [ticker, matcher] of matchers.entries()) {
      const matchesCashtag = matcher.cashtagRegex.test(text);
      const matchesWord = matcher.wordRegex ? matcher.wordRegex.test(text) : false;
      if (!matchesCashtag && !matchesWord) {
        continue;
      }

      const current = out.get(ticker);
      if (!current) {
        continue;
      }

      current.mentions += 1;
    }
  }

  const updatedAt = new Date().toISOString();
  for (const ticker of tickers) {
    const current = out.get(ticker);
    if (!current) {
      continue;
    }

    current.postsScanned = posts.length;
    current.updatedAt = updatedAt;
  }

  return out;
}

module.exports = {
  fetchRedditTickerInterest,
};
