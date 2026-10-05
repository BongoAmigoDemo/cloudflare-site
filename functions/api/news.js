// functions/api/news.js
export async function onRequest(context) {
  // A list of your RSS feed URLs
  const FEEDS = [
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml',
    'https://venturebeat.com/ai/feed/',
  ];

  try {
    // Fetch all feeds in parallel for speed
    const responses = await Promise.all(
      FEEDS.map(url => fetch(url, { headers: { 'User-Agent': 'Your-AI-News-Site' } }))
    );
    
    const feedTexts = await Promise.all(responses.map(res => res.text()));
    
    // A simple regex-based parser (Works in Cloudflare's environment, no heavy dependencies)
    const allItems = feedTexts.flatMap(xml => {
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const itemXml = match[1];
        // Helper to extract content from a tag
        const getTag = (str, tag) => {
          const m = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
          return m ? m[1].replace(/<[^>]*>/g, '').trim() : '';
        };
        
        const title = getTag(itemXml, 'title');
        const link = getTag(itemXml, 'link');
        const pubDate = getTag(itemXml, 'pubDate');
        if (title && link) {
          items.push({ title, link, pubDate });
        }
      }
      return items;
    });

    // Sort by date (newest first) and return the top 20
    allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    
    return new Response(JSON.stringify(allItems.slice(0, 20)), {
      headers: { 
        'Content-Type': 'application/json',
        // Cache the response for 1 hour to save resources and speed up your site
        'Cache-Control': 'public, max-age=3600' 
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch news' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
