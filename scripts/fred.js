#!/usr/bin/env node
/*
 * FRED client: release calendar (/fred/releases/dates) + numbers (/fred/series/observations).
 * Needs a free key: https://fredaccount.stlouisfed.org/apikeys
 *   setx FRED_API_KEY "your32charkey"   or data/config.json { "fredApiKey": "..." }
 * Limit is 120 req/min, the whole macro build is ~35 requests.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://api.stlouisfed.org/fred';

// ~100/min
const REQUEST_GAP_MS = 600;
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// env, then config.json. null = macro page just doesn't render
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
    } catch { }
  }
  return null;
}

// keys are 32 lowercase alphanumerics, check before calling the api
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

// keep the key out of logs/errors
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

    // FRED returns 400 for a bad key or a bad param
    if (res.status === 400) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body.error_message || '';
      } catch { }
      throw new Error(
        `HTTP 400 from ${redact(url)}` +
        (detail ? ` - ${detail}` : '') +
        '. Usually an invalid API key or an unknown series id.'
      );
    }
    if (res.status === 429) {
      // rate limited, back off
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

/* observations */

// observations, oldest first. fetch raw levels (units=lin) and do yoy/mom ourselves.
// FRED uses '.' for missing values, convert to null so it's not treated as 0
async function fetchSeries(seriesId, apiKey, { start = null, limit = 400 } = {}) {
  const data = await fredFetch('/series/observations', {
    series_id: seriesId,
    observation_start: start,
    sort_order: 'desc',   // newest first so limit keeps the recent end
    limit,
  }, apiKey);

  const obs = (data.observations || [])
    .map((o) => ({
      date: o.date,
      value: o.value === '.' || o.value === '' ? null : Number(o.value),
    }))
    .filter((o) => o.date)
    .reverse();

  return obs;
}

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

/* release calendar */

// all releases, ~300
async function fetchReleases(apiKey) {
  const data = await fredFetch('/releases', { limit: 1000 }, apiKey);
  return (data.releases || []).map((r) => ({
    id: r.id,
    name: r.name,
    url: r.link || null,
  }));
}

// future release dates, one request per release.
// include_release_dates_with_no_data=true is needed or you only get past dates.
// the all-releases endpoint times out (504) with that flag, so ask per release.
// returns { dates, failed }
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
        limit: 10000,
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
  redact,
  BASE,
};
