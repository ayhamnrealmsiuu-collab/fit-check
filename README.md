# FIT-CHECK — deploy guide (no API key needed for visitors)

This version routes the AI calls through a small serverless function
(`api/generate.js`) that holds **your** Anthropic API key privately.
Visitors just use the site — they never see or need a key.

## Deploy on Vercel (free tier is enough for personal use)

1. Go to [vercel.com](https://vercel.com) and sign up / log in.
2. Click **Add New → Project**, then upload this folder
   (`index.html`, `api/generate.js`, `package.json`) — you can drag-and-drop
   it as a zip, or push it to a GitHub repo first and import that repo.
3. Before deploying, open **Project Settings → Environment Variables** and add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your real key from [console.anthropic.com](https://console.anthropic.com)
4. Deploy. Vercel automatically turns `api/generate.js` into a live endpoint
   at `https://your-site.vercel.app/api/generate` — the frontend already
   calls that exact path, so no extra config needed.
5. Visit your new URL. No API key field, no setup — it just works.

## Important: this makes YOUR key spend money on every visitor's usage

Since the key lives on your server, **every Style Me / color-combo click
from any visitor uses your API credits.** There's no login wall here, so:

- Set a spend limit / budget alert on your Anthropic account
  (console.anthropic.com → billing) so you can't get an unexpected bill.
- If this gets shared widely, consider adding real rate limiting
  (e.g. Vercel's built-in rate limiting, or a service like Upstash) —
  the proxy currently caps token usage per request but does not limit
  how often someone can call it.
- Anyone can technically call `/api/generate` directly (not just through
  your site's buttons) since it's a public endpoint — the cap on
  `max_tokens` limits damage per request, but not request volume.

## Local structure

```
fit-check-site/
├── index.html        ← the whole app (React, no build step)
├── api/
│   └── generate.js   ← serverless proxy holding your API key
├── package.json
└── README.md          ← this file
```

No `npm install` or build step required — Vercel just serves `index.html`
statically and runs `api/generate.js` as a function.
