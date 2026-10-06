const FEEDS = [
  'https://techcrunch.com/category/artificial-intelligence/feed/',
  'https://openai.com/blog/rss.xml',
  'https://www.artificialintelligence-news.com/feed/',
  'https://syncedreview.com/feed/',
  'https://www.marktechpost.com/feed/',
];

export default {
  // --- Fast read from D1 for the frontend ---
  async fetch(request, env) {
    const url = new URL(request.url);

if (url.pathname === '/api/news') {
  try {
    const { results } = await env.DB.prepare(
      `SELECT title, link, pub_date AS pubDate, description, source, summary
       FROM articles
       LIMIT 200`
    ).all();

    // Sort by date in JavaScript (handles RSS date strings correctly)
    results.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    return new Response(JSON.stringify({
      count: results.length,
      items: results.slice(0, 10),
    }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

    if (url.pathname === '/api/test-refresh') {
  await refreshArticles(env);
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM articles"
  ).all();
  return new Response(`Refresh complete. ${results[0].total} articles in DB.`, {
    status: 200,
  });
}

    return env.ASSETS.fetch(request);
  },

  // --- Hourly job: fetch feeds, summarize new articles, save to D1 ---
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshArticles(env));
  },
};

// --- The main refresh logic ---
async function refreshArticles(env) {
  const allItems = [];

  for (const feedUrl of FEEDS) {
    try {
      const res = await fetch(feedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AI-News-Aggregator/1.0)',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
      });
      if (!res.ok) continue;

      const text = await res.text();
      if (!text.includes('<item>')) continue;

      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;

      while ((match = itemRegex.exec(text)) !== null) {
        const itemXml = match[1];
        const getTag = (str, tag) => {
          const m = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
          if (!m) return '';
          return m[1]
            .replace(/<!\[CDATA\[|\]\]>/g, '')
            .replace(/<[^>]*>/g, '')
            .replace(/&#8216;/g, "'")
            .replace(/&#8217;/g, "'")
            .replace(/&#8220;/g, '"')
            .replace(/&#8221;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ')
            .replace(/&#\d+;/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        };

        const title = getTag(itemXml, 'title');
        const link = getTag(itemXml, 'link');
        const pubDate = getTag(itemXml, 'pubDate');

        let description = getTag(itemXml, 'content:encoded');
        if (!description) description = getTag(itemXml, 'description');
        if (!description) description = getTag(itemXml, 'summary');
        if (description.length > 600) description = description.slice(0, 600) + '...';

        if (title && link) {
          allItems.push({ title, link, pubDate, description, source: feedUrl });
        }
      }
    } catch (err) {
      console.error(`Feed failed: ${feedUrl}`, err);
    }
  }

  // Sort and take the top 50 (so we don't summarize old news)
  allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const top = allItems.slice(0, 50);

  // Find which ones we've already summarized
  const urls = top.map(i => i.link);
  const placeholders = urls.map(() => '?').join(',');
  const existing = await env.DB.prepare(
    `SELECT url FROM articles WHERE url IN (${placeholders})`
  ).bind(...urls).all();

  const knownUrls = new Set((existing.results || []).map(r => r.url));
  const newItems = top.filter(i => !knownUrls.has(i.link));

  console.log(`Refresh: ${top.length} articles, ${newItems.length} new`);

  // Summarize new items (in batches of 5, in parallel)
  for (let i = 0; i < newItems.length; i += 5) {
    const batch = newItems.slice(i, i + 5);
    await Promise.all(batch.map(async (item) => {
      const summary = await generateSummary(item.title, item.description, env);
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO articles (url, title, link, pub_date, description, source, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          item.link, item.title, item.link, item.pubDate,
          item.description, item.source, summary
        ).run();
      } catch (err) {
        console.error('DB insert failed:', err);
      }
    }));
  }

  // Cleanup: keep only the most recent 500 articles
  await env.DB.prepare(
    `DELETE FROM articles WHERE url NOT IN (
      SELECT url FROM articles ORDER BY pub_date DESC LIMIT 500
    )`
  ).run();
}

async function generateSummary(title, description, env) {
  if (!env.AI) return null;

  const userContent = description
    ? `Summarize this article in one clear, concise sentence.\n\nTitle: ${title}\n\nDescription: ${description}`
    : `Summarize this headline in one clear, concise sentence: "${title}"`;

  try {
    const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'You are a news summarizer. Write one factual, concise sentence that captures the key point.' },
        { role: 'user', content: userContent },
      ],
      max_tokens: 100,
    });
    return response.response || null;
  } catch (err) {
    console.error('AI error:', err);
    return null;
  }
}
