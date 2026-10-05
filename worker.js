export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/news') {
      const FEEDS = [
        'https://techcrunch.com/category/artificial-intelligence/feed/',
        'https://openai.com/blog/rss.xml',
        'https://www.artificialintelligence-news.com/feed/',
        'https://syncedreview.com/feed/',
        'https://www.marktechpost.com/feed/',
      ];

      const allItems = [];
      const errors = [];

      for (const feedUrl of FEEDS) {
        try {
          const res = await fetch(feedUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; AI-News-Aggregator/1.0)',
              'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            },
          });

          if (!res.ok) {
            errors.push({ url: feedUrl, error: `HTTP ${res.status}` });
            continue;
          }

          const text = await res.text();
          if (!text.includes('<item>')) {
            errors.push({ url: feedUrl, error: 'No <item> tags found' });
            continue;
          }

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
                .trim();
            };

            const title = getTag(itemXml, 'title');
            const link = getTag(itemXml, 'link');
            const pubDate = getTag(itemXml, 'pubDate');

            if (title && link) {
              allItems.push({ title, link, pubDate, source: feedUrl });
            }
          }
        } catch (err) {
          errors.push({ url: feedUrl, error: String(err) });
        }
      }

      allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

// In your worker.js, replace the summary generation block with this:

async function getOrCreateSummary(title, link, env) {
  // 1. Check the D1 cache first
  const existing = await env.DB.prepare(
    "SELECT summary FROM summaries WHERE url = ?"
  ).bind(link).first();

  if (existing) {
    return existing.summary; // Cache hit! 0 AI cost.
  }

  // 2. Cache miss: Call AI
  if (!env.AI) return 'AI binding missing';

  try {
    const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'You summarize news headlines in one clear, concise sentence.' },
        { role: 'user', content: `Summarize this headline: "${title}"` },
      ],
      max_tokens: 100,
    });

    const summary = response.response || 'Summary unavailable';

    // 3. Save to D1 for next time
    await env.DB.prepare(
      "INSERT OR REPLACE INTO summaries (url, summary) VALUES (?, ?)"
    ).bind(link, summary).run();

    return summary;
  } catch (err) {
    return `AI error: ${String(err)}`;
  }
}

// Then, update your fetch handler to call this new function:
// const summary = await getOrCreateSummary(item.title, item.link, env);
