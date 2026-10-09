const FEEDS = [
  'https://techcrunch.com/category/artificial-intelligence/feed/',
  'https://openai.com/blog/rss.xml',
  'https://www.artificialintelligence-news.com/feed/',
  'https://syncedreview.com/feed/',
  'https://www.marktechpost.com/feed/',
];

// SQL expression that reformats an RFC-822 RSS date ("Fri, 09 Oct 2026 05:06:17 +0000")
// into "YYYY-MM-DD HH:MM:SS". SQLite's strftime() cannot parse the RFC-822 day
// name form and returns NULL, so we rebuild the string into a format it accepts.
// Returns NULL for anything that isn't RFC-822-shaped.
const RFC822_SORTABLE = `(
  substr(pub_date,13,4) || '-' ||
  CASE substr(pub_date,9,3)
    WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03'
    WHEN 'Apr' THEN '04' WHEN 'May' THEN '05' WHEN 'Jun' THEN '06'
    WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08' WHEN 'Sep' THEN '09'
    WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12'
  END || '-' || substr(pub_date,6,2) || ' ' || substr(pub_date,18,8)
)`;

// Sortable numeric recency for a row, tolerating both storage forms:
// Sortable numeric recency for a row, in epoch millis. Three storage shapes
// occur in practice:
//   - a real INTEGER
//   - numeric millis held as TEXT, because the column is declared TEXT and
//     binding a JS number stores it as a string ("1791530616000" or ".0")
//   - a legacy RFC-822 date string
// The middle case is the important one: it reports typeof 'text', so an
// integer-only check falls through to the RFC-822 parser, fails, and returns 0
// for EVERY row. Sorting then becomes arbitrary and the API serves stale
// stories. GLOB distinguishes the numeric form before the date parser sees it.
// Unparseable -> 0, which also makes retention evict those rows first.
const RECENCY_EXPR = `(
  CASE WHEN typeof(pub_date) = 'integer' THEN pub_date
       WHEN substr(pub_date, 1, 18) GLOB '[0-9]*' THEN CAST(pub_date AS REAL)
       ELSE COALESCE(CAST(strftime('%s', ${RFC822_SORTABLE}) AS INTEGER) * 1000, 0)
  END
)`;

// Rows that still hold a legacy RFC-822 string we can convert.
const NEEDS_MIGRATION = `(
  typeof(pub_date) = 'text' AND strftime('%s', ${RFC822_SORTABLE}) IS NOT NULL
)`;

export default {
  // --- Fast read from D1 for the frontend ---
  async fetch(request, env) {
    const url = new URL(request.url);

if (url.pathname === '/api/news') {
  try {
    // Order and limit in SQL so we always get the genuinely newest 10 rows.
    // Sorting in JS after a LIMIT 200 would sort an arbitrary subset.
    const { results } = await env.DB.prepare(
      `SELECT title, link, pub_date AS pubDate, description, source, summary
       FROM articles
       ORDER BY ${RECENCY_EXPR} DESC
       LIMIT 10`
    ).all();

    return new Response(JSON.stringify({
      count: results.length,
      items: results,
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
      // This endpoint triggers up to 50 paid AI summaries, so it must never be
      // callable anonymously. Fail closed if no secret is configured.
      if (!env.REFRESH_TOKEN) {
        return new Response('Refresh endpoint disabled: REFRESH_TOKEN is not set.', {
          status: 503,
        });
      }

      const provided = request.headers.get('X-Refresh-Token') || url.searchParams.get('token');
      if (provided !== env.REFRESH_TOKEN) {
        return new Response('Unauthorized.', { status: 401 });
      }

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
          allItems.push({ title, link, pubDate, pubMs: toMillis(pubDate), description, source: feedUrl });
        }
      }
    } catch (err) {
      console.error(`Feed failed: ${feedUrl}`, err);
    }
  }

  // Sort and take the top 50 (so we don't summarize old news)
  allItems.sort((a, b) => (b.pubMs || 0) - (a.pubMs || 0));
  const top = allItems.slice(0, 50);

  if (top.length === 0) {
    console.log('Refresh: no feed items parsed, skipping.');
    return;
  }

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
          item.link, item.title, item.link, item.pubMs ?? item.pubDate,
          item.description, item.source, summary
        ).run();
      } catch (err) {
        console.error('DB insert failed:', err);
      }
    }));
  }

  // One-time style migration: upgrade legacy RFC-822 pub_date strings to epoch
  // millis, bounded per run so the transition is gradual and cost-predictable.
  try {
    await env.DB.prepare(
      `UPDATE articles SET pub_date = CAST(strftime('%s', ${RFC822_SORTABLE}) AS INTEGER) * 1000
       WHERE url IN (
         SELECT url FROM articles
         WHERE ${NEEDS_MIGRATION}
         LIMIT 100
       )`
    ).run();
  } catch (err) {
    console.error('pub_date migration failed:', err);
  }

  // Cleanup: keep only the most recent 500 articles, newest first.
  await env.DB.prepare(
    `DELETE FROM articles WHERE url NOT IN (
       SELECT url FROM articles
       ORDER BY ${RECENCY_EXPR} DESC
       LIMIT 500
     )`
  ).run();
}

// Parse an RSS date string into epoch millis. Returns null if unparseable.
function toMillis(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  return Number.isNaN(t) ? null : t;
}

// Prompt for a spoken television news lede. The summary is not written prose:
// index.html types it out character by character at 18ms/char inside an 11s
// story cycle, so the word budget keeps each line readable in roughly 2s.
// It is captioned dialogue, so it should sound like something an anchor says.
const ANCHOR_SYSTEM_PROMPT = [
  'You are a warm, brisk television news anchor reading the AI desk live on air.',
  'Your lines are spoken aloud by a cartoon presenter, so they must sound like',
  'speech rather than like an article.',
  '',
  'Rules:',
  '- Very brief and easy to say out loud. Aim for 20-28 words, one or two sentences.',
  '- Open with a hook, then deliver the key fact. Never bury the lede.',
  '- Plain spoken English with contractions. Active voice, present tense.',
  '- Never invent names, numbers, quotes, or causes that are not in the source.',
  '- If the details are thin, stick to what the headline actually states.',
  '- Output only the spoken line. No preamble, no quotation marks, no markdown.',
].join('\n');

function buildAnchorPrompt(title, description) {
  if (description) {
    return `Headline: ${title}\nDetails: ${description}\n\nWrite the anchor's spoken introduction for this story.`;
  }
  return `Headline: ${title}\n\nThere are no further details, so write the anchor's spoken introduction using only what the headline states.`;
}

// Models sometimes wrap output in quotes, prefix it with a label, or trail an
// end-of-turn token. The line is displayed verbatim in the speech bubble and
// typed out at 18ms/char, so keep it clean and bounded to roughly two seconds.
function cleanAnchorLine(text) {
  if (!text) return null;
  let out = String(text)
    .replace(/<\/?s>/gi, '')
    .replace(/^\s*(?:anchor(?:\s*\d+)?|speaker|presenter|narrator)\s*[:\-\u2013]\s*/i, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();

  // Strip paired wrapping quotes, then any stray quote left between the text
  // and trailing punctuation (e.g. 'done."'), without eating possessive
  // apostrophes inside the words themselves.
  if (/^["\u201c\u2018]/.test(out) && /["\u201d\u2019]$/.test(out)) {
    out = out.slice(1, -1).trim();
  }
  out = out
    .replace(/[\s"'\u201c\u201d\u2018\u2019]*([.!?])?[\s"'\u201c\u201d\u2018\u2019]*$/, '$1')
    .trim();

  if (out.length > 220) {
    const cut = out.slice(0, 220);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    out = (stop > 80 ? cut.slice(0, stop + 1) : cut.trimEnd()).trim();
  }

  return out || null;
}

async function generateSummary(title, description, env) {
  if (!env.AI) return null;

  try {
    const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: ANCHOR_SYSTEM_PROMPT },
        { role: 'user', content: buildAnchorPrompt(title, description) },
      ],
      max_tokens: 80,
    });
    return cleanAnchorLine(response.response);
  } catch (err) {
    console.error('AI error:', err);
    return null;
  }
}
