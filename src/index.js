'use strict';

// ---------------------------------------------------------------------------
// Ticker metadata
// ---------------------------------------------------------------------------

const TICKER_META = {
  VNDA: { name: 'Vanda Pharmaceuticals',     catalyst: 'PDUFA Jun 20 (tradipitant)',               type: 'PDUFA'    },
  SRRK: { name: 'Scholar Rock',              catalyst: 'PDUFA Jun 20 (apitegromab, SMA)',           type: 'PDUFA'    },
  TNXP: { name: 'Tonix Pharmaceuticals',     catalyst: 'PDUFA Jun 26 (TNX-102 SL)',                type: 'PDUFA'    },
  LQDA: { name: 'Liquidia Corp',             catalyst: 'PDUFA Jun 27 (LIQ861)',                    type: 'PDUFA'    },
  CSTL: { name: 'Castle Biosciences',        catalyst: 'Post-ASCO momentum (oncology dx)',          type: 'ASCO'     },
  FATE: { name: 'Fate Therapeutics',         catalyst: 'Post-ASCO momentum (cell therapy)',         type: 'ASCO'     },
  CELZ: { name: 'Celldex Therapeutics',      catalyst: 'Post-ASCO momentum (immunotherapy)',        type: 'ASCO'     },
  SLAS: { name: 'Sellas Life Sciences',      catalyst: 'Post-ASCO momentum (cancer vaccines)',      type: 'ASCO'     },
  RCUS: { name: 'Arcus Biosciences',         catalyst: 'Post-ASCO momentum (immunotherapy)',        type: 'ASCO'     },
  CBRL: { name: 'Caribou Biosciences',       catalyst: 'Post-ASCO momentum (CRISPR cell therapy)',  type: 'ASCO'     },
  BCRX: { name: 'BioCryst Pharmaceuticals',  catalyst: 'Phase 3 ALPHA-ORBIT enrollment (Jun)',     type: 'Trial'    },
  ADMA: { name: 'ADMA Biologics',            catalyst: 'Pre-IND FDA submission 2026 (SG-001)',      type: 'Pipeline' },
  AKBA: { name: 'Akebia Therapeutics',       catalyst: 'Renal disease, oversold setup',             type: 'Pipeline' },
  CRSP: { name: 'CRISPR Therapeutics',       catalyst: 'Active pipeline readouts',                  type: 'Pipeline' },
  BNGO: { name: 'Bionano Genomics',          catalyst: 'Genomics data updates',                     type: 'Pipeline' },
  SAVA: { name: 'Cassava Sciences',          catalyst: "Alzheimer's trial, high volatility",        type: 'Trial'    },
  MREO: { name: 'Mereo BioPharma',           catalyst: 'Rare disease pipeline update',              type: 'Pipeline' },
  KURA: { name: 'Kura Oncology',             catalyst: 'Pre-PDUFA buildup (Oct 22)',                type: 'PDUFA'    },
  CAPR: { name: 'Capricor Therapeutics',     catalyst: 'Pre-PDUFA buildup (Sep 8)',                 type: 'PDUFA'    },
  PULM: { name: 'Pulmatrix',                 catalyst: 'Respiratory pipeline',                      type: 'Pipeline' },
};

const BIOTECH_TICKERS = Object.keys(TICKER_META);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICKER_STAGGER_MS   = 200;     // small stagger between Finnhub calls
const WARMUP_MINUTES      = 20;
const ROLLING_WINDOW_MINS = 30;
const VOLUME_SPIKE_MULT   = 5;
const PRICE_CHANGE_PCT    = 5;
const PRICE_LOOKBACK_MINS = 15;
const SPIKE_LOOKBACK_MINS = 10;

const STATE_KEY  = 'screener_state';
const MAX_ALERTS = 50;

// ---------------------------------------------------------------------------
// Time helpers (timezone-aware, ET)
// ---------------------------------------------------------------------------

function isPremarketHours() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const total = et.getHours() * 60 + et.getMinutes();
  return total >= 4 * 60 && total < 9 * 60 + 30;
}

function getMinuteBucket() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function bucketToMins(bucket) {
  const [h, m] = bucket.split(':').map(Number);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// State persistence (Workers KV)
//
// One JSON blob holds everything. Per-ticker minuteVolumes is stored as a
// plain object (not a Map) so it round-trips through JSON cleanly.
// ---------------------------------------------------------------------------

function freshState() {
  const tickers = {};
  for (const ticker of BIOTECH_TICKERS) {
    tickers[ticker] = {
      prices:        [],     // [{ bucket, price }]
      minuteVolumes: {},     // { "HH:MM": volume }
      lastVolume:    0,
      startTime:     null,   // epoch ms of first data point
      currentPrice:  null,
      prevClose:     null,
      dayChangePct:  null,
      volumeRatio:   null,
      warmupDone:    false,
      lastUpdated:   null,
      alertFired:    false,
    };
  }
  return { tickers, recentAlerts: [] };
}

async function loadState(env) {
  // KV binding missing → backend not finished being set up
  if (!env.STATE) {
    const e = new Error('KV namespace "STATE" is not bound to this Worker');
    e.code = 'NO_KV';
    throw e;
  }
  const raw = await env.STATE.get(STATE_KEY);
  if (!raw) return freshState();
  try {
    const parsed = JSON.parse(raw);
    // Backfill any newly-added tickers
    for (const ticker of BIOTECH_TICKERS) {
      if (!parsed.tickers[ticker]) parsed.tickers[ticker] = freshState().tickers[ticker];
    }
    if (!parsed.recentAlerts) parsed.recentAlerts = [];
    return parsed;
  } catch {
    return freshState();
  }
}

async function saveState(env, state) {
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Worker entry points
// ---------------------------------------------------------------------------

export default {
  // HTTP — serves the API and the static dashboard
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/stocks') {
      let state;
      try {
        state = await loadState(env);
      } catch (e) {
        return setupResponse(e);
      }
      const payload = BIOTECH_TICKERS.map((ticker) => {
        const s    = state.tickers[ticker];
        const meta = TICKER_META[ticker];
        return {
          ticker,
          name:         meta.name,
          catalyst:     meta.catalyst,
          catalystType: meta.type,
          currentPrice: s.currentPrice,
          prevClose:    s.prevClose,
          dayChangePct: s.dayChangePct !== null ? +s.dayChangePct.toFixed(2) : null,
          volumeRatio:  s.volumeRatio  !== null ? +s.volumeRatio.toFixed(2)  : null,
          warmupDone:   s.warmupDone,
          alertFired:   s.alertFired,
          lastUpdated:  s.lastUpdated,
        };
      });
      return jsonResponse({
        stocks: payload,
        premarket: isPremarketHours(),
        configured: !!env.FINNHUB_API_KEY,
        serverTime: new Date().toISOString(),
      });
    }

    if (url.pathname === '/api/alerts') {
      let state;
      try {
        state = await loadState(env);
      } catch (e) {
        return setupResponse(e);
      }
      return jsonResponse({ alerts: state.recentAlerts });
    }

    return env.ASSETS.fetch(request);
  },

  // Cron — fires every minute, polls Finnhub, updates KV state
  async scheduled(event, env, ctx) {
    if (!isPremarketHours()) return;
    const state = await loadState(env);
    for (let i = 0; i < BIOTECH_TICKERS.length; i++) {
      if (i > 0) await sleep(TICKER_STAGGER_MS);
      try {
        await checkStock(BIOTECH_TICKERS[i], state, env);
      } catch (e) {
        console.error(`${BIOTECH_TICKERS[i]}: ${e.message}`);
      }
    }
    await saveState(env, state);
  },
};

// ---------------------------------------------------------------------------
// Core screening logic
// ---------------------------------------------------------------------------

async function checkStock(ticker, state, env) {
  const quote = await getQuote(ticker, env);
  if (!quote || quote.c <= 0) return;

  const s = state.tickers[ticker];
  const bucket = getMinuteBucket();
  const currentMins = bucketToMins(bucket);

  // UI-facing fields
  s.currentPrice = quote.c;
  s.lastUpdated  = new Date().toISOString();
  if (quote.pc && quote.pc > 0) {
    s.prevClose    = quote.pc;
    s.dayChangePct = ((quote.c - quote.pc) / quote.pc) * 100;
  }

  // Start warmup timer on first data point
  if (!s.startTime) s.startTime = Date.now();

  // Price history (trimmed to max lookback)
  s.prices.push({ bucket, price: quote.c });
  const maxLookback = Math.max(PRICE_LOOKBACK_MINS, SPIKE_LOOKBACK_MINS) + 5;
  s.prices = s.prices.filter((p) => currentMins - bucketToMins(p.bucket) <= maxLookback);

  // Per-minute volume accumulation (delta from cumulative Finnhub volume)
  if (s.lastVolume > 0 && quote.v > s.lastVolume) {
    const delta = quote.v - s.lastVolume;
    s.minuteVolumes[bucket] = (s.minuteVolumes[bucket] || 0) + delta;
  }
  s.lastVolume = quote.v;

  // Prune old volume buckets
  const trimThreshold = currentMins - (ROLLING_WINDOW_MINS + 5);
  for (const b of Object.keys(s.minuteVolumes)) {
    if (bucketToMins(b) < trimThreshold) delete s.minuteVolumes[b];
  }

  // Warmup gate
  if (Date.now() - s.startTime < WARMUP_MINUTES * 60_000) return;
  s.warmupDone = true;

  // Volume spike check
  const currentBucketVol = s.minuteVolumes[bucket] || 0;
  const rollingAvg = rolling30MinAvg(s, bucket);
  if (rollingAvg === 0) return;

  const volumeRatio = currentBucketVol / rollingAvg;
  s.volumeRatio = volumeRatio;
  if (volumeRatio < VOLUME_SPIKE_MULT) return;

  // Price increase checks
  const px = quote.c;

  const ref15 = s.prices.find((p) => currentMins - bucketToMins(p.bucket) >= PRICE_LOOKBACK_MINS);
  if (!ref15) return;
  const chg15 = ((px - ref15.price) / ref15.price) * 100;
  if (chg15 <= PRICE_CHANGE_PCT) return;

  const ref10 = s.prices.find((p) => currentMins - bucketToMins(p.bucket) >= SPIKE_LOOKBACK_MINS);
  if (!ref10) return;
  const chg10 = ((px - ref10.price) / ref10.price) * 100;
  if (chg10 <= PRICE_CHANGE_PCT) return;

  // Fire alert
  s.alertFired = true;
  console.log(
    `ALERT ${ticker} | $${px.toFixed(2)} | +${chg15.toFixed(1)}% (15m) | ` +
    `+${chg10.toFixed(1)}% (10m) | ${volumeRatio.toFixed(1)}x vol`
  );
  state.recentAlerts.unshift({
    ticker, price: px, pctChange15: chg15, pctChange10: chg10,
    volumeRatio, timestamp: new Date().toISOString(),
  });
  if (state.recentAlerts.length > MAX_ALERTS) state.recentAlerts.pop();
}

function rolling30MinAvg(s, currentBucket) {
  const entries = [];
  for (const [b, vol] of Object.entries(s.minuteVolumes)) {
    if (b !== currentBucket) entries.push(vol);
  }
  if (!entries.length) return 0;
  const window = entries.slice(-ROLLING_WINDOW_MINS);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

async function getQuote(ticker, env) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${env.FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (typeof data.c === 'number' && typeof data.v === 'number') {
    return { c: data.c, v: data.v, pc: data.pc || null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// Returned when the backend isn't fully set up yet (e.g. KV not bound).
// 200 so the dashboard can show a friendly message instead of "Connection error".
function setupResponse(err) {
  return jsonResponse({
    setupRequired: true,
    reason: err && err.code === 'NO_KV'
      ? 'The "STATE" KV namespace is not bound to this Worker.'
      : 'Backend not configured yet.',
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
