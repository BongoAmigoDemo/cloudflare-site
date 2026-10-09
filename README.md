# AI News Studio

Two pixel-art anchors read out the latest AI news to each other, one story at a
time, in a browser-sized TV studio.

**Live:** https://cloudflare-site.paul-thomas-graham.workers.dev/

## How it works

An hourly cron pulls five RSS feeds, summarizes each new article into one
sentence with Workers AI, and caches it in D1. The frontend reads the ten newest
articles from `/api/news` and cycles through them: the anchors take turns
speaking, the speech-bubble tail slides toward whoever is talking, and the text
types out character by character.

| File | Role |
|---|---|
| `index.html` | The whole frontend — CSS and JS are inlined, no build step |
| `worker.js` | API routes, hourly RSS ingest, AI summarization, retention |
| `wrangler.toml` | Worker entrypoint, D1 + AI bindings, cron trigger |
| `assets/` | Anchor sprites and studio background |

There is no framework, no bundler, and no dependencies. Everything is plain
HTML, CSS, and JavaScript served as static assets by the Worker.

## Routes

| Route | Description |
|---|---|
| `GET /` | The studio page |
| `GET /api/news` | Ten newest articles as JSON, ordered by date descending |
| `GET /api/test-refresh` | Manual refresh — requires a token, see Secrets |

## Bindings

| Binding | Purpose |
|---|---|
| `ASSETS` | Serves the static files in this directory |
| `AI` | Workers AI, model `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `DB` | D1 database `news-cache`, table `articles` |

The cron trigger `0 * * * *` runs `refreshArticles` hourly. It keeps the 500
most recent articles and deletes the rest.

## Secrets

`/api/test-refresh` triggers up to 50 paid AI summaries, so it is never
callable anonymously. It requires a `REFRESH_TOKEN` secret and fails closed
(HTTP 503) when that secret is absent.

```bash
npx wrangler secret put REFRESH_TOKEN
```

Once set, call it with either form:

```bash
curl -H "X-Refresh-Token: $REFRESH_TOKEN" \
  https://cloudflare-site.paul-thomas-graham.workers.dev/api/test-refresh
```

Leaving the secret unset is safe — manual refresh stays disabled and the hourly
cron continues to run on its own.

## Local development

```bash
npx wrangler dev
```

## Deploy

This repository auto-deploys to Cloudflare on push to `main`.

To deploy manually instead:

```bash
npx wrangler deploy
```

## Note on `pub_date`

`pub_date` stores epoch milliseconds. Older rows written before this was
standardized hold RFC-822 strings (for example
`"Fri, 09 Oct 2026 05:06:17 +0000"`). SQLite's `strftime()` cannot parse that
day-name form and returns `NULL`, so `RFC822_SORTABLE` in `worker.js` rebuilds
it into a `YYYY-MM-DD HH:MM:SS` string that `strftime` accepts.

Both formats sort correctly during the transition. `refreshArticles` converts
up to 100 legacy rows per run, so the table converges to epoch millis on its
own. Rows whose dates cannot be parsed are left untouched rather than rewritten
to a bogus value.
