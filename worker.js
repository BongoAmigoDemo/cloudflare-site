export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/news') {
      const FEEDS = [
        'https://techcrunch.com/category/artificial-intelligence/feed/',
        'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml',
        'https://venturebeat.com/ai/feed/',
        'https://openai.com/blog/rss.xml',
      ];

      // Fetch each feed independently — one failure won't kill the whole request
      const results = await Promise.allSettled(
        FEEDS.map(feedUrl =>
          fetch(feedUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; AI-News-Aggregator/1.0)',
              'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            },
          }).then(res => {
            if (!res.ok) throw new Error(`Feed returned ${res.status}`);
            return res.text();
          })
        )
      );

      const allItems = [];

      for (const result of results) {
        if (result.status !== 'fulfilled') continue; // skip failed feeds

        const xml = result.value;
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
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Serve static assets for everything else
    return env.ASSETS.fetch(request);
  },
};
