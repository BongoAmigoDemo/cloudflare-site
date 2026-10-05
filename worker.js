export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ... (Your existing /api/news handler)

    if (url.pathname === '/api/news') {
      // ... (Your existing FEEDS array and fetch loop)

      // After you have your `allItems` array:
      allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

      // Generate summaries for the first 5 articles
      const itemsWithSummaries = await Promise.all(
        allItems.slice(0, 5).map(async (item) => {
          const summary = await generateSummary(item.title, env);
          return { ...item, summary };
        })
      );

      // Combine summarized and non-summarized items
      const remainingItems = allItems.slice(5, 30);
      const finalItems = [...itemsWithSummaries, ...remainingItems];

      return new Response(JSON.stringify({
        count: allItems.length,
        errors: errors,
        items: finalItems,
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

// New helper function to generate a summary
async function generateSummary(title, env) {
  if (!env.AI) {
    return null; // AI binding not configured
  }

  try {
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that summarizes news articles in one concise sentence.'
        },
        {
          role: 'user',
          content: `Summarize this news headline in one sentence: "${title}"`
        }
      ],
      max_tokens: 100,
    });

    return response.response || null;
  } catch (err) {
    console.error('AI summary failed:', err);
    return null; // Fail gracefully
  }
}
