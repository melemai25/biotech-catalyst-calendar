#!/usr/bin/env node
/**
 * FRED (Federal Reserve Economic Data) client.
 *
 * FRED is the spine of the macro page because it is the only free source that
 * gives you BOTH halves of the problem from one place:
 *
 *   1. The forward release calendar  -> /fred/releases/dates
 *      with include_release_dates_with_no_data=true, which is the switch that
 *      turns the endpoint from "history" into "schedule". Without it, FRED
 *      deliberately omits future dates because they have no data attached.
 *
 *   2. The actual numbers            -> /fred/series/observations
 *
 * Requires a free API key. One minute to get, no payment details:
 *   https://fredaccount.stlouisfed.org/apikeys
 *
 * Set it once:
 *   Windows    : setx FRED_API_KEY "your32charkey"
 *   macOS/Linux: export FRED_API_KEY="your32charkey"
 * or put it in data/config.json as { "fredApiKey": "..." }.
 *
 * Rate limit: FRED allows 120 requests/minute per key. We target ~100/min.
 * The whole macro build is about 35 requests, so this is never the bottleneck.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://api.stlouisfed.org/fred';

// 120/min is the documented ceiling. 600ms gap = 100/min, leaving headroom.
const REQUEST_GAP_MS = 600;
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves the API key from env, then config.json. Returns null when absent so
 * callers can degrade gracefully instead of crashing the whole build — the
 * macro page simply does not render, the biotech calendar is unaffected.
 */
function getApiKey() {
  if (process.env.FRED_API_KEY) {
    const k = process.env.FRED_API_KEY.trim();
    if (looksLikeKey(k)) return k;
  }
  const cfgPath = path.join(ROOT, 'data', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const k = String(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).fredApiKey || '').trim();
      if (looksLikeKey(k)) return k;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * FRED keys are exactly 32 lowercase alphanumerics. Checking the shape locally
 * turns a confusing 400 from the API into a clear message before any request,
 * and rejects the config placeholder for free.
 */
function looksLikeKey(k) {
  return typeof k === 'string' && /^[a-z0-9]{32}$/.test(k);
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  return p.toString();
}

/** Strips the key out of a URL before it can reach a log or an error message. */
function redact(url) {
  return url.replace(/api_key=[a-z0-9]+/i, 'api_key=***');
}

async function fredFetch(endpoint, params, apiKey) {
  const url = `${BASE}${endpoint}?${qs({ ...params, api_key: apiKey, file_type: 'json' })}`;
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      lastErr = e;
      await sleep(700 * (attempt + 1));
      continue;
    }

    // 400 is FRED's catch-all for a bad key as well as a bad parameter, so the
    // message has to cover both without leaking the key itself.
    if (res.status === 400) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body.error_message || '';
      } catch { /* no body */ }
      throw new Error(
        `HTTP 400 from ${redact(url)}` +
        (detail ? ` - ${detail}` : '') +
        '. Usually an invalid API key or an unknown series id.'
      );
    }
    if (res.status === 429) {
      // Over 120/min. Back off hard; the limit is per minute, not per second.
      lastErr = new Error('HTTP 429 - FRED rate limit (120 req/min)');
      await sleep(20000);
      continue;
    }
    if (res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${redact(url)}`);

    await sleep(REQUEST_GAP_MS);
    return res.json();
  }
  throw lastErr || new Error('FRED request failed');
}

/* ------------------------------------------------------------------ *
 * Observations
 * ------------------------------------------------------------------ */

/**
 * Raw observations for one series, oldest first.
 *
 * We deliberately fetch units=lin (untransformed levels) rather than asking
 * FRED for pc1/pch. One request then yields every transform we need plus the
 * history for a sparkline, instead of one request per transform.
 *
 * FRED writes a missing observation as the string "." — not null, not 0. Those
 * become null here so arithmetic downstream cannot silently treat them as zero.
 */
async function fetchSeries(seriesId, apiKey, { start = null, limit = 400 } = {}) {
  const data = await fredFetch('/series/observations', {
    series_id: seriesId,
    observation_start: start,
    sort_order: 'desc',   // newest first, so `limit` keeps the RECENT tail
    limit,
  }, apiKey);

  const obs = (data.observations || [])
    .map((o) => ({
      date: o.date,
      value: o.value === '.' || o.value === '' ? null : Number(o.value),
    }))
    .filter((o) => o.date)
    .reverse();                            // back to oldest-first for transforms

  return obs;
}

/** Series metadata: title, units, frequency, and when FRED last updated it. */
async function fetchSeriesMeta(seriesId, apiKey) {
  const data = await fredFetch('/series', { series_id: seriesId }, apiKey);
  const s = (data.seriess || [])[0];
  if (!s) return null;
  return {
    id: s.id,
    title: s.title,
    units: s.units_short || s.units,
    frequency: s.frequency_short || s.frequency,
    lastUpdated: s.last_updated,
    seasonalAdjustment: s.seasonal_adjustment_short,
  };
}

/* ------------------------------------------------------------------ *
 * Release calendar
 * ------------------------------------------------------------------ */

/** Every release FRED tracks: { id, name }. One request, ~300 rows. */
async function fetchReleases(apiKey) {
  const data = await fredFetch('/releases', { limit: 1000 }, apiKey);
  return (data.releases || []).map((r) => ({
    id: r.id,
    name: r.name,
    url: r.link || null,
  }));
}

/**
 * Forward release dates for a SET of releases, one request each.
 *
 * include_release_dates_with_no_data=true is the whole trick: FRED's default
 * excludes dates with no data attached, which is exactly what every future
 * date is. Without the flag this endpoint can only ever look backwards.
 *
 * Why per-release rather than one call to /releases/dates: that endpoint asks
 * FRED to assemble the forward calendar for all ~300 releases it tracks, and
 * with the no-data flag set that is a big enough query to time out (504). We
 * only ever want about fourteen of those releases, so asking for them by id is
 * both far cheaper for FRED and far more reliable — fourteen small requests
 * that each either succeed or fail on their own, instead of one that takes the
 * whole calendar down with it.
 *
 * A failure on one release costs that release, not the calendar. Returns
 * { dates: [{ releaseId, date }], failed: [{ releaseId, error }] }.
 */
async function fetchReleaseDatesFor(releaseIds, apiKey, { from, to }) {
  const dates = [];
  const failed = [];

  for (const id of releaseIds) {
    try {
      const data = await fredFetch('/release/dates', {
        release_id: id,
        realtime_start: from,
        realtime_end: to,
        include_release_dates_with_no_data: 'true',
        sort_order: 'asc',
        limit: 10000,          // the single-release endpoint does allow 10000
      }, apiKey);

      for (const d of (data.release_dates || [])) {
        dates.push({ releaseId: d.release_id ?? id, date: d.date });
      }
    } catch (e) {
      failed.push({ releaseId: id, error: e.message });
    }
  }

  dates.sort((a, b) => a.date.localeCompare(b.date));
  return { dates, failed };
}

module.exports = {
  getApiKey,
  looksLikeKey,
  fetchSeries,
  fetchSeriesMeta,
  fetchReleases,
  fetchReleaseDatesFor,
  // exported for testing
  redact,
  BASE,
};
