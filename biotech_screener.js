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
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FINNHUB_API_KEY = 'YOUR_FINNHUB_API_KEY'; // replace with key from finnhub.io/dashboard

const BIOTECH_TICKERS = [
  'VNDA',  // Vanda Pharmaceuticals       — PDUFA Jun 20 (tradipitant)
  'SRRK',  // Scholar Rock                — PDUFA Jun 20 (apitegromab, SMA)
  'TNXP',  // Tonix Pharmaceuticals       — PDUFA Jun 26 (TNX-102 SL)
  'LQDA',  // Liquidia Corp               — PDUFA Jun 27 (LIQ861)
  'CSTL',  // Castle Biosciences          — Post-ASCO momentum (oncology dx)
  'FATE',  // Fate Therapeutics           — Post-ASCO momentum (cell therapy)
  'CELZ',  // Celldex Therapeutics        — Post-ASCO momentum (immunotherapy)
  'SLAS',  // Sellas Life Sciences        — Post-ASCO momentum (cancer vaccines)
  'RCUS',  // Arcus Biosciences           — Post-ASCO momentum (immunotherapy)
  'CBRL',  // Caribou Biosciences         — Post-ASCO momentum (CRISPR cell therapy)
  'BCRX',  // BioCryst Pharmaceuticals    — Phase 3 ALPHA-ORBIT enrollment end of June
  'ADMA',  // ADMA Biologics              — Pre-IND FDA submission 2026 (SG-001)
  'AKBA',  // Akebia Therapeutics         — Renal disease, oversold setup
  'CRSP',  // CRISPR Therapeutics         — Active pipeline readouts
  'BNGO',  // Bionano Genomics            — Genomics data updates
  'SAVA',  // Cassava Sciences            — Alzheimer's trial, high volatility
  'MREO',  // Mereo BioPharma             — Rare disease pipeline update
  'KURA',  // Kura Oncology               — Pre-PDUFA buildup (Oct 22)
  'CAPR',  // Capricor Therapeutics       — Pre-PDUFA buildup (Sep 8)
  'PULM',  // Pulmatrix                   — Respiratory pipeline
];

const POLL_INTERVAL_MS    = 30_000;  // poll every 30 seconds
const TICKER_STAGGER_MS   = 500;     // 500 ms between tickers to avoid burst rate-limit hits
const WARMUP_MINUTES      = 20;      // minutes of data needed before alerts fire
const ROLLING_WINDOW_MINS = 30;      // rolling baseline window (minutes)
const VOLUME_SPIKE_MULT   = 5;       // current minute volume must be > 5× rolling avg
const PRICE_CHANGE_PCT    = 5;       // price must be up > 5% vs. reference points
const PRICE_LOOKBACK_MINS = 15;      // lookback for price-increase check
const SPIKE_LOOKBACK_MINS = 10;      // price must also be up vs. 10 min before the spike

const LOG_FILE = path.join(__dirname, 'biotech_screener.log');

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
  };
}

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
            resolve({ c: data.c, v: data.v });
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

  // --- Volume spike check ---
  const currentBucketVol = state.minuteVolumes.get(bucket) || 0;
  const rollingAvg = calculateRolling30MinAvg(ticker);
  if (rollingAvg === 0) return;

  const volumeRatio = currentBucketVol / rollingAvg;
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
  log(
    `*** ALERT *** ${ticker} | Price: $${currentPrice.toFixed(2)} | ` +
    `+${pctChange15.toFixed(1)}% (15 min) | +${pctChange10.toFixed(1)}% (10 min before spike) | ` +
    `Vol spike: ${volumeRatio.toFixed(1)}x avg (${currentBucketVol.toLocaleString()} vs avg ${Math.round(rollingAvg).toLocaleString()})`
  );
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
// Entry point
// ---------------------------------------------------------------------------

log('Biotech Premarket Screener starting...');
log(`Monitoring ${BIOTECH_TICKERS.length} tickers: ${BIOTECH_TICKERS.join(', ')}`);
log(`Alert criteria: volume >${VOLUME_SPIKE_MULT}x rolling 30-min avg AND price >+${PRICE_CHANGE_PCT}% (15 min & 10 min)`);
log(`Warmup: ${WARMUP_MINUTES} minutes before alerts fire`);
log(`Log file: ${LOG_FILE}`);

// Run immediately, then on interval
runScreener();
setInterval(runScreener, POLL_INTERVAL_MS);
