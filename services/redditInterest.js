const REDDIT_BASE = 'https://www.reddit.com';

function buildTickerMatchers(tickers) {
  const matchers = new Map();

  for (const ticker of tickers) {
    if (!ticker) {
      continue;
    }

    const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex =
      ticker.length <= 3
        ? new RegExp(`\\$${escaped}\\b`, 'i')
        : new RegExp(`(?:\\$${escaped}\\b|\\b${escaped}\\b)`, 'i');

    matchers.set(ticker, regex);
  }

  return matchers;
}

async function fetchSubredditPosts(subreddit, { sort = 'new', limit = 100 } = {}) {
  const url = `${REDDIT_BASE}/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(sort)}.json?limit=${limit}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'TickerMonitor/1.0',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Reddit request failed for r/${subreddit}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return payload?.data?.children?.map((item) => item?.data).filter(Boolean) || [];
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

    for (const [ticker, regex] of matchers.entries()) {
      if (!regex.test(text)) {
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
