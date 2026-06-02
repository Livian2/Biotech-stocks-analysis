/**
 * Biotech Premarket Screener
 * Monitors 20 small-cap biotech stocks during premarket hours (4:00–9:30 AM ET, Mon–Fri).
 * Alerts on volume spike (>5x 30-min rolling avg) combined with price increase (>5% over 15 min).
 *
 * Requirements: Node.js v18+ — no npm packages, uses only built-ins (https, fs, path).
 * Run: node biotech_screener.js
 * Log: biotech_screener.log (same directory as the script)
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FINNHUB_API_KEY = 'd8f9h11r01qub7kgjf30d8f9h11r01qub7kgjf3g'; // replace with key from finnhub.io/dashboard

// Ticker list with metadata used by the UI
const TICKER_META = {
  VNDA: { name: 'Vanda Pharmaceuticals',    catalyst: 'PDUFA Jun 20 (tradipitant)',              type: 'PDUFA'    },
  SRRK: { name: 'Scholar Rock',             catalyst: 'PDUFA Jun 20 (apitegromab, SMA)',          type: 'PDUFA'    },
  TNXP: { name: 'Tonix Pharmaceuticals',    catalyst: 'PDUFA Jun 26 (TNX-102 SL)',               type: 'PDUFA'    },
  LQDA: { name: 'Liquidia Corp',            catalyst: 'PDUFA Jun 27 (LIQ861)',                   type: 'PDUFA'    },
  CSTL: { name: 'Castle Biosciences',       catalyst: 'Post-ASCO momentum (oncology dx)',         type: 'ASCO'     },
  FATE: { name: 'Fate Therapeutics',        catalyst: 'Post-ASCO momentum (cell therapy)',        type: 'ASCO'     },
  CELZ: { name: 'Celldex Therapeutics',     catalyst: 'Post-ASCO momentum (immunotherapy)',       type: 'ASCO'     },
  SLAS: { name: 'Sellas Life Sciences',     catalyst: 'Post-ASCO momentum (cancer vaccines)',     type: 'ASCO'     },
  RCUS: { name: 'Arcus Biosciences',        catalyst: 'Post-ASCO momentum (immunotherapy)',       type: 'ASCO'     },
  CBRL: { name: 'Caribou Biosciences',      catalyst: 'Post-ASCO momentum (CRISPR cell therapy)', type: 'ASCO'    },
  BCRX: { name: 'BioCryst Pharmaceuticals', catalyst: 'Phase 3 ALPHA-ORBIT enrollment (Jun)',    type: 'Trial'    },
  ADMA: { name: 'ADMA Biologics',           catalyst: 'Pre-IND FDA submission 2026 (SG-001)',     type: 'Pipeline' },
  AKBA: { name: 'Akebia Therapeutics',      catalyst: 'Renal disease, oversold setup',            type: 'Pipeline' },
  CRSP: { name: 'CRISPR Therapeutics',      catalyst: 'Active pipeline readouts',                 type: 'Pipeline' },
  BNGO: { name: 'Bionano Genomics',         catalyst: 'Genomics data updates',                    type: 'Pipeline' },
  SAVA: { name: 'Cassava Sciences',         catalyst: "Alzheimer's trial, high volatility",       type: 'Trial'    },
  MREO: { name: 'Mereo BioPharma',          catalyst: 'Rare disease pipeline update',             type: 'Pipeline' },
  KURA: { name: 'Kura Oncology',            catalyst: 'Pre-PDUFA buildup (Oct 22)',               type: 'PDUFA'    },
  CAPR: { name: 'Capricor Therapeutics',    catalyst: 'Pre-PDUFA buildup (Sep 8)',                type: 'PDUFA'    },
  PULM: { name: 'Pulmatrix',                catalyst: 'Respiratory pipeline',                     type: 'Pipeline' },
};

const BIOTECH_TICKERS = Object.keys(TICKER_META);

const POLL_INTERVAL_MS    = 30_000;  // poll every 30 seconds
const TICKER_STAGGER_MS   = 500;     // 500 ms between tickers to avoid burst rate-limit hits
const WARMUP_MINUTES      = 20;      // minutes of data needed before alerts fire
const ROLLING_WINDOW_MINS = 30;      // rolling baseline window (minutes)
const VOLUME_SPIKE_MULT   = 5;       // current minute volume must be > 5× rolling avg
const PRICE_CHANGE_PCT    = 5;       // price must be up > 5% vs. reference points
const PRICE_LOOKBACK_MINS = 15;      // lookback for price-increase check
const SPIKE_LOOKBACK_MINS = 10;      // price must also be up vs. 10 min before the spike

const LOG_FILE   = path.join(__dirname, 'biotech_screener.log');
const API_PORT   = process.env.PORT || 3000;
const UI_FILE    = path.join(__dirname, 'index.html');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(msg) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const line = `[${ts} ET] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Returns true when current ET time is a weekday between 4:00 and 9:30 AM. */
function isPremarketHours() {
  const now = new Date();
  // Convert to ET by formatting then reparsing
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hours = et.getHours();
  const mins  = et.getMinutes();
  const totalMins = hours * 60 + mins;
  return totalMins >= 4 * 60 && totalMins < 9 * 60 + 30;
}

/** Returns current "HH:MM" bucket string in ET timezone. */
function getMinuteBucket() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

/** Parse "HH:MM" → total minutes from midnight. */
function bucketToMins(bucket) {
  const [h, m] = bucket.split(':').map(Number);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// Per-ticker state
// ---------------------------------------------------------------------------

/**
 * stockData[ticker] = {
 *   prices:        Array<{ bucket: string, price: number }>,
 *   minuteVolumes: Map<bucket, number>,  // accumulated volume per minute bucket
 *   lastVolume:    number,               // cumulative volume seen in previous poll
 *   currentBucket: string,
 *   startTime:     Date | null,          // first poll timestamp (for warmup gate)
 * }
 */
const stockData = {};

for (const ticker of BIOTECH_TICKERS) {
  stockData[ticker] = {
    prices:        [],
    minuteVolumes: new Map(),
    lastVolume:    0,
    currentBucket: '',
    startTime:     null,
    // UI-facing fields (updated each poll)
    currentPrice:  null,
    prevClose:     null,   // Finnhub `pc` field
    dayChangePct:  null,
    volumeRatio:   null,
    warmupDone:    false,
    lastUpdated:   null,
    alertFired:    false,
  };
}

// Capped list of recent alerts shown in the UI
const recentAlerts = [];

// ---------------------------------------------------------------------------
// Rolling 30-minute average volume per minute
// ---------------------------------------------------------------------------

/**
 * Returns the average volume-per-minute across the last ROLLING_WINDOW_MINS
 * completed buckets (excludes the current in-progress bucket).
 */
function calculateRolling30MinAvg(ticker) {
  const state = stockData[ticker];
  const currentBucket = getMinuteBucket();
  const entries = [];

  for (const [bucket, vol] of state.minuteVolumes.entries()) {
    if (bucket !== currentBucket) entries.push(vol);
  }

  if (entries.length === 0) return 0;

  // Keep only last ROLLING_WINDOW_MINS completed buckets
  const window = entries.slice(-ROLLING_WINDOW_MINS);
  const sum = window.reduce((a, b) => a + b, 0);
  return sum / window.length;
}

// ---------------------------------------------------------------------------
// Finnhub API
// ---------------------------------------------------------------------------

/**
 * Fetches the latest quote for `ticker`.
 * Resolves to { c: currentPrice, v: cumulativeVolume } or null on error.
 */
function getQuote(ticker) {
  return new Promise((resolve) => {
    const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`;
    https.get(url, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (typeof data.c === 'number' && typeof data.v === 'number') {
            resolve({ c: data.c, v: data.v, pc: data.pc || null });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// Core screening logic
// ---------------------------------------------------------------------------

async function checkStock(ticker) {
  const quote = await getQuote(ticker);
  if (!quote || quote.c <= 0) return;

  const state = stockData[ticker];
  const bucket = getMinuteBucket();

  // Update UI-facing fields
  state.currentPrice = quote.c;
  state.lastUpdated  = new Date().toISOString();
  if (quote.pc && quote.pc > 0) {
    state.prevClose   = quote.pc;
    state.dayChangePct = ((quote.c - quote.pc) / quote.pc) * 100;
  }

  // Record start time on first data point
  if (!state.startTime) {
    state.startTime = new Date();
    log(`${ticker}: first data point received — warmup started`);
  }

  // --- Update price history ---
  state.prices.push({ bucket, price: quote.c });
  // Trim prices older than max(PRICE_LOOKBACK_MINS, SPIKE_LOOKBACK_MINS) + 5 buffer
  const maxLookback = Math.max(PRICE_LOOKBACK_MINS, SPIKE_LOOKBACK_MINS) + 5;
  const currentMins = bucketToMins(bucket);
  state.prices = state.prices.filter(
    (p) => currentMins - bucketToMins(p.bucket) <= maxLookback
  );

  // --- Accumulate volume for the current minute bucket ---
  if (state.lastVolume > 0 && quote.v > state.lastVolume) {
    const delta = quote.v - state.lastVolume;
    const prev = state.minuteVolumes.get(bucket) || 0;
    state.minuteVolumes.set(bucket, prev + delta);
  } else if (state.lastVolume === 0) {
    // First poll — set baseline without counting as volume delta
  }
  state.lastVolume = quote.v;

  // Prune buckets older than rolling window + buffer
  const trimThreshold = currentMins - (ROLLING_WINDOW_MINS + 5);
  for (const [b] of state.minuteVolumes.entries()) {
    if (bucketToMins(b) < trimThreshold) state.minuteVolumes.delete(b);
  }

  // --- Warmup gate ---
  if (!state.startTime) return;
  const elapsedMs = Date.now() - state.startTime.getTime();
  if (elapsedMs < WARMUP_MINUTES * 60 * 1000) return;
  state.warmupDone = true;

  // --- Volume spike check ---
  const currentBucketVol = state.minuteVolumes.get(bucket) || 0;
  const rollingAvg = calculateRolling30MinAvg(ticker);
  if (rollingAvg === 0) return;

  const volumeRatio = currentBucketVol / rollingAvg;
  state.volumeRatio = volumeRatio;
  if (volumeRatio < VOLUME_SPIKE_MULT) return;

  // --- Price increase checks ---
  const currentPrice = quote.c;

  // Check 1: price up > PRICE_CHANGE_PCT% over last PRICE_LOOKBACK_MINS minutes
  const lookback15 = state.prices.find(
    (p) => currentMins - bucketToMins(p.bucket) >= PRICE_LOOKBACK_MINS
  );
  if (!lookback15) return;
  const pctChange15 = ((currentPrice - lookback15.price) / lookback15.price) * 100;
  if (pctChange15 <= PRICE_CHANGE_PCT) return;

  // Check 2: price up > PRICE_CHANGE_PCT% vs. SPIKE_LOOKBACK_MINS ago
  const lookback10 = state.prices.find(
    (p) => currentMins - bucketToMins(p.bucket) >= SPIKE_LOOKBACK_MINS
  );
  if (!lookback10) return;
  const pctChange10 = ((currentPrice - lookback10.price) / lookback10.price) * 100;
  if (pctChange10 <= PRICE_CHANGE_PCT) return;

  // --- ALERT ---
  state.alertFired = true;
  const alertMsg =
    `*** ALERT *** ${ticker} | Price: $${currentPrice.toFixed(2)} | ` +
    `+${pctChange15.toFixed(1)}% (15 min) | +${pctChange10.toFixed(1)}% (10 min before spike) | ` +
    `Vol spike: ${volumeRatio.toFixed(1)}x avg (${currentBucketVol.toLocaleString()} vs avg ${Math.round(rollingAvg).toLocaleString()})`;
  log(alertMsg);
  recentAlerts.unshift({
    ticker,
    price:       currentPrice,
    pctChange15: pctChange15,
    pctChange10: pctChange10,
    volumeRatio: volumeRatio,
    timestamp:   new Date().toISOString(),
  });
  if (recentAlerts.length > 50) recentAlerts.pop();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runScreener() {
  if (!isPremarketHours()) {
    log('Outside premarket hours (4:00–9:30 AM ET, Mon–Fri). Waiting...');
    return;
  }

  for (let i = 0; i < BIOTECH_TICKERS.length; i++) {
    const ticker = BIOTECH_TICKERS[i];
    // Stagger requests to stay well within the 60 req/min rate limit
    await new Promise((res) => setTimeout(res, i === 0 ? 0 : TICKER_STAGGER_MS));
    checkStock(ticker).catch((err) => log(`${ticker}: unexpected error — ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// HTTP API server  (GET /api/stocks  |  GET /api/alerts  |  GET /)
// ---------------------------------------------------------------------------

function serveApi() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/api/stocks') {
      const payload = BIOTECH_TICKERS.map((ticker) => {
        const s = stockData[ticker];
        const meta = TICKER_META[ticker];
        return {
          ticker,
          name:          meta.name,
          catalyst:      meta.catalyst,
          catalystType:  meta.type,
          currentPrice:  s.currentPrice,
          prevClose:     s.prevClose,
          dayChangePct:  s.dayChangePct !== null ? +s.dayChangePct.toFixed(2) : null,
          volumeRatio:   s.volumeRatio  !== null ? +s.volumeRatio.toFixed(2)  : null,
          warmupDone:    s.warmupDone,
          alertFired:    s.alertFired,
          lastUpdated:   s.lastUpdated,
        };
      });
      const body = JSON.stringify({ stocks: payload, premarket: isPremarketHours(), serverTime: new Date().toISOString() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }

    if (url === '/api/alerts') {
      const body = JSON.stringify({ alerts: recentAlerts });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }

    // Serve the dashboard for any other GET
    if (req.method === 'GET') {
      try {
        const html = fs.readFileSync(UI_FILE);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end('index.html not found');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(API_PORT, () => {
    log(`Dashboard available at http://localhost:${API_PORT}`);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

log('Biotech Premarket Screener starting...');
log(`Monitoring ${BIOTECH_TICKERS.length} tickers: ${BIOTECH_TICKERS.join(', ')}`);
log(`Alert criteria: volume >${VOLUME_SPIKE_MULT}x rolling 30-min avg AND price >+${PRICE_CHANGE_PCT}% (15 min & 10 min)`);
log(`Warmup: ${WARMUP_MINUTES} minutes before alerts fire`);
log(`Log file: ${LOG_FILE}`);

serveApi();

// Run immediately, then on interval
runScreener();
setInterval(runScreener, POLL_INTERVAL_MS);
