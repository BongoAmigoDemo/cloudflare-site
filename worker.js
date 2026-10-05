export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/news') {
      try {
const FEEDS = [
  'https://techcrunch.com/category/artificial-intelligence/feed/',
  'https://openai.com/blog/rss.xml',
  'https://www.artificialintelligence-news.com/feed/',
  'https://syncedreview.com/feed/',
  'https://www.marktechpost.com/feed/',
];

        const feedResults = [];

        for (const feedUrl of FEEDS) {
          try {
            const res = await fetch(feedUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; AI-News-Aggregator/1.0)',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
              },
            });

            if (!res.ok) {
              feedResults.push({ url: feedUrl, error: `HTTP ${res.status}` });
              continue;
            }

            const text = await res.text();
            if (!text.includes('<item>')) {
              feedResults.push({ url: feedUrl, error: 'No <item> tags found' });
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
                  .trim();
              };

              const title = getTag(itemXml, 'title');
              const link = getTag(itemXml, 'link');
              const pubDate = getTag(itemXml, 'pubDate');

              if (title && link) {
                feedResults.push({ title, link, pubDate, source: feedUrl });
              }
            }
          } catch (err) {
            feedResults.push({ url: feedUrl, error: String(err) });
          }
        }

        const items = feedResults.filter(r => r.title && r.link);
        const errors = feedResults.filter(r => r.error);

        items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        return new Response(JSON.stringify({
          count: items.length,
          errors: errors,
          items: items.slice(0, 30),
        }, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=1800',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({
          fatal: true,
          message: String(err),
          stack: err.stack,
        }, null, 2), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
