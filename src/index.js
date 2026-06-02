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

const POLL_INTERVAL_MS    = 30_000;
const TICKER_STAGGER_MS   = 500;
const WARMUP_MINUTES      = 20;
const ROLLING_WINDOW_MINS = 30;
const VOLUME_SPIKE_MULT   = 5;
const PRICE_CHANGE_PCT    = 5;
const PRICE_LOOKBACK_MINS = 15;
const SPIKE_LOOKBACK_MINS = 10;

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
// Worker entry point — routes /api/* to the Durable Object, rest to assets
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.SCREENER.get(env.SCREENER.idFromName('global'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------
// Durable Object — holds all screener state, runs alarm every 30 s
// ---------------------------------------------------------------------------

export class ScreenerDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
    this.stockData    = null;
    this.recentAlerts = [];
  }

  // Lazy-init stockData (survives across requests within the same DO instance,
  // but resets on cold-start — fine since we need warmup anyway).
  _initStockData() {
    if (this.stockData) return;
    this.stockData = {};
    for (const ticker of BIOTECH_TICKERS) {
      this.stockData[ticker] = {
        prices:        [],
        minuteVolumes: new Map(),
        lastVolume:    0,
        startTime:     null,
        // UI fields
        currentPrice:  null,
        prevClose:     null,
        dayChangePct:  null,
        volumeRatio:   null,
        warmupDone:    false,
        lastUpdated:   null,
        alertFired:    false,
      };
    }
  }

  // ── HTTP handler ──────────────────────────────────────────────────────────

  async fetch(request) {
    this._initStockData();

    // Ensure the polling alarm is always scheduled
    const current = await this.state.storage.getAlarm();
    if (!current) {
      await this.state.storage.setAlarm(Date.now() + 1_000);
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/stocks') {
      const payload = BIOTECH_TICKERS.map((ticker) => {
        const s    = this.stockData[ticker];
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
        serverTime: new Date().toISOString(),
      });
    }

    if (url.pathname === '/api/alerts') {
      return jsonResponse({ alerts: this.recentAlerts });
    }

    return new Response('Not found', { status: 404 });
  }

  // ── Alarm — fires every 30 s ──────────────────────────────────────────────

  async alarm() {
    this._initStockData();
    try {
      if (isPremarketHours()) {
        await this._runScreener();
      }
    } finally {
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  async _runScreener() {
    for (let i = 0; i < BIOTECH_TICKERS.length; i++) {
      if (i > 0) await sleep(TICKER_STAGGER_MS);
      try {
        await this._checkStock(BIOTECH_TICKERS[i]);
      } catch (e) {
        console.error(`${BIOTECH_TICKERS[i]}: ${e.message}`);
      }
    }
  }

  // ── Per-ticker core logic ─────────────────────────────────────────────────

  async _checkStock(ticker) {
    const quote = await this._getQuote(ticker);
    if (!quote || quote.c <= 0) return;

    const state  = this.stockData[ticker];
    const bucket = getMinuteBucket();
    const currentMins = bucketToMins(bucket);

    // Update UI-facing fields
    state.currentPrice = quote.c;
    state.lastUpdated  = new Date().toISOString();
    if (quote.pc && quote.pc > 0) {
      state.prevClose   = quote.pc;
      state.dayChangePct = ((quote.c - quote.pc) / quote.pc) * 100;
    }

    // Start warmup timer on first data point
    if (!state.startTime) state.startTime = Date.now();

    // Price history (ring-buffer, trimmed to max lookback)
    state.prices.push({ bucket, price: quote.c });
    const maxLookback = Math.max(PRICE_LOOKBACK_MINS, SPIKE_LOOKBACK_MINS) + 5;
    state.prices = state.prices.filter(
      (p) => currentMins - bucketToMins(p.bucket) <= maxLookback
    );

    // Per-minute volume accumulation (delta from cumulative Finnhub volume)
    if (state.lastVolume > 0 && quote.v > state.lastVolume) {
      const delta = quote.v - state.lastVolume;
      state.minuteVolumes.set(bucket, (state.minuteVolumes.get(bucket) || 0) + delta);
    }
    state.lastVolume = quote.v;

    // Prune old volume buckets
    const trimThreshold = currentMins - (ROLLING_WINDOW_MINS + 5);
    for (const [b] of state.minuteVolumes.entries()) {
      if (bucketToMins(b) < trimThreshold) state.minuteVolumes.delete(b);
    }

    // Warmup gate
    if (Date.now() - state.startTime < WARMUP_MINUTES * 60_000) return;
    state.warmupDone = true;

    // Volume spike check
    const currentBucketVol = state.minuteVolumes.get(bucket) || 0;
    const rollingAvg = this._rolling30MinAvg(ticker);
    if (rollingAvg === 0) return;

    const volumeRatio = currentBucketVol / rollingAvg;
    state.volumeRatio = volumeRatio;
    if (volumeRatio < VOLUME_SPIKE_MULT) return;

    // Price increase checks
    const px = quote.c;

    const ref15 = state.prices.find((p) => currentMins - bucketToMins(p.bucket) >= PRICE_LOOKBACK_MINS);
    if (!ref15) return;
    const chg15 = ((px - ref15.price) / ref15.price) * 100;
    if (chg15 <= PRICE_CHANGE_PCT) return;

    const ref10 = state.prices.find((p) => currentMins - bucketToMins(p.bucket) >= SPIKE_LOOKBACK_MINS);
    if (!ref10) return;
    const chg10 = ((px - ref10.price) / ref10.price) * 100;
    if (chg10 <= PRICE_CHANGE_PCT) return;

    // Fire alert
    state.alertFired = true;
    console.log(
      `ALERT ${ticker} | $${px.toFixed(2)} | +${chg15.toFixed(1)}% (15m) | ` +
      `+${chg10.toFixed(1)}% (10m) | ${volumeRatio.toFixed(1)}x vol`
    );
    this.recentAlerts.unshift({
      ticker, price: px, pctChange15: chg15, pctChange10: chg10,
      volumeRatio, timestamp: new Date().toISOString(),
    });
    if (this.recentAlerts.length > 50) this.recentAlerts.pop();
  }

  _rolling30MinAvg(ticker) {
    const state  = this.stockData[ticker];
    const bucket = getMinuteBucket();
    const entries = [];
    for (const [b, vol] of state.minuteVolumes.entries()) {
      if (b !== bucket) entries.push(vol);
    }
    if (!entries.length) return 0;
    const window = entries.slice(-ROLLING_WINDOW_MINS);
    return window.reduce((a, b) => a + b, 0) / window.length;
  }

  async _getQuote(ticker) {
    const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${this.env.FINNHUB_API_KEY}`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.c === 'number' && typeof data.v === 'number') {
      return { c: data.c, v: data.v, pc: data.pc || null };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
