# Biotech Premarket Screener

A serverless Cloudflare Worker that monitors 20 small-cap biotech stocks during
premarket hours (4:00–9:30 AM ET, Mon–Fri) and flags volume spikes paired with
price momentum. Runs entirely on Cloudflare's **free plan** — no Durable Objects,
no Node.js server, no machine you have to keep awake.

## How it works

| Piece | Role |
|-------|------|
| **Cron Trigger** (`* * * * *`) | Fires the Worker every minute to poll Finnhub |
| **Workers KV** (`STATE`) | Stores rolling volume/price state + recent alerts between runs |
| **Static Assets** (`public/`) | Serves the dashboard `index.html` |
| **`fetch` handler** | `GET /api/stocks`, `GET /api/alerts`, and the dashboard |
| **`scheduled` handler** | The polling + alert logic, gated to premarket hours |

### Alert criteria
- Current-minute volume **> 5×** the rolling 30-minute average, **AND**
- Price up **> 5%** over the last 15 minutes, **AND**
- Price up **> 5%** vs. 10 minutes before the spike
- Needs 20 minutes of warmup data before alerts fire

> Note: Cloudflare cron's minimum interval is 1 minute (vs. the old 30-second
> Node poll). Finnhub's free tier is already ~15–30s delayed, so this is fine.

## One-time setup

No local dev machine required after this — Cloudflare can build straight from Git.

```bash
npm install

# 1. Create the KV namespace, then paste the printed id into wrangler.toml
npm run kv:create

# 2. Store your Finnhub API key as a secret (never committed)
npm run secret

# 3. Deploy
npm run deploy
```

### Or deploy from the dashboard (zero local tooling)
1. Cloudflare → **Workers & Pages** → **Create** → **Connect to Git**
2. Select this repo + branch
3. Add the `FINNHUB_API_KEY` secret and the `STATE` KV binding in the project settings
4. Every push auto-deploys

Your dashboard is then live at `https://biotech-screener.<your-subdomain>.workers.dev`.
