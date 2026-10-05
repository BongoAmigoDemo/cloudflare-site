export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // If the request is for /api/news, run your news logic
    if (url.pathname === '/api/news') {
      const FEEDS = [
        'https://techcrunch.com/category/artificial-intelligence/feed/',
        'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml',
        'https://venturebeat.com/ai/feed/',
        'https://openai.com/blog/rss.xml',
      ];

      try {
        const responses = await Promise.all(
          FEEDS.map(feedUrl =>
            fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0 AI-News-Aggregator' } })
          )
        );

        const feedTexts = await Promise.all(responses.map(res => res.text()));
        const allItems = [];

        for (const xml of feedTexts) {
          const itemRegex = /<item>([\s\S]*?)<\/item>/g;
          let match;

          while ((match = itemRegex.exec(xml)) !== null) {
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
              allItems.push({ title, link, pubDate });
            }
          }
        }

        allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        return new Response(JSON.stringify(allItems.slice(0, 20)), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=1800',
          },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: 'Failed to fetch news', detail: String(error) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // For any other request, serve the static asset (index.html, style.css, etc.)
    return env.ASSETS.fetch(request);
  },
};
